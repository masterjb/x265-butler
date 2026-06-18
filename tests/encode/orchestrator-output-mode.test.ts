// 26-02 (F5): orchestrator output_mode=replace — trash-original-first →
// atomic-rename, hardlink guard (dispatch + commit TOCTOU), AC-11 no-unlink
// invariant, AC-12 commit-failure-after-trash, S2 default-dep guard. Mirrors
// the match-source dispatch-test harness (real staging spread + spies).

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
import * as realStaging from '@/src/lib/encode/staging';
import { __forTests_resetCachePoolCooldowns } from '@/src/lib/encode/staging';

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
let unlinkSyncSpy: ReturnType<typeof vi.fn>;
let callOrder: string[];

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
    container: 'mkv',
    last_scanned_at: 1_700_000_500,
    share_id: null,
  });
  return { id: row.id, path: row.path };
}

const cleanProbe = (): ProbeResult => ({
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
  ],
});

type SetupOpts = {
  filename?: string;
  outputMode?: 'suffix' | 'replace';
  deleteOriginal?: boolean;
  outputSize?: number;
  // nlink sequence for deps.fs.statSync(file.path). One value per call (dispatch,
  // then commit re-probe). Last value sticks. Default [1,1] = normal replace.
  nlinkSeq?: number[];
  // override commitOutput to throw (AC-12).
  commitThrows?: boolean;
  // 33-02: operator-configurable trash root (sets the trash_path setting).
  trashPath?: string;
  // 33-02 (AC-9): force trashOriginal to throw a non-EXDEV error.
  trashThrows?: boolean;
};

function setupReplace({
  filename = 'movie.mkv',
  outputMode = 'replace',
  deleteOriginal = false,
  outputSize = 600_000,
  nlinkSeq = [1, 1],
  commitThrows = false,
  trashPath,
  trashThrows = false,
}: SetupOpts = {}): { fileId: number; jobId: number; sourcePath: string } {
  const sourcePath = path.join(mediaRoot, filename);
  fs.writeFileSync(sourcePath, Buffer.alloc(1_000_000, 'x'));
  const file = seedFile(sourcePath, 1_000_000);
  const job = jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: null });
  if (!job) throw new Error('failed to create job');

  settingRepo.set('cache_pool_path', stageRoot);
  settingRepo.set('default_crf', '23');
  settingRepo.set('min_savings_percent', '5');
  settingRepo.set('trash_retention_days', '30');
  settingRepo.set('output_mode', outputMode);
  settingRepo.set('delete_original_after_encode', deleteOriginal ? 'true' : 'false');
  if (trashPath !== undefined) settingRepo.set('trash_path', trashPath);

  // Per-call nlink sequence — file.path stats return the scripted nlink; any
  // other path (stage output verify-stat) delegates to the real fs.statSync.
  let statCall = 0;
  const statSyncStub = ((p: fs.PathLike) => {
    if (String(p) === sourcePath) {
      const n = nlinkSeq[Math.min(statCall, nlinkSeq.length - 1)];
      statCall += 1;
      const real = fs.statSync(sourcePath);
      return { ...real, nlink: n } as fs.Stats;
    }
    return fs.statSync(p);
  }) as typeof fs.statSync;

  const commitOutputSpy = vi.fn((a: string, b: string) => {
    callOrder.push('commit');
    if (commitThrows) throw new Error('ENOSPC simulated commit failure');
    return realStaging.commitOutput(a, b);
  });
  const trashOriginalSpy = vi.fn((a: string, b: string) => {
    callOrder.push('trash');
    if (trashThrows) throw new Error('EACCES simulated trash move failure');
    return realStaging.trashOriginal(a, b);
  });

  __forTests_setDeps({
    runEncode: (async ({ output }: EncodeOptions) => {
      fs.writeFileSync(output, Buffer.alloc(outputSize, 'y'));
      return { exitCode: 0, durationMs: 30_000, logTail: '' } satisfies EncodeResult;
    }) as unknown as (opts: EncodeOptions) => Promise<EncodeResult>,
    ffprobe: (async () => cleanProbe()) as never,
    fs: {
      statSync: statSyncStub as never,
      statfsSync: (() => ({ bavail: BigInt(100_000_000), bsize: BigInt(1) }) as never) as never,
      accessSync: fs.accessSync,
      existsSync: ((p: fs.PathLike) => fs.existsSync(String(p))) as never,
      unlinkSync: unlinkSyncSpy as never,
    },
    fileRepo: () => fileRepo,
    jobRepo: () => jobRepo,
    settingRepo: () => settingRepo,
    trashRepo: () => trashRepo,
    logger: { info: logSpy, warn: warnSpy, error: errorSpy, debug: debugSpy } as never,
    now: () => NOW_SECONDS,
    staging: {
      ...realStaging,
      commitOutput: commitOutputSpy as never,
      trashOriginal: trashOriginalSpy as never,
      unlinkSidecarTmpAt: (async () => undefined) as never,
    } as never,
  });

  return { fileId: file.id, jobId: job.id, sourcePath };
}

beforeEach(async () => {
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
  stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-orch-om-stage-'));
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-orch-om-media-'));
  logSpy = vi.fn();
  warnSpy = vi.fn();
  errorSpy = vi.fn();
  debugSpy = vi.fn();
  unlinkSyncSpy = vi.fn();
  callOrder = [];
});

afterEach(async () => {
  await __forTests_resetOrchestrator();
  db.close();
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(mediaRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('orchestrator — output_mode=replace (26-02 F5)', () => {
  // AC-3 + AC-6: same-ext true overwrite, trash-FIRST then rename, ordering safe.
  it('test_replace_same_ext_trashes_original_first_then_commits_into_original_path', async () => {
    const { fileId, jobId, sourcePath } = setupReplace({ filename: 'movie.mkv' });
    await loopOnce();

    // AC-6 ordering invariant: trash BEFORE commit (never a both-gone window).
    expect(callOrder).toEqual(['trash', 'commit']);

    // Output committed at the EXACT original path (same-ext replace), no -x265.
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(sourcePath.endsWith('movie.mkv')).toBe(true);
    expect(fs.readFileSync(sourcePath).length).toBe(600_000); // the encoded output

    // Original recoverable via a trash row.
    const trash = db.prepare('SELECT * FROM trash_entry').all() as { trash_path: string }[];
    expect(trash).toHaveLength(1);
    expect(fs.existsSync(trash[0].trash_path)).toBe(true);

    expect(fileRepo.getById(fileId)?.status).toBe('done-smaller');
    const job = db.prepare('SELECT status FROM job WHERE id = ?').get(jobId) as { status: string };
    expect(job.status).toBe('done');
  });

  // AC-4: extension-change avi→mkv writes the bare-ext basename, no -x265.
  it('test_replace_diff_ext_writes_bare_basename_no_suffix', async () => {
    const { sourcePath } = setupReplace({ filename: 'movie.avi' });
    await loopOnce();

    const mkvPath = path.join(mediaRoot, 'movie.mkv');
    expect(fs.existsSync(mkvPath)).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(false); // original avi trashed
    expect(fs.existsSync(path.join(mediaRoot, 'movie-x265.mkv'))).toBe(false);
    const trash = db.prepare('SELECT * FROM trash_entry').all();
    expect(trash).toHaveLength(1);
  });

  // AC-5: hardlinked source (nlink>1 at dispatch) → suffix fallback, ORIGINAL
  // LEFT INTACT (not trashed, not renamed-over), single warn, zero data-loss.
  it('test_replace_hardlinked_source_falls_back_to_suffix_and_keeps_original', async () => {
    const { sourcePath } = setupReplace({ filename: 'movie.mkv', nlinkSeq: [2, 2] });
    await loopOnce();

    // Output at the -x265 sibling; original untouched.
    expect(fs.existsSync(path.join(mediaRoot, 'movie-x265.mkv'))).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.readFileSync(sourcePath).length).toBe(1_000_000); // still the original bytes

    // No trash row; never unlinked.
    expect(db.prepare('SELECT * FROM trash_entry').all()).toHaveLength(0);
    expect(callOrder).not.toContain('trash');
    expect(unlinkSyncSpy).not.toHaveBeenCalled();

    // Single replace_skipped_hardlink warn (reason: dispatch).
    const warns = warnSpy.mock.calls.filter(
      (c) => c[0]?.action === 'replace_skipped_hardlink' && c[0]?.reason === 'dispatch',
    );
    expect(warns).toHaveLength(1);
  });

  // S1: hardlink created DURING encode (nlink=1 at dispatch, 2 at commit) →
  // commit-step TOCTOU re-probe degrades to suffix + leaves original intact.
  it('test_replace_toctou_hardlink_at_commit_degrades_to_suffix_keeps_original', async () => {
    // statSync(file.path) call sequence: [0]=source-size, [1]=dispatch nlink
    // probe (1 → replace proceeds), [2]=commit re-probe (2 → TOCTOU degrade).
    const { sourcePath } = setupReplace({ filename: 'movie.mkv', nlinkSeq: [1, 1, 2] });
    await loopOnce();

    expect(fs.existsSync(path.join(mediaRoot, 'movie-x265.mkv'))).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(callOrder).toEqual(['commit']); // committed to suffix, never trashed
    expect(unlinkSyncSpy).not.toHaveBeenCalled();
    const warns = warnSpy.mock.calls.filter(
      (c) => c[0]?.action === 'replace_skipped_hardlink' && c[0]?.reason === 'commit_toctou',
    );
    expect(warns).toHaveLength(1);
  });

  // AC-11: replace IGNORES delete_original_after_encode — trashes, NEVER unlinks.
  it('test_replace_with_delete_original_true_trashes_and_never_unlinks_file_path', async () => {
    const { sourcePath } = setupReplace({ filename: 'movie.mkv', deleteOriginal: true });
    await loopOnce();

    // Trash row exists (recoverable) and unlinkSync was NEVER called on file.path.
    expect(db.prepare('SELECT * FROM trash_entry').all()).toHaveLength(1);
    const unlinkedPaths = unlinkSyncSpy.mock.calls.map((c) => String(c[0]));
    expect(unlinkedPaths).not.toContain(sourcePath);
    expect(callOrder).toEqual(['trash', 'commit']);
  });

  // AC-12: commit throws AFTER trash → dedicated error log + failJob + trash row
  // intact (recoverable). No fragile rollback; generic terminal not the only signal.
  it('test_replace_commit_failure_after_trash_logs_dedicated_error_and_keeps_trash_row', async () => {
    const { fileId, jobId, sourcePath } = setupReplace({
      filename: 'movie.mkv',
      commitThrows: true,
    });
    await loopOnce();

    // Trash-first happened, commit threw.
    expect(callOrder).toEqual(['trash', 'commit']);
    // Original is in trash (recoverable), original path now empty.
    expect(fs.existsSync(sourcePath)).toBe(false);
    const trash = db.prepare('SELECT * FROM trash_entry').all() as { trash_path: string }[];
    expect(trash).toHaveLength(1);
    expect(fs.existsSync(trash[0].trash_path)).toBe(true);

    // Dedicated forensic error BEFORE failJob.
    const errs = errorSpy.mock.calls.filter(
      (c) => c[0]?.action === 'replace_commit_failed_original_trashed',
    );
    expect(errs).toHaveLength(1);
    expect(errs[0][0].originalPath).toBe(sourcePath);
    expect(errs[0][0].trashId).toBeTruthy();

    // Job failed; never unlinked anything.
    const job = db.prepare('SELECT status FROM job WHERE id = ?').get(jobId) as { status: string };
    expect(job.status).toBe('failed');
    expect(fileRepo.getById(fileId)?.status).toBe('failed');
    expect(unlinkSyncSpy).not.toHaveBeenCalled();
  });

  // AC-1 sentinel (in this harness): suffix mode (default) is unaffected —
  // sibling at -x265, original trashed, no replace ordering.
  it('test_suffix_mode_unchanged_sibling_and_trash', async () => {
    const { sourcePath } = setupReplace({ filename: 'movie.mkv', outputMode: 'suffix' });
    await loopOnce();

    expect(fs.existsSync(path.join(mediaRoot, 'movie-x265.mkv'))).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(callOrder).toEqual(['commit', 'trash']); // suffix: commit FIRST, then trash
    expect(db.prepare('SELECT * FROM trash_entry').all()).toHaveLength(1);
  });

  // 33-02 AC-7: a configured trash_path routes the trash subtree under THAT
  // root (settings.trashPath threaded into trashPathFor), not the cache
  // stageRoot — covered for BOTH the replace and suffix branches.
  it('test_replace_routes_trash_under_configured_trash_path_33_02', async () => {
    const trashRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-trash-array-'));
    try {
      setupReplace({ filename: 'movie.mkv', trashPath: trashRoot });
      await loopOnce();
      const trash = db.prepare('SELECT * FROM trash_entry').all() as { trash_path: string }[];
      expect(trash).toHaveLength(1);
      expect(trash[0].trash_path.startsWith(path.join(trashRoot, 'trash'))).toBe(true);
      expect(fs.existsSync(trash[0].trash_path)).toBe(true);
    } finally {
      fs.rmSync(trashRoot, { recursive: true, force: true });
    }
  });

  it('test_suffix_routes_trash_under_configured_trash_path_33_02', async () => {
    const trashRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-trash-array-'));
    try {
      setupReplace({ filename: 'movie.mkv', outputMode: 'suffix', trashPath: trashRoot });
      await loopOnce();
      const trash = db.prepare('SELECT * FROM trash_entry').all() as { trash_path: string }[];
      expect(trash).toHaveLength(1);
      expect(trash[0].trash_path.startsWith(path.join(trashRoot, 'trash'))).toBe(true);
    } finally {
      fs.rmSync(trashRoot, { recursive: true, force: true });
    }
  });

  // 33-02 AC-9 (SR-1): a non-EXDEV trashOriginal failure emits a DEDICATED
  // trash_move_failed diagnostic naming the resolved trashPath, the job fails,
  // and in replace-mode the original is left intact (trash-FIRST ordering).
  it('test_replace_trash_move_failure_logs_dedicated_error_and_keeps_original', async () => {
    const { fileId, jobId, sourcePath } = setupReplace({
      filename: 'movie.mkv',
      trashThrows: true,
    });
    await loopOnce();

    // Trash attempted, threw BEFORE commit → commit never reached.
    expect(callOrder).toEqual(['trash']);
    // Replace-mode trash-FIRST: original untouched, no trash row persisted.
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(db.prepare('SELECT * FROM trash_entry').all()).toHaveLength(0);

    // Dedicated forensic error naming the resolved trashPath.
    const errs = errorSpy.mock.calls.filter((c) => c[0]?.action === 'trash_move_failed');
    expect(errs).toHaveLength(1);
    expect(errs[0][0].originalPath).toBe(sourcePath);
    expect(typeof errs[0][0].trashPath).toBe('string');
    expect(errs[0][0].err).toContain('EACCES');

    // Job failed; never unlinked anything.
    const job = db.prepare('SELECT status FROM job WHERE id = ?').get(jobId) as { status: string };
    expect(job.status).toBe('failed');
    expect(fileRepo.getById(fileId)?.status).toBe('failed');
    expect(unlinkSyncSpy).not.toHaveBeenCalled();
  });
});

// S2: the default deps.staging must expose replaceOutputPathFor (else processOne
// throws "is not a function" — the exact 26-01 widening failure mode).
describe('orchestrator — replace dep wiring (26-02 S2)', () => {
  it('test_default_staging_exposes_replaceOutputPathFor', () => {
    expect(typeof realStaging.replaceOutputPathFor).toBe('function');
  });
});
