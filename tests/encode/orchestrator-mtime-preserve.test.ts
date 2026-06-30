// 31-02: source-mtime preservation on the committed output. The done-smaller
// commit step captures the source {atime,mtime} BEFORE any trash/rename and
// stamps the committed finalOutputPath AFTER the commit if/else (best-effort,
// soft-degrade — a stamp failure NEVER fails a committed encode). Discard
// verdicts produce no output and must not stamp. Mirrors the
// orchestrator-output-mode harness (real staging spread + spies).

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

const NOW_SECONDS = 1_800_000_000;

// A fixed past stamp, distinct from "now" (the encode write time). atime/mtime
// are set identically on the source; the stamp must copy BOTH (D3).
const PAST = new Date('2020-01-15T10:00:00.000Z');

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
  color: { space: null, primaries: null, transfer: null, range: null },
  hdr10: { masterDisplay: null, maxCll: null },
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264' },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
  ],
});

type SetupOpts = {
  filename?: string;
  outputMode?: 'suffix' | 'replace';
  outputSize?: number;
  nlinkSeq?: number[];
  // utimesSync injection: a spy/throwing fn, or 'omit' to drop the optional dep
  // entirely (legacy-mock arm, AC-3b). 'real' lets the production wiring run.
  utimes?: typeof fs.utimesSync | 'omit' | 'real';
};

function setup({
  filename = 'movie.mkv',
  outputMode = 'suffix',
  outputSize = 600_000,
  nlinkSeq = [1, 1],
  utimes = 'omit',
}: SetupOpts = {}): { fileId: number; jobId: number; sourcePath: string } {
  const sourcePath = path.join(mediaRoot, filename);
  fs.writeFileSync(sourcePath, Buffer.alloc(1_000_000, 'x'));
  // Stamp the source with a fixed past mtime/atime, distinct from the encode
  // write time — this is what the commit step must preserve onto the output.
  fs.utimesSync(sourcePath, PAST, PAST);
  const file = seedFile(sourcePath, 1_000_000);
  const job = jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: null });
  if (!job) throw new Error('failed to create job');

  settingRepo.set('cache_pool_path', stageRoot);
  settingRepo.set('default_crf', '23');
  settingRepo.set('min_savings_percent', '5');
  settingRepo.set('trash_retention_days', '30');
  settingRepo.set('output_mode', outputMode);
  settingRepo.set('delete_original_after_encode', 'false');

  // Per-call nlink sequence for file.path stats; explicitly carries the real
  // atime/mtime Dates (spread alone drops the lazy Stats getters → undefined).
  let statCall = 0;
  const statSyncStub = ((p: fs.PathLike) => {
    if (String(p) === sourcePath) {
      const n = nlinkSeq[Math.min(statCall, nlinkSeq.length - 1)];
      statCall += 1;
      const real = fs.statSync(sourcePath);
      return { ...real, atime: real.atime, mtime: real.mtime, nlink: n } as fs.Stats;
    }
    return fs.statSync(p);
  }) as typeof fs.statSync;

  const fsDep: Record<string, unknown> = {
    statSync: statSyncStub,
    statfsSync: (() => ({ bavail: BigInt(100_000_000), bsize: BigInt(1) })) as never,
    accessSync: fs.accessSync,
    existsSync: ((p: fs.PathLike) => fs.existsSync(String(p))) as never,
    unlinkSync: vi.fn(),
  };
  if (utimes === 'real') {
    fsDep.utimesSync = fs.utimesSync;
  } else if (utimes !== 'omit') {
    fsDep.utimesSync = utimes;
  }
  // utimes === 'omit' → no utimesSync key (legacy-mock arm).

  __forTests_setDeps({
    runEncode: (async ({ output }: EncodeOptions) => {
      fs.writeFileSync(output, Buffer.alloc(outputSize, 'y'));
      return { exitCode: 0, durationMs: 30_000, logTail: '' } satisfies EncodeResult;
    }) as unknown as (opts: EncodeOptions) => Promise<EncodeResult>,
    ffprobe: (async () => cleanProbe()) as never,
    fs: fsDep as never,
    fileRepo: () => fileRepo,
    jobRepo: () => jobRepo,
    settingRepo: () => settingRepo,
    trashRepo: () => trashRepo,
    logger: { info: logSpy, warn: warnSpy, error: errorSpy, debug: debugSpy } as never,
    now: () => NOW_SECONDS,
    staging: {
      ...realStaging,
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
  stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-orch-mt-stage-'));
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-orch-mt-media-'));
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

const PAST_SECONDS = Math.floor(PAST.getTime() / 1000);
const mtimeSeconds = (p: string): number => Math.floor(fs.statSync(p).mtime.getTime() / 1000);

describe('orchestrator — source-mtime preservation (31-02)', () => {
  // AC-1: suffix-mode keep stamps the output with the source mtime/atime.
  it('test_suffix_keep_stamps_output_with_source_mtime', async () => {
    const utimesSpy = vi.fn();
    const { fileId, sourcePath } = setup({ outputMode: 'suffix', utimes: utimesSpy as never });
    const expected = fs.statSync(sourcePath); // PAST atime/mtime, captured pre-run
    const finalOutputPath = path.join(mediaRoot, 'movie-x265.mkv');

    await loopOnce();

    expect(fs.existsSync(finalOutputPath)).toBe(true);
    expect(fileRepo.getById(fileId)?.status).toBe('done-smaller');
    // Exactly one stamp, on the committed output, with the source atime/mtime (D3).
    expect(utimesSpy).toHaveBeenCalledTimes(1);
    expect(utimesSpy).toHaveBeenCalledWith(finalOutputPath, expected.atime, expected.mtime);
    expect(
      warnSpy.mock.calls.filter((c) => c[0]?.action === 'output_mtime_preserve_failed'),
    ).toHaveLength(0);
  });

  // AC-1 real-fs: the production wiring (real fs.utimesSync) actually stamps the
  // output's on-disk mtime — guards the optional-dep seam against silent regress.
  it('test_suffix_keep_real_fs_output_mtime_equals_source', async () => {
    const finalOutputPath = path.join(mediaRoot, 'movie-x265.mkv');
    setup({ outputMode: 'suffix', utimes: 'real' });

    await loopOnce();

    expect(fs.existsSync(finalOutputPath)).toBe(true);
    expect(mtimeSeconds(finalOutputPath)).toBe(PAST_SECONDS);
  });

  // AC-2: replace-mode captures the source timestamp BEFORE the trash step. The
  // in-place replaced file can only carry the source mtime if captured pre-trash
  // (trash removes the source first), proven on a real filesystem.
  it('test_replace_captures_source_mtime_before_trash_and_stamps_in_place', async () => {
    const { sourcePath } = setup({ outputMode: 'replace', nlinkSeq: [1, 1], utimes: 'real' });

    await loopOnce();

    // same-ext replace: output committed at the original path, original trashed.
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.readFileSync(sourcePath).length).toBe(600_000); // the encoded output
    expect(db.prepare('SELECT * FROM trash_entry').all()).toHaveLength(1);
    // The replaced file carries the ORIGINAL source mtime → captured pre-trash.
    expect(mtimeSeconds(sourcePath)).toBe(PAST_SECONDS);
  });

  // AC-3: stamp throw is soft — encode still completes done-smaller, single warn,
  // no escape.
  it('test_stamp_throw_is_soft_degrade_job_still_done_smaller', async () => {
    const throwingUtimes = vi.fn(() => {
      throw new Error('EROFS simulated read-only destination');
    });
    const { fileId, jobId } = setup({ outputMode: 'suffix', utimes: throwingUtimes as never });

    // loopOnce must not reject (error never propagates into failJob).
    await expect(loopOnce()).resolves.toBeUndefined();

    expect(throwingUtimes).toHaveBeenCalledTimes(1);
    expect(fileRepo.getById(fileId)?.status).toBe('done-smaller');
    const job = db.prepare('SELECT status FROM job WHERE id = ?').get(jobId) as { status: string };
    expect(job.status).toBe('done');
    const warns = warnSpy.mock.calls.filter((c) => c[0]?.action === 'output_mtime_preserve_failed');
    expect(warns).toHaveLength(1);
  });

  // AC-3b: the undefined-dep (legacy-mock) arm is a SILENT no-op — no stamp, no warn.
  it('test_undefined_dep_arm_is_silent_no_op', async () => {
    const { fileId, jobId } = setup({ outputMode: 'suffix', utimes: 'omit' });

    await expect(loopOnce()).resolves.toBeUndefined();

    expect(fileRepo.getById(fileId)?.status).toBe('done-smaller');
    const job = db.prepare('SELECT status FROM job WHERE id = ?').get(jobId) as { status: string };
    expect(job.status).toBe('done');
    // The `?.` short-circuits cleanly — no spurious preserve-failed warn.
    expect(
      warnSpy.mock.calls.filter((c) => c[0]?.action === 'output_mtime_preserve_failed'),
    ).toHaveLength(0);
    expect(
      warnSpy.mock.calls.filter((c) => c[0]?.action === 'output_mtime_capture_failed'),
    ).toHaveLength(0);
  });

  // AC-4: discard verdicts (done-larger) never stamp — no output exists, source
  // left untouched including its timestamps.
  it('test_discard_done_larger_never_stamps_and_source_mtime_unchanged', async () => {
    const utimesSpy = vi.fn();
    // output bigger than source → done-larger discard branch.
    const { fileId, sourcePath } = setup({
      outputMode: 'suffix',
      outputSize: 2_000_000,
      utimes: utimesSpy as never,
    });

    await loopOnce();

    // Discard: no -x265 output committed, source preserved.
    expect(fs.existsSync(path.join(mediaRoot, 'movie-x265.mkv'))).toBe(false);
    expect(fs.existsSync(sourcePath)).toBe(true);
    const status = fileRepo.getById(fileId)?.status;
    expect(status === 'done-larger' || status === 'done-not-worth').toBe(true);
    // No stamp attempted; source timestamps untouched.
    expect(utimesSpy).not.toHaveBeenCalled();
    expect(mtimeSeconds(sourcePath)).toBe(PAST_SECONDS);
  });
});
