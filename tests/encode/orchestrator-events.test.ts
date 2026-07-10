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
  loopOnce,
} from '@/src/lib/encode/orchestrator';
import type { EncodeOptions, EncodeResult } from '@/src/lib/encode/ffmpeg';
import type { ProbeResult } from '@/src/lib/scan/ffprobe';
import type { EngineEvent, EngineEvents } from '@/src/lib/encode/events';

// 02-03 Task 2: separate-file emit assertions per boundary preservation —
// 02-02's orchestrator-integration.test.ts stays byte-identical.

type Db = InstanceType<typeof Database>;

let db: Db;
let fileRepo: FileRepo;
let jobRepo: JobRepo;
let settingRepo: SettingRepo;
let trashRepo: TrashRepo;
let stageRoot: string;
let mediaRoot: string;
let captured: EngineEvent[];
let mockEvents: EngineEvents;

const NOW_SECONDS = 1_800_000_000;

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
    color: { space: null, primaries: null, transfer: null, range: null },
    hdr10: { masterDisplay: null, maxCll: null },
  };
}

async function setup({
  sourceSize = 1_000_000,
  outputSize,
  runEncode,
  ffprobeImpl,
}: {
  sourceSize?: number;
  outputSize?: number;
  runEncode?: (opts: EncodeOptions) => Promise<EncodeResult>;
  ffprobeImpl?: () => Promise<ProbeResult | null>;
} = {}): Promise<{ fileId: number; jobId: number }> {
  await __forTests_resetOrchestrator();

  const sourcePath = path.join(mediaRoot, 'movie.mp4');
  fs.writeFileSync(sourcePath, Buffer.alloc(sourceSize, 'x'));

  const file = seedFile(sourcePath, sourceSize);
  const job = jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: null });
  if (!job) throw new Error('failed to create job');

  settingRepo.set('cache_pool_path', stageRoot);
  settingRepo.set('default_crf', '23');
  settingRepo.set('min_savings_percent', '5');
  settingRepo.set('trash_retention_days', '30');

  const stagedOutputBytes = outputSize ?? Math.floor(sourceSize * 0.6);

  __forTests_setDeps({
    runEncode:
      runEncode ??
      (async ({ output }) => {
        fs.writeFileSync(output, Buffer.alloc(stagedOutputBytes, 'y'));
        return makeMockEncodeResult();
      }),
    ffprobe: (ffprobeImpl ?? (async () => makeMockProbe())) as never,
    fs: {
      statSync: fs.statSync as never,
      statfsSync: (() => ({ bavail: BigInt(100_000_000), bsize: BigInt(1) }) as never) as never,
      existsSync: fs.existsSync as never,
      unlinkSync: (() => undefined) as unknown as typeof import('node:fs').unlinkSync,
      accessSync: fs.accessSync,
    },
    fileRepo: () => fileRepo,
    jobRepo: () => jobRepo,
    settingRepo: () => settingRepo,
    trashRepo: () => trashRepo,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never,
    now: () => NOW_SECONDS,
    events: mockEvents,
  });

  return { fileId: file.id, jobId: job.id };
}

beforeEach(async () => {
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
  stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-events-stage-'));
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-events-media-'));
  captured = [];
  mockEvents = {
    emit: (ev) => {
      captured.push(ev);
    },
    subscribe: vi.fn(() => () => {}),
    getLastProgress: vi.fn(() => undefined),
    getLastPass2Progress: vi.fn(() => undefined),
  };
});

afterEach(async () => {
  await __forTests_resetOrchestrator();
  db.close();
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(mediaRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('orchestrator → engineEvents emit (02-03 Task 2)', () => {
  it('test_loopOnce_happy_path_smaller_emits_started_progress_completed_queueUpdated_in_order', async () => {
    await setup();
    await loopOnce();

    // Filter to just the events under test (every transition also emits queue.updated)
    const types = captured.map((e) => e.type);
    expect(types[0]).toBe('job.started');
    // job.progress depends on whether mock runEncode invokes onProgress;
    // the default mock runEncode does NOT call onProgress (it just writes the
    // output file), so we won't see job.progress in this happy-path test.
    expect(types).toContain('job.completed');
    expect(types).toContain('queue.updated');
    // Ordering: completed before final queue.updated
    const completedIdx = types.indexOf('job.completed');
    const lastQueueIdx = types.lastIndexOf('queue.updated');
    expect(completedIdx).toBeLessThan(lastQueueIdx);

    const completed = captured.find((e) => e.type === 'job.completed') as Extract<
      EngineEvent,
      { type: 'job.completed' }
    >;
    expect(completed.outcome).toBe('done-smaller');
    expect(completed.bytesIn).toBe(1_000_000);
    expect(completed.bytesOut).toBeGreaterThan(0);
  });

  // 05-13: 3-bucket verdict — output 999k vs source 1M = 0.1% savings (below
  // default min 5%) → done-not-worth (was lumped under done-larger pre-05-13).
  it('test_loopOnce_savings_below_threshold_emits_completed_outcome_done_not_worth', async () => {
    await setup({ outputSize: 999_000 }); // 0.1% savings → done-not-worth
    await loopOnce();
    const completed = captured.find((e) => e.type === 'job.completed') as Extract<
      EngineEvent,
      { type: 'job.completed' }
    >;
    expect(completed).toBeDefined();
    expect(completed.outcome).toBe('done-not-worth');
  });

  it('test_loopOnce_output_strictly_larger_than_source_emits_completed_outcome_done_larger', async () => {
    await setup({ outputSize: 1_500_000 }); // output > source → genuine done-larger
    await loopOnce();
    const completed = captured.find((e) => e.type === 'job.completed') as Extract<
      EngineEvent,
      { type: 'job.completed' }
    >;
    expect(completed).toBeDefined();
    expect(completed.outcome).toBe('done-larger');
  });

  it('test_loopOnce_failed_path_emits_job_failed_with_exitCode_and_errorMsg', async () => {
    await setup({
      runEncode: async ({ output }) => {
        fs.writeFileSync(output, Buffer.alloc(100, 'y'));
        return makeMockEncodeResult({ exitCode: 1, logTail: 'Invalid data found' });
      },
    });
    await loopOnce();
    const failed = captured.find((e) => e.type === 'job.failed') as Extract<
      EngineEvent,
      { type: 'job.failed' }
    >;
    expect(failed).toBeDefined();
    expect(failed.exitCode).toBe(1);
    expect(failed.errorMsg).toContain('encode_nonzero_exit');
    // queue.updated also follows failed
    expect(captured.map((e) => e.type)).toContain('queue.updated');
  });

  it('test_loopOnce_when_runEncode_invokes_onProgress_then_emits_job_progress', async () => {
    await setup({
      runEncode: async ({ output, onProgress }) => {
        fs.writeFileSync(output, Buffer.alloc(600_000, 'y'));
        // Trigger 3 progress events
        onProgress?.({
          frame: 100,
          fps: 30,
          outTimeMs: 3300000,
          totalSize: 12345,
          speed: null,
          progress: 'continue',
        });
        onProgress?.({
          frame: 200,
          fps: 30,
          outTimeMs: 6600000,
          totalSize: 24690,
          speed: null,
          progress: 'continue',
        });
        onProgress?.({
          frame: 300,
          fps: 30,
          outTimeMs: 9900000,
          totalSize: 37035,
          speed: null,
          progress: 'end',
        });
        return makeMockEncodeResult();
      },
    });
    await loopOnce();
    const progress = captured.filter((e) => e.type === 'job.progress');
    expect(progress).toHaveLength(3);
    expect((progress[2] as Extract<EngineEvent, { type: 'job.progress' }>).progress).toBe('end');
  });

  it('test_loopOnce_emits_queue_updated_AFTER_terminal_with_fresh_counts', async () => {
    await setup();
    await loopOnce();
    // Exactly one queue.updated after the terminal transition (smaller path)
    const queueUpdates = captured.filter((e) => e.type === 'queue.updated') as Array<
      Extract<EngineEvent, { type: 'queue.updated' }>
    >;
    expect(queueUpdates.length).toBeGreaterThanOrEqual(1);
    const last = queueUpdates[queueUpdates.length - 1];
    expect(last.activeJobs).toBe(0);
    expect(last.pendingJobs).toBe(0);
  });

  it('test_loopOnce_when_file_version_conflict_then_NO_job_started_emit_queue_updated_only', async () => {
    await setup();
    // Inject a fileRepo that returns false from setStatus (simulating a race
    // where another writer bumped the version between getById and setStatus).
    const realFileRepo = fileRepo;
    const failingFileRepo: FileRepo = {
      ...realFileRepo,
      setStatus: (id, status, expectedVersion) => {
        if (status === 'encoding') return false; // race: stale version
        return realFileRepo.setStatus(id, status, expectedVersion);
      },
    };
    __forTests_setDeps({ fileRepo: () => failingFileRepo });
    await loopOnce();
    const types = captured.map((e) => e.type);
    expect(types).not.toContain('job.started');
    expect(types).toContain('queue.updated');
  });

  // audit-added M1: verify safeEmit isolates orchestrator from listener throws
  it('test_loopOnce_when_listener_throws_then_orchestrator_completes_normally', async () => {
    // Wire a custom mockEvents with a listener that throws on every event.
    // The orchestrator must NOT see the throw — events.ts safeEmit catches.
    // Use the REAL engineEvents singleton with our throwing subscriber to
    // exercise the actual safeEmit path.
    const { engineEvents, __forTests_resetEngineEvents } = await import('@/src/lib/encode/events');
    __forTests_resetEngineEvents();
    // re-bind defaults so the orchestrator picks up the new singleton
    await __forTests_resetOrchestrator();

    const sourcePath = path.join(mediaRoot, 'crashy.mp4');
    fs.writeFileSync(sourcePath, Buffer.alloc(1_000_000, 'x'));
    const file = seedFile(sourcePath);
    const job = jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: null });
    if (!job) throw new Error('seed failed');
    settingRepo.set('cache_pool_path', stageRoot);
    settingRepo.set('default_crf', '23');
    settingRepo.set('min_savings_percent', '5');
    settingRepo.set('trash_retention_days', '30');

    __forTests_setDeps({
      runEncode: (async (opts: EncodeOptions) => {
        fs.writeFileSync(opts.output, Buffer.alloc(600_000, 'y'));
        return makeMockEncodeResult();
      }) as never,
      ffprobe: (async () => makeMockProbe()) as never,
      fs: {
        statSync: fs.statSync,
        statfsSync: (() => ({ bavail: BigInt(100_000_000), bsize: BigInt(1) }) as never) as never,
        existsSync: fs.existsSync,
        unlinkSync: (() => undefined) as unknown as typeof import('node:fs').unlinkSync,
        accessSync: fs.accessSync,
      },
      fileRepo: () => fileRepo,
      jobRepo: () => jobRepo,
      settingRepo: () => settingRepo,
      trashRepo: () => trashRepo,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as never,
      now: () => NOW_SECONDS,
      // NOTE: events left as default singleton via makeDefaultDeps (re-bound by reset)
    });

    // Subscribe a throwing listener to the live singleton
    engineEvents.subscribe(() => {
      throw new Error('subscriber crashed');
    });

    await expect(loopOnce()).resolves.toBeUndefined(); // does NOT throw
    // Job must reach 'done' status (encode succeeded despite listener crash)
    const finalJob = db.prepare('SELECT status FROM job WHERE id = ?').get(job.id) as {
      status: string;
    };
    expect(finalJob.status).toBe('done');
  });
});
