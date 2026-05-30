import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';
import { makeJobRepo, type JobRepo } from '@/src/lib/db/repos/job';
import { makeSettingRepo, type SettingRepo } from '@/src/lib/db/repos/setting';
import { makeTrashRepo, type TrashRepo } from '@/src/lib/db/repos/trash';
import {
  __forTests_resetOrchestrator,
  __forTests_setDeps,
  cancelJob,
  invalidateOrchestratorDetectionCache,
  loopOnce,
  startEncoderLoop,
  stopEncoderLoop,
} from '@/src/lib/encode/orchestrator';
import { __forTests_resetCachePoolCooldowns } from '@/src/lib/encode/staging';
import type { EncodeOptions, EncodeResult } from '@/src/lib/encode/ffmpeg';
import type { ProbeResult } from '@/src/lib/scan/ffprobe';

type Db = InstanceType<typeof Database>;

let db: Db;
let fileRepo: FileRepo;
let jobRepo: JobRepo;
let settingRepo: SettingRepo;
let trashRepo: TrashRepo;
let stageRoot: string;
let mediaRoot: string;
let logSpy: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.fn>;
let debugSpy: ReturnType<typeof vi.fn>;

const NOW_SECONDS = 1_800_000_000; // fixed clock for deterministic tests

function seedFile(p: string, sizeBytes = 1_000_000): { id: number; path: string } {
  const row = fileRepo.upsertByPath({
    path: p,
    size_bytes: sizeBytes,
    mtime: 1_700_000_000,
    content_hash: 'a'.repeat(64),
    codec: 'h264',
    bitrate: 5_000_000,
    duration_seconds: 60,
    width: 1920,
    height: 1080,
    container: 'mp4',
    last_scanned_at: 1_700_000_500,

    share_id: null,
  });
  return { id: row.id, path: row.path };
}

function makeMockEncodeResult(over: Partial<EncodeResult> = {}): EncodeResult {
  return { exitCode: 0, durationMs: 30_000, logTail: '', ...over };
}

function makeMockProbe(): ProbeResult {
  return {
    codec: 'hevc',
    bitrate: 2_000_000,
    durationSeconds: 60,
    width: 1920,
    height: 1080,
    container: 'matroska',
    tags: {},
  };
}

// Helper that wires the in-memory DB + tmpdir + sensible default deps. Each
// individual test can override pieces via __forTests_setDeps.
function setupOrchestrator({
  sourceSize = 1_000_000,
  outputSize,
  freeBytesAvailable = 100_000_000,
  finalOutputExists = false,
  runEncode,
  ffprobeImpl,
  statSyncImpl,
}: {
  sourceSize?: number;
  outputSize?: number;
  freeBytesAvailable?: number;
  finalOutputExists?: boolean;
  runEncode?: (opts: EncodeOptions) => Promise<EncodeResult>;
  ffprobeImpl?: () => Promise<ProbeResult | null>;
  statSyncImpl?: typeof fs.statSync;
} = {}): { fileId: number; jobId: number; sourcePath: string } {
  // audit-added S7: reset module state on every test before any other setup.
  // Post-05-12 CI hardening: reset is now async (drains pending dispatches);
  // hoisted to beforeEach so setupOrchestrator can stay synchronous + keep all
  // callers' destructuring pattern unchanged.

  const sourcePath = path.join(mediaRoot, 'movie.mp4');
  fs.writeFileSync(sourcePath, Buffer.alloc(sourceSize, 'x'));

  const file = seedFile(sourcePath, sourceSize);
  const job = jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: null });
  if (!job) throw new Error('failed to create job');

  // Override settings.cache_pool_path to our tmp stage root.
  settingRepo.set('cache_pool_path', stageRoot);
  settingRepo.set('default_crf', '23');
  settingRepo.set('min_savings_percent', '5');
  settingRepo.set('trash_retention_days', '30');

  const stagedOutputBytes = outputSize ?? Math.floor(sourceSize * 0.6);

  __forTests_setDeps({
    runEncode:
      runEncode ??
      (async ({ output }) => {
        // Write a fake stage output file so verify-statSync sees the right size.
        fs.writeFileSync(output, Buffer.alloc(stagedOutputBytes, 'y'));
        return makeMockEncodeResult();
      }),
    ffprobe: (ffprobeImpl ?? (async () => makeMockProbe())) as never,
    fs: {
      statSync: (statSyncImpl ?? fs.statSync) as never,
      statfsSync: (() =>
        ({ bavail: BigInt(freeBytesAvailable), bsize: BigInt(1) }) as never) as never,
      // 05-13 audit M2: accessSync W_OK pre-flight on source-path's parent dir.
      // Default tests use real-fs tmpdir paths → fs.accessSync passes (writable).
      accessSync: fs.accessSync,
      existsSync: ((p: fs.PathLike) => {
        const s = String(p);
        if (finalOutputExists && s === path.join(mediaRoot, 'movie-x265.mkv')) {
          return true;
        }
        return fs.existsSync(s);
      }) as never,
      unlinkSync: (() => undefined) as unknown as typeof fs.unlinkSync,
    },
    fileRepo: () => fileRepo,
    jobRepo: () => jobRepo,
    settingRepo: () => settingRepo,
    trashRepo: () => trashRepo,
    logger: {
      info: logSpy,
      warn: warnSpy,
      error: errorSpy,
      debug: debugSpy,
      // pino logger has more methods but we only invoke these four.
    } as never,
    now: () => NOW_SECONDS,
  });

  return { fileId: file.id, jobId: job.id, sourcePath };
}

beforeEach(async () => {
  // Post-05-12 CI hardening: reset orchestrator FIRST so any pending
  // dispatches from a prior test drain before we wire up the new DB +
  // mocks. Without this, an idle-poll callback that fired between tests can
  // still reference the previous DB connection (already closed) and create
  // orphan files in the previous test's stage dir.
  await __forTests_resetOrchestrator();
  __forTests_resetCachePoolCooldowns();
  db = new Database(':memory:');
  migrate(db);
  db.pragma('foreign_keys = ON');
  fileRepo = makeFileRepo(db);
  jobRepo = makeJobRepo(db, {
    setFileStatus: (id, status, expectedVersion) => fileRepo.setStatus(id, status, expectedVersion),
    bulkSetFileStatusToPending: (ids, expectedStates) =>
      fileRepo.bulkSetStatusToPendingByIds(ids, expectedStates),
  });
  settingRepo = makeSettingRepo(db);
  trashRepo = makeTrashRepo(db);
  stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-orch-stage-'));
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-orch-media-'));
  logSpy = vi.fn();
  warnSpy = vi.fn();
  errorSpy = vi.fn();
  debugSpy = vi.fn();
});

afterEach(async () => {
  await __forTests_resetOrchestrator();
  db.close();
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(mediaRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('orchestrator — claim guards', () => {
  it('test_loopOnce_when_no_queued_then_returns_without_error', async () => {
    await __forTests_resetOrchestrator();
    settingRepo.set('cache_pool_path', stageRoot);
    __forTests_setDeps({
      fileRepo: () => fileRepo,
      jobRepo: () => jobRepo,
      settingRepo: () => settingRepo,
      trashRepo: () => trashRepo,
      logger: { info: logSpy, warn: warnSpy, error: errorSpy, debug: debugSpy } as never,
      now: () => NOW_SECONDS,
    });
    await expect(loopOnce()).resolves.toBeUndefined();
  });
});

describe('orchestrator — happy path (done-smaller)', () => {
  it('test_loopOnce_when_happy_path_savings_high_then_done_smaller_full_state_machine_evidence', async () => {
    const { fileId, jobId, sourcePath } = setupOrchestrator({
      sourceSize: 1_000_000,
      outputSize: 600_000, // 60% of source → smaller
    });
    await loopOnce();

    const file = fileRepo.getById(fileId);
    expect(file?.status).toBe('done-smaller');
    expect(file?.version).toBe(2); // pending → encoding → done-smaller

    const job = db.prepare('SELECT * FROM job WHERE id = ?').get(jobId) as {
      status: string;
      bytes_in: number;
      bytes_out: number;
      duration_ms: number;
    };
    expect(job.status).toBe('done');
    expect(job.bytes_in).toBe(1_000_000);
    expect(job.bytes_out).toBe(600_000);
    expect(job.duration_ms).toBe(30_000);

    // Final output committed at expected location:
    const finalOut = path.join(mediaRoot, 'movie-x265.mkv');
    expect(fs.existsSync(finalOut)).toBe(true);
    // Original moved to trash:
    expect(fs.existsSync(sourcePath)).toBe(false);
    const trashEntries = db.prepare('SELECT * FROM trash_entry').all() as {
      trash_path: string;
      size_bytes: number;
    }[];
    expect(trashEntries).toHaveLength(1);
    expect(trashEntries[0].size_bytes).toBe(1_000_000);
    expect(fs.existsSync(trashEntries[0].trash_path)).toBe(true);

    // Stage cleaned up:
    expect(fs.existsSync(path.join(stageRoot, 'work', String(jobId)))).toBe(false);

    // Two job_transition logs (queued→encoding, encoding→done):
    const transitions = logSpy.mock.calls.filter((c) => c[0]?.action === 'job_transition');
    expect(transitions).toHaveLength(2);
    expect(transitions[0][0].transition).toBe('queued→encoding');
    expect(transitions[1][0].transition).toBe('encoding→done');
    expect(transitions[1][0].outcome).toBe('done-smaller');
  });
});

// 05-13: 3-bucket verdict — done-not-worth (savings < min) vs done-larger
// (output > source). Pre-05-13 these were lumped under done-larger; the M3
// audit splits them so skip-pipeline + Library forensics distinguish.
describe('orchestrator — 3-bucket verdict (05-13)', () => {
  it('test_loopOnce_when_savings_below_threshold_then_done_not_worth_no_commit_no_trash', async () => {
    const { fileId, sourcePath } = setupOrchestrator({
      sourceSize: 1_000_000,
      outputSize: 970_000, // 3% savings — below default minSavingsPercent=5
    });
    await loopOnce();

    const file = fileRepo.getById(fileId);
    expect(file?.status).toBe('done-not-worth');
    expect(fs.existsSync(sourcePath)).toBe(true); // original kept
    const finalOut = path.join(mediaRoot, 'movie-x265.mkv');
    expect(fs.existsSync(finalOut)).toBe(false); // output discarded
    const trashCount = (db.prepare('SELECT COUNT(*) AS c FROM trash_entry').get() as { c: number })
      .c;
    expect(trashCount).toBe(0);

    const transition = logSpy.mock.calls.find(
      (c) => c[0]?.action === 'job_transition' && c[0]?.transition === 'encoding→done',
    );
    expect(transition).toBeDefined();
    expect(transition?.[0].cause).toBe('savings_below_threshold');
    expect(transition?.[0].outcome).toBe('done-not-worth');
    expect(transition?.[0].verdict).toBe('done-not-worth');
  });

  it('test_loopOnce_when_output_strictly_larger_than_source_then_done_larger_no_commit_no_trash', async () => {
    const { fileId, sourcePath } = setupOrchestrator({
      sourceSize: 1_000_000,
      outputSize: 1_200_000, // output > source → genuine done-larger
    });
    await loopOnce();

    const file = fileRepo.getById(fileId);
    expect(file?.status).toBe('done-larger');
    expect(fs.existsSync(sourcePath)).toBe(true); // original kept
    const finalOut = path.join(mediaRoot, 'movie-x265.mkv');
    expect(fs.existsSync(finalOut)).toBe(false); // output discarded
    const trashCount = (db.prepare('SELECT COUNT(*) AS c FROM trash_entry').get() as { c: number })
      .c;
    expect(trashCount).toBe(0);

    const transition = logSpy.mock.calls.find(
      (c) => c[0]?.action === 'job_transition' && c[0]?.transition === 'encoding→done',
    );
    expect(transition).toBeDefined();
    expect(transition?.[0].cause).toBe('output_larger_than_source');
    expect(transition?.[0].outcome).toBe('done-larger');
    expect(transition?.[0].verdict).toBe('done-larger');
  });

  it('test_loopOnce_when_savings_at_threshold_exactly_then_done_smaller_KEEP', async () => {
    const { fileId, sourcePath } = setupOrchestrator({
      sourceSize: 1_000_000,
      outputSize: 950_000, // exactly 5% savings — at threshold → done-smaller
    });
    await loopOnce();

    const file = fileRepo.getById(fileId);
    expect(file?.status).toBe('done-smaller');
    // KEEP path: original trashed, output committed
    expect(fs.existsSync(sourcePath)).toBe(false);
    const finalOut = path.join(mediaRoot, 'movie-x265.mkv');
    expect(fs.existsSync(finalOut)).toBe(true);
  });

  it('test_loopOnce_when_savings_just_above_threshold_then_done_smaller_KEEP', async () => {
    const { fileId } = setupOrchestrator({
      sourceSize: 1_000_000,
      outputSize: 940_000, // 6% savings — above default 5% → done-smaller
    });
    await loopOnce();
    const file = fileRepo.getById(fileId);
    expect(file?.status).toBe('done-smaller');
  });

  it('test_loopOnce_when_savings_just_below_threshold_then_done_not_worth_DISCARD', async () => {
    const { fileId } = setupOrchestrator({
      sourceSize: 1_000_000,
      outputSize: 951_000, // 4.9% savings — just below default 5% → done-not-worth
    });
    await loopOnce();
    const file = fileRepo.getById(fileId);
    expect(file?.status).toBe('done-not-worth');
  });
});

describe('orchestrator — failure paths', () => {
  it('test_loopOnce_when_runEncode_exits_nonzero_then_failed_with_log_tail', async () => {
    const { fileId, sourcePath } = setupOrchestrator({
      runEncode: async () => makeMockEncodeResult({ exitCode: 1, logTail: 'Invalid data' }),
    });
    await loopOnce();
    const file = fileRepo.getById(fileId);
    expect(file?.status).toBe('failed');
    expect(fs.existsSync(sourcePath)).toBe(true); // original NOT trashed
    const job = db.prepare('SELECT * FROM job').get() as {
      status: string;
      exit_code: number;
      log_tail: string;
    };
    expect(job.status).toBe('failed');
    expect(job.exit_code).toBe(1);
    expect(job.log_tail).toContain('Invalid data');
  });

  it('test_loopOnce_when_runEncode_throws_AbortError_then_cancelled_with_setStatus_interrupted', async () => {
    const { fileId } = setupOrchestrator({
      runEncode: async () => {
        const e = Object.assign(new Error('aborted'), { name: 'AbortError' });
        throw e;
      },
    });
    await loopOnce();
    const file = fileRepo.getById(fileId);
    expect(file?.status).toBe('interrupted');
    const job = db.prepare('SELECT status FROM job').get() as { status: string };
    expect(job.status).toBe('cancelled');
  });

  it('test_loopOnce_when_ffprobe_returns_null_then_failed_with_output_unplayable', async () => {
    const { fileId } = setupOrchestrator({
      ffprobeImpl: async () => null,
    });
    await loopOnce();
    expect(fileRepo.getById(fileId)?.status).toBe('failed');
    const job = db.prepare('SELECT error_msg FROM job').get() as { error_msg: string };
    expect(job.error_msg).toBe('output_unplayable');
  });

  it('test_loopOnce_when_setStatus_returns_false_then_markCancelled_with_file_version_conflict', async () => {
    const { jobId } = setupOrchestrator();
    // Override fileRepo with one whose setStatus always returns false (race
    // simulation). getById returns the real row; only setStatus is overridden.
    const realFileRepo = fileRepo;
    const racingFileRepo: FileRepo = {
      ...realFileRepo,
      setStatus: () => false,
    };
    __forTests_setDeps({ fileRepo: () => racingFileRepo });

    await loopOnce();

    const job = db.prepare('SELECT status FROM job WHERE id = ?').get(jobId) as { status: string };
    expect(job.status).toBe('cancelled');

    const warns = warnSpy.mock.calls.filter((c) => c[0]?.cause === 'file_version_conflict');
    expect(warns).toHaveLength(1);
  });
});

describe('orchestrator — audit-added pre-flight guards', () => {
  it('test_loopOnce_when_cache_pool_full_then_failed_cache_pool_full', async () => {
    const { fileId } = setupOrchestrator({
      sourceSize: 100_000_000,
      freeBytesAvailable: 100_000, // way below 1.5× source
    });
    await loopOnce();
    expect(fileRepo.getById(fileId)?.status).toBe('pending');
    const job = db.prepare('SELECT error_msg FROM job').get() as { error_msg: string };
    expect(job.error_msg).toBe('cache_pool_full');
    const warns = warnSpy.mock.calls.filter((c) => c[0]?.action === 'cache_pool_full');
    expect(warns).toHaveLength(1);
  });

  it('test_loopOnce_when_source_vanished_pre_stage_then_failed_source_vanished', async () => {
    const enoent = (): never => {
      const e = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw e;
    };
    const { fileId } = setupOrchestrator({
      statSyncImpl: enoent as never,
    });
    await loopOnce();
    expect(fileRepo.getById(fileId)?.status).toBe('failed');
    const job = db.prepare('SELECT error_msg FROM job').get() as { error_msg: string };
    expect(job.error_msg).toBe('source_vanished');
  });

  it('test_loopOnce_when_outputPath_exists_pre_encode_then_failed_output_path_exists', async () => {
    const { fileId } = setupOrchestrator({
      finalOutputExists: true,
    });
    await loopOnce();
    expect(fileRepo.getById(fileId)?.status).toBe('failed');
    const job = db.prepare('SELECT error_msg FROM job').get() as { error_msg: string };
    expect(job.error_msg).toBe('output_path_exists');
  });

  it('test_loopOnce_when_cache_pool_path_invalid_then_failed_invalid_cache_pool_path', async () => {
    setupOrchestrator();
    settingRepo.set('cache_pool_path', 'relative/path');
    await loopOnce();
    const job = db.prepare('SELECT error_msg FROM job').get() as { error_msg: string };
    expect(job.error_msg).toMatch(/^invalid_cache_pool_path:/);
  });
});

describe('orchestrator — startEncoderLoop + recoverStaleEncoding (audit M4)', () => {
  it('test_startEncoderLoop_when_stale_encoding_jobs_present_then_recovers_both_job_and_file_status', async () => {
    await __forTests_resetOrchestrator();
    settingRepo.set('cache_pool_path', stageRoot);

    // Seed: 1 file in 'encoding' (orchestrator died), 1 stale job
    const file = fileRepo.upsertByPath({
      path: '/m/x.mp4',
      size_bytes: 1,
      mtime: 1,
      content_hash: 'h'.repeat(64),
      codec: 'h264',
      bitrate: null,
      duration_seconds: null,
      width: null,
      height: null,
      container: null,
      last_scanned_at: 1,

      share_id: null,
    });
    fileRepo.setStatus(file.id, 'encoding', file.version);
    const job = jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: null });
    db.prepare('UPDATE job SET status=?, started_at=? WHERE id=?').run(
      'encoding',
      NOW_SECONDS - 13 * 60 * 60, // 13 hours ago — past 12h threshold
      job!.id,
    );

    __forTests_setDeps({
      fileRepo: () => fileRepo,
      jobRepo: () => jobRepo,
      settingRepo: () => settingRepo,
      trashRepo: () => trashRepo,
      logger: { info: logSpy, warn: warnSpy, error: errorSpy, debug: debugSpy } as never,
      now: () => NOW_SECONDS,
    });

    startEncoderLoop();

    // Stop the loop immediately so the idle timer doesn't keep firing.
    await stopEncoderLoop();

    const refreshedFile = fileRepo.getById(file.id);
    expect(refreshedFile?.status).toBe('interrupted');
    const refreshedJob = db.prepare('SELECT status FROM job WHERE id=?').get(job!.id) as {
      status: string;
    };
    expect(refreshedJob.status).toBe('interrupted');

    const startLogs = logSpy.mock.calls.filter((c) => c[0]?.action === 'encoder_loop_start');
    expect(startLogs).toHaveLength(1);
    expect(startLogs[0][0].recoveredStaleEncoding).toBe(1);
    expect(startLogs[0][0].recoveredFiles).toContain(file.id);
  });

  // Option B: reconcile-on-boot — every 'encoding' row is orphan at boot,
  // regardless of how recent started_at is. Single-process invariant.
  it('test_startEncoderLoop_when_recent_orphan_encoding_then_still_recovered', async () => {
    await __forTests_resetOrchestrator();
    settingRepo.set('cache_pool_path', stageRoot);

    const file = fileRepo.upsertByPath({
      path: '/m/recent.mp4',
      size_bytes: 1,
      mtime: 1,
      content_hash: 'r'.repeat(64),
      codec: 'h264',
      bitrate: null,
      duration_seconds: null,
      width: null,
      height: null,
      container: null,
      last_scanned_at: 1,

      share_id: null,
    });
    fileRepo.setStatus(file.id, 'encoding', file.version);
    const job = jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: null });
    // started_at = 5 SECONDS ago — far inside any old threshold, must still recover.
    db.prepare('UPDATE job SET status=?, started_at=? WHERE id=?').run(
      'encoding',
      NOW_SECONDS - 5,
      job!.id,
    );

    __forTests_setDeps({
      fileRepo: () => fileRepo,
      jobRepo: () => jobRepo,
      settingRepo: () => settingRepo,
      trashRepo: () => trashRepo,
      logger: { info: logSpy, warn: warnSpy, error: errorSpy, debug: debugSpy } as never,
      now: () => NOW_SECONDS,
    });

    startEncoderLoop();
    await stopEncoderLoop();

    const refreshedJob = db.prepare('SELECT status FROM job WHERE id=?').get(job!.id) as {
      status: string;
    };
    expect(refreshedJob.status).toBe('interrupted');
    const refreshedFile = fileRepo.getById(file.id);
    expect(refreshedFile?.status).toBe('interrupted');
  });

  it('test_startEncoderLoop_when_called_twice_then_idempotent', async () => {
    setupOrchestrator();
    startEncoderLoop();
    startEncoderLoop();
    await stopEncoderLoop();
    const startLogs = logSpy.mock.calls.filter((c) => c[0]?.action === 'encoder_loop_start');
    expect(startLogs).toHaveLength(1);
  });
});

describe('orchestrator — cancelJob', () => {
  it('test_cancelJob_when_unknown_then_returns_false', () => {
    setupOrchestrator();
    expect(cancelJob(99999)).toBe(false);
  });

  it('test_cancelJob_when_queued_not_in_flight_then_marks_cancelled_and_reverts_file_to_pending', () => {
    const { fileId, jobId } = setupOrchestrator();
    // setupOrchestrator created a 'queued' job but loopOnce never ran — the
    // active-controller map is empty. Push file row to 'queued' to mirror the
    // post-enqueue state the operator sees in the UI.
    fileRepo.setStatus(fileId, 'queued', 0);

    const accepted = cancelJob(jobId);
    expect(accepted).toBe(true);

    const job = jobRepo.findByFileId(fileId);
    expect(job?.status).toBe('cancelled');
    expect(fileRepo.getById(fileId)?.status).toBe('pending');
  });

  // 2026-04-27 bug repro: operator clicks Cancel during active encode, but
  // ffmpeg keeps running because cancelJob's queued-path was hit (no
  // _activeControllers entry yet — pre-stage race). markCancelled writes
  // 'cancelled' to job DB row. ffmpeg eventually completes successfully.
  // Without the fix, processOne calls markCompleted which has NO SQL status
  // guard → flips 'cancelled' → 'done', commits the staged file, trashes the
  // original. Operator's cancel intent is silently overridden + original
  // file is unintentionally moved to trash.
  //
  // This test simulates the race by manually marking the job 'cancelled'
  // mid-encode (between claim and commit). Expected post-fix:
  //   - job stays 'cancelled' (markCompleted SQL guard rejects flip)
  //   - file stays 'interrupted' (early external-cancel check in processOne)
  //   - original file NOT trashed
  //   - no trash entry written
  //   - stage workDir cleaned up
  it('test_processOne_when_externally_cancelled_during_encode_then_does_NOT_overwrite_or_trash_original', async () => {
    const { fileId, jobId, sourcePath } = setupOrchestrator({});

    // Build a runEncode that gates on a release signal so the test can mark
    // the job 'cancelled' mid-encode + then let ffmpeg "complete".
    let releaseEncode: () => void = () => {};
    __forTests_setDeps({
      runEncode: ({ output }) =>
        new Promise<EncodeResult>((resolve) => {
          releaseEncode = (): void => {
            fs.writeFileSync(output, Buffer.alloc(600_000, 'y'));
            resolve(makeMockEncodeResult());
          };
        }),
    });

    // Snapshot original file presence pre-encode.
    expect(fs.existsSync(sourcePath)).toBe(true);

    // Start the loop in background.
    const loopPromise = loopOnce();
    // Yield enough microtasks for processOne to reach the runEncode await.
    await new Promise((r) => setTimeout(r, 50));

    // Simulate cancelJob's queued-path race: directly mark job 'cancelled'
    // in DB without aborting the controller. ffmpeg keeps running.
    const cancelled = jobRepo.markCancelled(jobId);
    expect(cancelled?.status).toBe('cancelled');

    // Release the encode — ffmpeg "completes" successfully.
    releaseEncode();
    await loopPromise;

    // Post-fix expectations.
    const finalFile = fileRepo.getById(fileId);
    expect(finalFile?.status).toBe('interrupted');

    const finalJob = db.prepare('SELECT * FROM job WHERE id=?').get(jobId) as { status: string };
    expect(finalJob.status).toBe('cancelled');

    expect(fs.existsSync(sourcePath)).toBe(true);

    const trashRows = db.prepare('SELECT * FROM trash_entry').all();
    expect(trashRows).toHaveLength(0);

    expect(fs.existsSync(path.join(stageRoot, 'work', String(jobId)))).toBe(false);
  });

  // 2026-04-27 bug repro: cancelJob queued-path defensive flip when file
  // row is already 'encoding'. Without this, the queued-path's
  // `if (file.status === 'queued')` guard skips the file update, leaving
  // file row orphaned at 'encoding' even though job is 'cancelled'.
  it('test_cancelJob_when_file_status_encoding_and_queued_path_then_flips_file_to_interrupted', () => {
    const { fileId, jobId } = setupOrchestrator();
    // Manually push file to 'encoding' to mirror the pre-stage race state
    // where the orchestrator's processOne has run setStatus(encoding) but
    // not yet registered the AbortController in _activeControllers.
    fileRepo.setStatus(fileId, 'encoding', 0);
    expect(fileRepo.getById(fileId)?.status).toBe('encoding');

    const accepted = cancelJob(jobId);
    expect(accepted).toBe(true);

    const job = jobRepo.findByFileId(fileId);
    expect(job?.status).toBe('cancelled');
    // Defensive flip: file 'encoding' → 'interrupted'.
    expect(fileRepo.getById(fileId)?.status).toBe('interrupted');
  });

  it('test_cancelJob_when_active_then_aborts_controller_and_returns_true', async () => {
    // Use a runEncode that detects abort via the AbortSignal it received.
    // Resolves quickly so the test doesn't hang.
    let aborted = false;
    const { fileId, jobId } = setupOrchestrator({
      runEncode: async ({ signal, output }) => {
        fs.writeFileSync(output, Buffer.alloc(1, 'y'));
        // Wait one microtask, then check if cancelJob set the abort flag.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (signal?.aborted) {
          aborted = true;
          const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
          throw err;
        }
        return makeMockEncodeResult();
      },
    });

    const loopPromise = loopOnce();
    // Wait for the orchestrator to register the controller in _activeControllers.
    // It happens synchronously after setStatus and before await runEncode.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(cancelJob(jobId)).toBe(true);
    await loopPromise;

    expect(aborted).toBe(true);
    const file = fileRepo.getById(fileId);
    expect(file?.status).toBe('interrupted');
  });
});

describe('orchestrator — stopEncoderLoop', () => {
  it('test_stopEncoderLoop_clears_idle_timer_and_logs_stop', async () => {
    setupOrchestrator();
    startEncoderLoop();
    await stopEncoderLoop();
    const stopLogs = logSpy.mock.calls.filter((c) => c[0]?.action === 'encoder_loop_stop');
    expect(stopLogs).toHaveLength(1);
  });

  // Option D: shutdown safety net — if a process gets killed mid-encode and the
  // processOne AbortError catch never runs, stopEncoderLoop's recoverStaleEncoding
  // pass marks any remaining 'encoding' rows as 'interrupted'.
  it('test_stopEncoderLoop_when_orphan_encoding_row_then_marks_interrupted', async () => {
    await __forTests_resetOrchestrator();
    settingRepo.set('cache_pool_path', stageRoot);

    const file = fileRepo.upsertByPath({
      path: '/m/orphan.mp4',
      size_bytes: 1,
      mtime: 1,
      content_hash: 'o'.repeat(64),
      codec: 'h264',
      bitrate: null,
      duration_seconds: null,
      width: null,
      height: null,
      container: null,
      last_scanned_at: 1,

      share_id: null,
    });
    const job = jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: null });
    db.prepare('UPDATE job SET status=?, started_at=? WHERE id=?').run(
      'encoding',
      NOW_SECONDS - 1,
      job!.id,
    );

    __forTests_setDeps({
      fileRepo: () => fileRepo,
      jobRepo: () => jobRepo,
      settingRepo: () => settingRepo,
      trashRepo: () => trashRepo,
      logger: { info: logSpy, warn: warnSpy, error: errorSpy, debug: debugSpy } as never,
      now: () => NOW_SECONDS,
    });

    // Don't startEncoderLoop — directly stop to mirror late-init shutdown.
    await stopEncoderLoop();

    const refreshedJob = db.prepare('SELECT status FROM job WHERE id=?').get(job!.id) as {
      status: string;
    };
    expect(refreshedJob.status).toBe('interrupted');
    const recoverLogs = logSpy.mock.calls.filter((c) => c[0]?.action === 'shutdown_recover');
    expect(recoverLogs).toHaveLength(1);
    expect(recoverLogs[0][0].recoveredJobs).toBe(1);
  });
});

describe('orchestrator — additional error branches (coverage)', () => {
  it('test_loopOnce_when_file_row_missing_then_failJob_file_not_found', async () => {
    await __forTests_resetOrchestrator();
    settingRepo.set('cache_pool_path', stageRoot);
    // Insert a job with a file_id that does NOT exist (bypassing FK by disabling it).
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO job (file_id, status) VALUES (9999, 'queued')").run();
    db.pragma('foreign_keys = ON');
    __forTests_setDeps({
      fileRepo: () => fileRepo,
      jobRepo: () => jobRepo,
      settingRepo: () => settingRepo,
      trashRepo: () => trashRepo,
      logger: { info: logSpy, warn: warnSpy, error: errorSpy, debug: debugSpy } as never,
      now: () => NOW_SECONDS,
    });
    await loopOnce();
    const job = db.prepare('SELECT error_msg FROM job').get() as { error_msg: string };
    expect(job.error_msg).toBe('file_not_found');
  });

  it('test_loopOnce_when_ffprobe_throws_then_failed_with_verify_prefix', async () => {
    const { fileId } = setupOrchestrator({
      ffprobeImpl: async () => {
        throw new Error('ffprobe-spawn-died');
      },
    });
    await loopOnce();
    expect(fileRepo.getById(fileId)?.status).toBe('failed');
    const job = db.prepare('SELECT error_msg FROM job').get() as { error_msg: string };
    expect(job.error_msg).toMatch(/^verify:/);
  });

  it('test_loopOnce_when_stat_source_fails_with_non_ENOENT_then_stat_source_prefix', async () => {
    const eaccess = (): never => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    const { fileId } = setupOrchestrator({ statSyncImpl: eaccess as never });
    await loopOnce();
    expect(fileRepo.getById(fileId)?.status).toBe('failed');
    const job = db.prepare('SELECT error_msg FROM job').get() as { error_msg: string };
    expect(job.error_msg).toBe('stat_source:EACCES');
  });

  it('test_loopOnce_when_stage_step_throws_then_failed_with_cache_pool_unavailable_prefix', async () => {
    // 22-02 vocabulary migration: assertCachePoolWritable runs at the dispatch
    // boundary and now catches the mkdir-on-non-dir failure BEFORE createStageDir.
    // The legacy `stage:*` prefix has been retired for this branch; failures here
    // surface as `cache_pool_unavailable:<errno>` for operator-actionable consistency.
    const { fileId } = setupOrchestrator();
    const blocker = path.join(stageRoot, 'blocker-file');
    fs.writeFileSync(blocker, 'x');
    settingRepo.set('cache_pool_path', blocker);
    await loopOnce();
    expect(fileRepo.getById(fileId)?.status).toBe('failed');
    const job = db.prepare('SELECT error_msg FROM job').get() as { error_msg: string };
    expect(job.error_msg).toMatch(/^cache_pool_unavailable:/);
  });

  it('test_loopOnce_when_statfs_throws_then_failed_with_cache_pool_unavailable_prefix', async () => {
    // 22-02 vocabulary migration: downstream statfs catch now remaps to
    // `cache_pool_unavailable:<errno>` instead of the retired `statfs_failed:<errno>`.
    const { fileId } = setupOrchestrator({});
    __forTests_setDeps({
      fs: {
        statSync: fs.statSync,
        statfsSync: () => {
          throw Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' });
        },
        existsSync: fs.existsSync,
        unlinkSync: (() => undefined) as unknown as typeof import('node:fs').unlinkSync,
        accessSync: fs.accessSync,
      } as never,
    });
    await loopOnce();
    expect(fileRepo.getById(fileId)?.status).toBe('failed');
    const job = db.prepare('SELECT error_msg FROM job').get() as { error_msg: string };
    expect(job.error_msg).toBe('cache_pool_unavailable:ENOTDIR');
  });
});

// 03-01 audit M4 + S2 + S11 + S7: encoder dispatch resolution paths.
describe('orchestrator — encoder dispatch (03-01)', () => {
  it('test_processOne_when_settings_encoder_qsv_but_unavailable_then_falls_back_libx265_with_warn', async () => {
    const { jobId } = setupOrchestrator({});
    settingRepo.set('encoder', 'qsv');
    __forTests_setDeps({
      detectEncoders: async () => ({
        detected: ['libx265'] as const,
        activeFromAuto: 'libx265' as const,
        warnings: [],
        outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
        brokenExcerpts: {},
        probeEncodeDisabled: false,
      }),
    });
    await loopOnce();
    // Job persisted with the FALLBACK encoder, not the requested 'qsv'.
    const job = db.prepare('SELECT encoder, status FROM job WHERE id=?').get(jobId) as {
      encoder: string;
      status: string;
    };
    expect(job.encoder).toBe('libx265');
    expect(job.status).toBe('done');
    // Warn-log emitted with structured action='encoder_unavailable'.
    const warnCalls = warnSpy.mock.calls.map((c) => c[0]);
    const fallbackWarn = warnCalls.find(
      (c) => (c as { action?: string }).action === 'encoder_unavailable',
    );
    expect(fallbackWarn).toBeDefined();
    expect((fallbackWarn as { requested: string }).requested).toBe('qsv');
    expect((fallbackWarn as { fallback: string }).fallback).toBe('libx265');
  });

  it('test_processOne_when_settings_encoder_invalid_string_then_treated_as_auto_with_warn', async () => {
    const { jobId } = setupOrchestrator({});
    settingRepo.set('encoder', 'gibberish');
    __forTests_setDeps({
      detectEncoders: async () => ({
        detected: ['libx265'] as const,
        activeFromAuto: 'libx265' as const,
        warnings: [],
        outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
        brokenExcerpts: {},
        probeEncodeDisabled: false,
      }),
    });
    await loopOnce();
    const job = db.prepare('SELECT encoder, status FROM job WHERE id=?').get(jobId) as {
      encoder: string;
      status: string;
    };
    expect(job.encoder).toBe('libx265');
    expect(job.status).toBe('done');
    const warnCalls = warnSpy.mock.calls.map((c) => c[0]);
    const invalidWarn = warnCalls.find(
      (c) => (c as { action?: string }).action === 'encoder_setting_invalid',
    );
    expect(invalidWarn).toBeDefined();
    expect((invalidWarn as { value: string }).value).toBe('gibberish');
  });

  it('test_processOne_when_settings_encoder_undefined_then_treated_as_auto_no_warn', async () => {
    const { jobId } = setupOrchestrator({});
    // Wipe seed default 'auto' so .encoder returns undefined.
    db.prepare("DELETE FROM setting WHERE key='encoder'").run();
    __forTests_setDeps({
      detectEncoders: async () => ({
        detected: ['libx265'] as const,
        activeFromAuto: 'libx265' as const,
        warnings: [],
        outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
        brokenExcerpts: {},
        probeEncodeDisabled: false,
      }),
    });
    await loopOnce();
    const job = db.prepare('SELECT encoder, status FROM job WHERE id=?').get(jobId) as {
      encoder: string;
      status: string;
    };
    expect(job.encoder).toBe('libx265');
    expect(job.status).toBe('done');
    // No `encoder_setting_invalid` warn — undefined is the legitimate
    // "DB not seeded" path.
    const warnCalls = warnSpy.mock.calls.map((c) => c[0]);
    const invalidWarn = warnCalls.find(
      (c) => (c as { action?: string }).action === 'encoder_setting_invalid',
    );
    expect(invalidWarn).toBeUndefined();
  });

  it('test_processOne_when_logger_info_called_then_job_transition_log_includes_encoder_field', async () => {
    setupOrchestrator({});
    settingRepo.set('encoder', 'libx265');
    __forTests_setDeps({
      detectEncoders: async () => ({
        detected: ['libx265'] as const,
        activeFromAuto: 'libx265' as const,
        warnings: [],
        outcome: { nvenc: 'missing', qsv: 'missing', vaapi: 'missing', libx265: 'functional' },
        brokenExcerpts: {},
        probeEncodeDisabled: false,
      }),
    });
    await loopOnce();
    const transitionLogs = logSpy.mock.calls
      .map((c) => c[0])
      .filter(
        (c) =>
          (c as { action?: string; transition?: string }).action === 'job_transition' &&
          (c as { transition?: string }).transition === 'queued→encoding',
      );
    expect(transitionLogs.length).toBeGreaterThan(0);
    expect((transitionLogs[0] as { encoder: string }).encoder).toBe('libx265');
  });
});

// 03-03 audit M3: orchestrator detection-cache reset hook for refresh endpoint.
//
// The full call-order behavior (refresh endpoint invokes invalidateEncoderCache
// → invalidateOrchestratorDetectionCache → detectEncoders({force:true}) →
// recomputePerEncoderLimits) is verified end-to-end in
// tests/api/encoders-refresh.test.ts. Orchestrator-level tests below verify
// the export exists + is idempotent + does not throw.
describe('orchestrator — invalidateOrchestratorDetectionCache (03-03 audit M3)', () => {
  it('test_invalidateOrchestratorDetectionCache_when_called_then_returns_void_and_does_not_throw', () => {
    expect(() => invalidateOrchestratorDetectionCache()).not.toThrow();
    expect(invalidateOrchestratorDetectionCache()).toBeUndefined();
  });

  it('test_invalidateOrchestratorDetectionCache_when_called_repeatedly_then_idempotent', () => {
    invalidateOrchestratorDetectionCache();
    invalidateOrchestratorDetectionCache();
    invalidateOrchestratorDetectionCache();
    expect(() => invalidateOrchestratorDetectionCache()).not.toThrow();
  });
});

// 05-13: sidecar payload + location + M1 ORDER + M2 W_OK soft-degrade.
// These tests inject mock writeSidecar + hashFile to capture call sites and
// assert the contract without depending on real-fs sidecar parsing.
describe('orchestrator — sidecar fan-out + M1 ORDER + M2 soft-degrade (05-13)', () => {
  it('test_loopOnce_when_done_smaller_then_writeSidecar_called_with_finalOutputPath_and_payload_outcome_done_smaller', async () => {
    const writeSidecarMock = vi.fn().mockResolvedValue(undefined);
    const hashFileMock = vi.fn().mockResolvedValue('out_hash_abc');
    setupOrchestrator({ sourceSize: 1_000_000, outputSize: 600_000 });
    __forTests_setDeps({
      writeSidecar: writeSidecarMock as never,
      hashFile: hashFileMock as never,
    });
    await loopOnce();

    expect(writeSidecarMock).toHaveBeenCalledOnce();
    const [calledPath, calledPayload] = writeSidecarMock.mock.calls[0];
    expect(calledPath).toBe(path.join(mediaRoot, 'movie-x265.mkv'));
    expect(calledPayload.schema).toBe('x265-butler/v2');
    expect(calledPayload.outcome).toBe('done-smaller');
    expect(calledPayload.output.contentHash).toBe('out_hash_abc');
    expect(calledPayload.output.sizeBytes).toBe(600_000);
  });

  it('test_loopOnce_when_done_not_worth_then_writeSidecar_called_with_SOURCE_path_and_payload_outcome_done_not_worth', async () => {
    const writeSidecarMock = vi.fn().mockResolvedValue(undefined);
    const hashFileMock = vi.fn().mockResolvedValue('out_hash_def');
    const { sourcePath } = setupOrchestrator({ sourceSize: 1_000_000, outputSize: 970_000 });
    __forTests_setDeps({
      writeSidecar: writeSidecarMock as never,
      hashFile: hashFileMock as never,
    });
    await loopOnce();

    expect(writeSidecarMock).toHaveBeenCalledOnce();
    const [calledPath, calledPayload] = writeSidecarMock.mock.calls[0];
    expect(calledPath).toBe(sourcePath);
    expect(calledPayload.schema).toBe('x265-butler/v2');
    expect(calledPayload.outcome).toBe('done-not-worth');
    // Forensic fields preserved despite output DISCARD:
    expect(calledPayload.output.contentHash).toBe('out_hash_def');
    expect(calledPayload.output.sizeBytes).toBe(970_000);
  });

  it('test_loopOnce_when_done_larger_then_writeSidecar_called_with_SOURCE_path_and_payload_outcome_done_larger', async () => {
    const writeSidecarMock = vi.fn().mockResolvedValue(undefined);
    const hashFileMock = vi.fn().mockResolvedValue('out_hash_ghi');
    const { sourcePath } = setupOrchestrator({ sourceSize: 1_000_000, outputSize: 1_500_000 });
    __forTests_setDeps({
      writeSidecar: writeSidecarMock as never,
      hashFile: hashFileMock as never,
    });
    await loopOnce();

    expect(writeSidecarMock).toHaveBeenCalledOnce();
    const [calledPath, calledPayload] = writeSidecarMock.mock.calls[0];
    expect(calledPath).toBe(sourcePath);
    expect(calledPayload.outcome).toBe('done-larger');
    expect(calledPayload.output.sizeBytes).toBe(1_500_000);
  });

  // 05-13 audit M2: read-only-source-mount soft-degrade. Simulate via
  // accessSync override that throws EACCES.
  it('test_loopOnce_when_source_path_not_writable_then_sidecar_skipped_setStatus_AND_markCompleted_STILL_run', async () => {
    const writeSidecarMock = vi.fn().mockResolvedValue(undefined);
    const hashFileMock = vi.fn().mockResolvedValue('hash');
    const { fileId } = setupOrchestrator({ sourceSize: 1_000_000, outputSize: 970_000 });
    __forTests_setDeps({
      writeSidecar: writeSidecarMock as never,
      hashFile: hashFileMock as never,
      fs: {
        statSync: fs.statSync,
        statfsSync: (() => ({ bavail: BigInt(100_000_000), bsize: BigInt(1) }) as never) as never,
        existsSync: fs.existsSync,
        unlinkSync: (() => undefined) as unknown as typeof fs.unlinkSync,
        accessSync: () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
      } as never,
    });
    await loopOnce();

    // sidecar NOT written (W_OK pre-flight failed)
    expect(writeSidecarMock).not.toHaveBeenCalled();
    // setStatus STILL ran → DB row updated to done-not-worth
    const file = fileRepo.getById(fileId);
    expect(file?.status).toBe('done-not-worth');
    // markCompleted STILL ran → JobRow has bytes_in/bytes_out/duration_ms
    const job = db.prepare('SELECT * FROM job').get() as {
      status: string;
      bytes_in: number;
      bytes_out: number;
      duration_ms: number;
    };
    expect(job.status).toBe('done');
    expect(job.bytes_in).toBe(1_000_000);
    expect(job.bytes_out).toBe(970_000);
    // pino warn emitted
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sidecar_source_path_not_writable',
        errno: 'EACCES',
        verdict: 'done-not-worth',
      }),
      expect.any(String),
    );
  });

  // 05-13 audit M1 ENOSPC: writeSidecar throws → encode commits successfully
  // without sidecar (warn logged, error non-propagated, setStatus + markCompleted run).
  it('test_loopOnce_when_writeSidecar_throws_ENOSPC_then_warn_logged_and_encode_commits', async () => {
    const writeSidecarMock = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
    const hashFileMock = vi.fn().mockResolvedValue('hash');
    const { fileId } = setupOrchestrator({ sourceSize: 1_000_000, outputSize: 970_000 });
    __forTests_setDeps({
      writeSidecar: writeSidecarMock as never,
      hashFile: hashFileMock as never,
    });
    await loopOnce();

    // setStatus + markCompleted STILL ran
    const file = fileRepo.getById(fileId);
    expect(file?.status).toBe('done-not-worth');
    // warn emitted with errno=ENOSPC
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sidecar_write_failed',
        errno: 'ENOSPC',
        verdict: 'done-not-worth',
      }),
      expect.any(String),
    );
  });

  // 05-13 audit M1 ENOSPC for done-smaller path: same contract — encode commits
  // even when sidecar at output-path fails.
  it('test_loopOnce_when_done_smaller_writeSidecar_throws_ENOSPC_then_warn_logged_and_commit_completes', async () => {
    const writeSidecarMock = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
    const hashFileMock = vi.fn().mockResolvedValue('hash');
    const { fileId } = setupOrchestrator({ sourceSize: 1_000_000, outputSize: 600_000 });
    __forTests_setDeps({
      writeSidecar: writeSidecarMock as never,
      hashFile: hashFileMock as never,
    });
    await loopOnce();

    const file = fileRepo.getById(fileId);
    expect(file?.status).toBe('done-smaller');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sidecar_write_failed',
        errno: 'ENOSPC',
        verdict: 'done-smaller',
      }),
      expect.any(String),
    );
  });
});

// 05-14 audit-added (G3): MP4 audio fail-fast pre-flight at dispatch.
describe('orchestrator — 05-14 mp4 audio fail-fast (AC-12)', () => {
  it('test_processOne_when_mp4_and_truehd_audio_then_fail_fast_BEFORE_ffmpeg_spawn', async () => {
    settingRepo.set('output_container', 'mp4');
    settingRepo.set('audio_auto_transcode_mp4', 'false');
    let ffmpegSpawned = false;
    const { jobId, fileId } = setupOrchestrator({
      runEncode: async () => {
        ffmpegSpawned = true;
        return makeMockEncodeResult();
      },
      ffprobeImpl: async () => ({
        codec: 'h264',
        bitrate: 5_000_000,
        durationSeconds: 60,
        width: 1920,
        height: 1080,
        container: 'matroska',
        tags: {},
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'truehd' },
        ],
      }),
    });

    await loopOnce();

    expect(ffmpegSpawned).toBe(false);
    const job = jobRepo.findById(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error_msg).toContain('mp4_audio_codec_incompatible');
    expect(job?.error_msg).toContain('truehd');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mp4_audio_codec_incompatible',
        codec_name: 'truehd',
        container: 'mp4',
        preflightDecision: 'fail-fast',
      }),
      expect.any(String),
    );
    const file = fileRepo.getById(fileId);
    expect(file?.status).toBe('failed');
  });

  it('test_processOne_when_mkv_and_truehd_audio_then_ffmpeg_spawned_no_fail_fast', async () => {
    settingRepo.set('output_container', 'mkv');
    let ffmpegSpawned = false;
    const { jobId } = setupOrchestrator({
      runEncode: async ({ output }) => {
        ffmpegSpawned = true;
        fs.writeFileSync(output, Buffer.alloc(600_000, 'y'));
        return makeMockEncodeResult();
      },
      ffprobeImpl: async () => ({
        codec: 'h264',
        bitrate: 5_000_000,
        durationSeconds: 60,
        width: 1920,
        height: 1080,
        container: 'matroska',
        tags: {},
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'truehd' },
        ],
      }),
    });

    await loopOnce();

    expect(ffmpegSpawned).toBe(true);
    const job = jobRepo.findById(jobId);
    expect(job?.status).not.toBe('failed');
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mp4_audio_codec_incompatible' }),
      expect.any(String),
    );
  });

  it('test_processOne_when_mp4_and_mixed_aac_truehd_then_error_reason_names_truehd', async () => {
    settingRepo.set('output_container', 'mp4');
    settingRepo.set('audio_auto_transcode_mp4', 'false');
    const { jobId } = setupOrchestrator({
      ffprobeImpl: async () => ({
        codec: 'h264',
        bitrate: 5_000_000,
        durationSeconds: 60,
        width: 1920,
        height: 1080,
        container: 'matroska',
        tags: {},
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac' },
          { index: 2, codec_type: 'audio', codec_name: 'truehd' },
        ],
      }),
    });

    await loopOnce();

    const job = jobRepo.findById(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error_msg).toContain('truehd');
  });
});

// 12-03 audit M4 + SR2: per-encoder preset dispatch resolution + audit-trail
// structured log + AC-13 mid-flight stale-state semantic (settings mutation
// during in-flight encode does NOT affect the dispatched job's argv).
describe('orchestrator — 12-03 per-encoder preset dispatch (AC-5 + AC-13)', () => {
  type CapturedOpts = { preset?: string; encoder?: string };

  function captureRunEncode(stagedOutputBytes: number): {
    captured: CapturedOpts[];
    runEncode: (opts: EncodeOptions) => Promise<EncodeResult>;
  } {
    const captured: CapturedOpts[] = [];
    const runEncode = async (opts: EncodeOptions): Promise<EncodeResult> => {
      captured.push({ preset: opts.preset, encoder: opts.encoder });
      fs.writeFileSync(opts.output, Buffer.alloc(stagedOutputBytes, 'y'));
      return makeMockEncodeResult();
    };
    return { captured, runEncode };
  }

  function findInfoLog(
    predicate: (msg: string, payload: Record<string, unknown>) => boolean,
  ): { payload: Record<string, unknown>; msg: string } | undefined {
    for (const call of logSpy.mock.calls) {
      const payload = call[0] as Record<string, unknown>;
      const msg = String(call[1] ?? '');
      if (predicate(msg, payload)) return { payload, msg };
    }
    return undefined;
  }

  function findWarnLog(
    predicate: (msg: string, payload: Record<string, unknown>) => boolean,
  ): { payload: Record<string, unknown>; msg: string } | undefined {
    for (const call of warnSpy.mock.calls) {
      const payload = call[0] as Record<string, unknown>;
      const msg = String(call[1] ?? '');
      if (predicate(msg, payload)) return { payload, msg };
    }
    return undefined;
  }

  it('test_dispatch_when_settings_preset_libx265_slow_then_runEncode_receives_opts_preset_slow_AND_info_log_with_settings_source', async () => {
    const { captured, runEncode } = captureRunEncode(600_000);
    const { jobId } = setupOrchestrator({ runEncode });
    settingRepo.set('encoder', 'libx265');
    settingRepo.set('preset_libx265', 'slow');
    await loopOnce();
    expect(captured).toHaveLength(1);
    expect(captured[0].encoder).toBe('libx265');
    expect(captured[0].preset).toBe('slow');
    const log = findInfoLog((msg) => msg === 'dispatch_preset_resolved');
    expect(log).toBeDefined();
    expect(log?.payload).toMatchObject({
      encoder: 'libx265',
      presetResolved: 'slow',
      presetSource: 'settings',
    });
    // 12-03 migration 0025: preset_used persisted on the job row at dispatch.
    const jobRow = jobRepo.findById(jobId) as { preset_used?: string | null } | undefined;
    expect(jobRow?.preset_used).toBe('slow');
  });

  it('test_dispatch_when_preset_setting_absent_then_runEncode_receives_DEFAULT_preset_AND_info_log_with_fallback_source', async () => {
    const { captured, runEncode } = captureRunEncode(600_000);
    const { jobId } = setupOrchestrator({ runEncode });
    settingRepo.set('encoder', 'libx265');
    db.prepare("DELETE FROM setting WHERE key='preset_libx265'").run();
    await loopOnce();
    expect(captured[0].preset).toBe('medium');
    const log = findInfoLog((msg) => msg === 'dispatch_preset_resolved');
    expect(log?.payload).toMatchObject({
      encoder: 'libx265',
      presetResolved: 'medium',
      presetSource: 'fallback',
    });
    // preset_used row carries the resolved DEFAULT fallback (not NULL).
    const jobRow = jobRepo.findById(jobId) as { preset_used?: string | null } | undefined;
    expect(jobRow?.preset_used).toBe('medium');
  });

  it('test_dispatch_when_preset_setting_invalid_then_fallback_AND_BOTH_info_resolved_and_warn_invalid_fallback_logs_fire', async () => {
    const { captured, runEncode } = captureRunEncode(600_000);
    setupOrchestrator({ runEncode });
    settingRepo.set('encoder', 'libx265');
    settingRepo.set('preset_libx265', 'lightspeed');
    await loopOnce();
    expect(captured[0].preset).toBe('medium');
    const info = findInfoLog((msg) => msg === 'dispatch_preset_resolved');
    expect(info?.payload).toMatchObject({
      encoder: 'libx265',
      presetResolved: 'medium',
      presetSource: 'fallback',
    });
    const warn = findWarnLog((msg) => msg === 'dispatch_preset_invalid_fallback');
    expect(warn?.payload).toMatchObject({
      encoder: 'libx265',
      requested: 'lightspeed',
      fallback: 'medium',
    });
  });

  it('test_dispatch_AC13_stale_state_when_setting_mutated_between_two_dispatches_then_J1_uses_T0_snapshot_and_J2_uses_T2_value', async () => {
    // Two-job sequence: J1 dispatched at T0 with preset='medium'; T1 mutate
    // setting to 'slow'; J2 dispatched at T2 — orchestrator reads settings at
    // each dispatch boundary, not mid-encode. J1 stays at 'medium'; J2 reads
    // the new 'slow' value. AC-13 stale-state semantic locked-in.
    const captured: CapturedOpts[] = [];
    let runIdx = 0;
    const runEncode = async (opts: EncodeOptions): Promise<EncodeResult> => {
      captured.push({ preset: opts.preset, encoder: opts.encoder });
      if (runIdx === 0) {
        // BETWEEN the two dispatches, operator mutates the setting.
        settingRepo.set('preset_libx265', 'slow');
      }
      runIdx++;
      fs.writeFileSync(opts.output, Buffer.alloc(600_000, 'y'));
      return makeMockEncodeResult();
    };

    setupOrchestrator({ runEncode });
    settingRepo.set('encoder', 'libx265');
    settingRepo.set('preset_libx265', 'medium');

    // Seed a second queued job (separate file) so loopOnce drains 2 jobs.
    const file2Path = path.join(mediaRoot, 'movie2.mp4');
    fs.writeFileSync(file2Path, Buffer.alloc(1_000_000, 'x'));
    const file2 = fileRepo.upsertByPath({
      path: file2Path,
      size_bytes: 1_000_000,
      mtime: 1_700_000_000,
      content_hash: 'b'.repeat(64),
      codec: 'h264',
      bitrate: 5_000_000,
      duration_seconds: 60,
      width: 1920,
      height: 1080,
      container: 'mp4',
      last_scanned_at: 1_700_000_500,

      share_id: null,
    });
    jobRepo.create({ file_id: file2.id, encoder: 'libx265', crf: null });

    // Drain queue. Each loopOnce dispatches at most 1 job at default concurrency.
    await loopOnce();
    await loopOnce();

    expect(captured).toHaveLength(2);
    expect(captured[0].preset).toBe('medium');
    expect(captured[1].preset).toBe('slow');
  });
});
