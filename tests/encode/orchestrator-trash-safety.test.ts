// A finished encode never moves an original without a trash row that points
// at it. The row is written first; when the move fails, what happens to the row
// depends on where the original is afterwards. A broken stored retention falls
// back to the default instead of failing the commit after the move.

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
  stopEncoderLoop,
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
let errorSpy: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.fn>;

const NOW_SECONDS = 1_800_000_000;

const probe = (): ProbeResult => ({
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
    { attachedPic: false, index: 0, codec_type: 'video', codec_name: 'h264' },
    { attachedPic: false, index: 1, codec_type: 'audio', codec_name: 'aac' },
  ],
});

type TrashMove = (src: string, dst: string) => Promise<void>;

function setup(opts: {
  outputMode: 'suffix' | 'replace';
  retention?: string | null;
  trashMove?: TrashMove;
  trashRepoOverride?: Partial<TrashRepo>;
}): { fileId: number; jobId: number; sourcePath: string; rowsAtMove: number[] } {
  const sourcePath = path.join(mediaRoot, 'movie.mkv');
  fs.writeFileSync(sourcePath, Buffer.alloc(1_000_000, 'x'));
  const file = fileRepo.upsertByPath({
    path: sourcePath,
    size_bytes: 1_000_000,
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
  const job = jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: null });
  if (!job) throw new Error('failed to create job');

  settingRepo.set('cache_pool_path', stageRoot);
  settingRepo.set('default_crf', '23');
  settingRepo.set('min_savings_percent', '5');
  if (opts.retention !== null) settingRepo.set('trash_retention_days', opts.retention ?? '30');
  settingRepo.set('output_mode', opts.outputMode);

  const rowsAtMove: number[] = [];
  const trashOriginal = vi.fn(async (src: string, dst: string) => {
    rowsAtMove.push((db.prepare('SELECT COUNT(*) AS c FROM trash_entry').get() as { c: number }).c);
    return (opts.trashMove ?? realStaging.trashOriginal)(src, dst);
  });

  __forTests_setDeps({
    runEncode: (async (o: EncodeOptions) => {
      fs.writeFileSync(o.output, Buffer.alloc(600_000, 'y'));
      return { exitCode: 0, durationMs: 30_000, logTail: '' } satisfies EncodeResult;
    }) as unknown as (o: EncodeOptions) => Promise<EncodeResult>,
    ffprobe: (async () => probe()) as never,
    fs: {
      statSync: fs.statSync as never,
      statfsSync: (() => ({ bavail: BigInt(100_000_000), bsize: BigInt(1) }) as never) as never,
      accessSync: fs.accessSync,
      existsSync: ((p: fs.PathLike) => fs.existsSync(String(p))) as never,
      unlinkSync: fs.unlinkSync as never,
    },
    fileRepo: () => fileRepo,
    jobRepo: () => jobRepo,
    settingRepo: () => settingRepo,
    trashRepo: () => ({ ...trashRepo, ...opts.trashRepoOverride }) as TrashRepo,
    logger: { info: vi.fn(), warn: warnSpy, error: errorSpy, debug: vi.fn() } as never,
    now: () => NOW_SECONDS,
    staging: {
      ...realStaging,
      trashOriginal: trashOriginal as never,
      unlinkSidecarTmpAt: (async () => undefined) as never,
    } as never,
  });
  return { fileId: file.id, jobId: job.id, sourcePath, rowsAtMove };
}

function rows(): Array<{ id: number; trash_path: string; trashed_at: number; expires_at: number }> {
  return db.prepare('SELECT * FROM trash_entry').all() as never;
}

function jobStatus(jobId: number): string {
  return (db.prepare('SELECT status FROM job WHERE id = ?').get(jobId) as { status: string })
    .status;
}

function errorActions(): string[] {
  return errorSpy.mock.calls.map((c) => (c[0] as { action?: string })?.action ?? '');
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
  stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-trash-safety-stage-'));
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-trash-safety-media-'));
  errorSpy = vi.fn();
  warnSpy = vi.fn();
});

afterEach(async () => {
  await __forTests_resetOrchestrator();
  db.close();
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(mediaRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('trash row is written before the original moves', () => {
  it('creates the trash row before moving (suffix)', async () => {
    const { rowsAtMove, sourcePath } = setup({ outputMode: 'suffix' });
    await loopOnce();
    expect(rowsAtMove).toEqual([1]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    const [row] = rows();
    expect(fs.existsSync(row.trash_path)).toBe(true);
  });

  it('creates the trash row before moving (replace)', async () => {
    const { rowsAtMove, sourcePath } = setup({ outputMode: 'replace' });
    await loopOnce();
    expect(rowsAtMove).toEqual([1]);
    expect(fs.readFileSync(sourcePath).length).toBe(600_000);
    const [row] = rows();
    expect(fs.readFileSync(row.trash_path).length).toBe(1_000_000);
  });
});

describe('failed move', () => {
  it('removes the row and leaves the original when the move fails', async () => {
    const { jobId, sourcePath } = setup({
      outputMode: 'replace',
      trashMove: async () => {
        throw Object.assign(new Error('EACCES simulated'), { code: 'EACCES' });
      },
    });
    await loopOnce();
    expect(rows()).toHaveLength(0);
    expect(fs.readFileSync(sourcePath).length).toBe(1_000_000);
    expect(jobStatus(jobId)).toBe('failed');
    expect(errorActions()).toContain('trash_move_failed');
  });

  it('removes the duplicate trash copy when the original is still in place', async () => {
    let copied = '';
    const { sourcePath } = setup({
      outputMode: 'suffix',
      trashMove: async (src, dst) => {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        copied = dst;
        throw Object.assign(new Error('unlink of source failed'), { code: 'EBUSY' });
      },
    });
    await loopOnce();
    expect(rows()).toHaveLength(0);
    expect(copied).not.toBe('');
    expect(fs.existsSync(copied)).toBe(false);
    expect(fs.readFileSync(sourcePath).length).toBe(1_000_000);
  });

  it('keeps the row when the original is already gone after a failed move', async () => {
    const { jobId, sourcePath } = setup({
      outputMode: 'replace',
      trashMove: async (src, dst) => {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
        throw Object.assign(new Error('late failure'), { code: 'EIO' });
      },
    });
    await loopOnce();
    const kept = rows();
    expect(kept).toHaveLength(1);
    expect(fs.existsSync(kept[0].trash_path)).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(jobStatus(jobId)).toBe('failed');
    const partial = errorSpy.mock.calls.find(
      (c) => (c[0] as { action?: string }).action === 'trash_move_partial',
    );
    expect(partial?.[0]).toMatchObject({ originalPath: sourcePath, trashPath: kept[0].trash_path });
  });

  it('logs and rethrows when removing the row fails', async () => {
    const { jobId, sourcePath } = setup({
      outputMode: 'suffix',
      trashMove: async () => {
        throw Object.assign(new Error('EACCES simulated'), { code: 'EACCES' });
      },
      trashRepoOverride: {
        deleteRow: () => {
          throw new Error('database is locked');
        },
      },
    });
    await loopOnce();
    expect(jobStatus(jobId)).toBe('failed');
    const job = db.prepare('SELECT error_msg FROM job WHERE id = ?').get(jobId) as {
      error_msg: string;
    };
    expect(job.error_msg).toMatch(/EACCES simulated/);
    const rollback = errorSpy.mock.calls.find(
      (c) => (c[0] as { action?: string }).action === 'trash_row_rollback_failed',
    );
    expect(rollback?.[0]).toMatchObject({ trashId: expect.any(Number) });
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it('abort during the move leaves a recoverable state', async () => {
    const { sourcePath } = setup({
      outputMode: 'replace',
      trashMove: async (src, dst) => {
        void stopEncoderLoop();
        await new Promise((r) => setTimeout(r, 10));
        return realStaging.trashOriginal(src, dst);
      },
    });
    await loopOnce();
    const kept = rows();
    const originalInPlace = fs.existsSync(sourcePath) && rows().length === 0;
    const recoverable = kept.length === 1 && fs.existsSync(kept[0].trash_path);
    expect(originalInPlace || recoverable).toBe(true);
  });
});

describe('stored retention', () => {
  it.each([['0'], ['abc'], ['4000'], [null]])(
    'invalid stored retention falls back to 30 days (%j)',
    async (stored) => {
      const { jobId } = setup({ outputMode: 'suffix', retention: stored });
      await loopOnce();
      expect(jobStatus(jobId)).toBe('done');
      const [row] = rows();
      expect(row.expires_at - row.trashed_at).toBe(30 * 86_400);
    },
  );

  it.each([
    ['1', 1],
    ['365', 365],
    ['3650', 3650],
  ])('valid stored retention %j is used as is', async (stored, days) => {
    setup({ outputMode: 'suffix', retention: stored });
    await loopOnce();
    const [row] = rows();
    expect(row.expires_at - row.trashed_at).toBe(days * 86_400);
  });
});
