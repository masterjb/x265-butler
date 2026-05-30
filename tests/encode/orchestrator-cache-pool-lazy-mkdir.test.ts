// 22-02 T1.5: orchestrator dispatch-boundary lazy-mkdir + downstream statfs remap.
// Verifies AC-1 / AC-2 / AC-3 / AC-5 / AC-10 / AC-12 at the integration level.

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
import {
  CachePoolUnavailableError,
  __forTests_resetCachePoolCooldowns,
} from '@/src/lib/encode/staging';

type Db = InstanceType<typeof Database>;

let db: Db;
let fileRepo: FileRepo;
let jobRepo: JobRepo;
let settingRepo: SettingRepo;
let trashRepo: TrashRepo;
let stageParent: string;
let mediaRoot: string;
let logSpy: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.fn>;
let debugSpy: ReturnType<typeof vi.fn>;

const NOW_SECONDS = 1_800_000_000;

function makeProbe(): ProbeResult {
  return {
    codec: 'h264',
    bitrate: 2_000_000,
    durationSeconds: 60,
    width: 1920,
    height: 1080,
    container: 'matroska',
    tags: {},
  };
}

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

type SetupOpts = {
  stageRoot?: string; // explicit override; defaults to fresh tmpdir under stageParent
  stagingOverrides?: Partial<typeof realStaging>;
  statfsImpl?: (p: string) => { bavail: bigint; bsize: bigint };
  runEncode?: (opts: EncodeOptions) => Promise<EncodeResult>;
};

function setupDispatch(opts: SetupOpts = {}): {
  fileId: number;
  jobId: number;
  sourcePath: string;
  stageRoot: string;
} {
  const stageRoot = opts.stageRoot ?? fs.mkdtempSync(path.join(stageParent, 'stage-'));
  const sourcePath = path.join(
    mediaRoot,
    `src-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`,
  );
  fs.writeFileSync(sourcePath, Buffer.alloc(1_000_000, 'x'));
  const file = seedFile(sourcePath);
  const job = jobRepo.create({ file_id: file.id, encoder: 'libx265', crf: null });
  if (!job) throw new Error('failed to create job');

  settingRepo.set('cache_pool_path', stageRoot);
  settingRepo.set('default_crf', '23');
  settingRepo.set('min_savings_percent', '5');
  settingRepo.set('trash_retention_days', '30');

  __forTests_setDeps({
    runEncode:
      opts.runEncode ??
      (async ({ output }) => {
        fs.writeFileSync(output, Buffer.alloc(600_000, 'y'));
        return { exitCode: 0, durationMs: 30_000, logTail: '' } satisfies EncodeResult;
      }),
    ffprobe: (async () => makeProbe()) as never,
    fs: {
      statSync: fs.statSync as never,
      statfsSync: (opts.statfsImpl ??
        (() => ({ bavail: BigInt(100_000_000), bsize: BigInt(1) }))) as never,
      accessSync: fs.accessSync,
      existsSync: ((p: fs.PathLike) => fs.existsSync(String(p))) as never,
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
    } as never,
    now: () => NOW_SECONDS,
    staging: {
      ...realStaging,
      ...(opts.stagingOverrides ?? {}),
    } as never,
  });

  return { fileId: file.id, jobId: job.id, sourcePath, stageRoot };
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
  stageParent = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-22-02-parent-'));
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-22-02-media-'));
  logSpy = vi.fn();
  warnSpy = vi.fn();
  errorSpy = vi.fn();
  debugSpy = vi.fn();
});

afterEach(async () => {
  await __forTests_resetOrchestrator();
  db.close();
  fs.rmSync(stageParent, { recursive: true, force: true });
  fs.rmSync(mediaRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('22-02 T1.5: orchestrator cache-pool lazy-mkdir + downstream statfs remap', () => {
  it('AC-1: missing-but-creatable stageRoot → mkdir self-heals; dispatch proceeds past pre-flight', async () => {
    // Parent exists (stageParent), child does NOT — assertCachePoolWritable
    // must mkdir-recursive + write-probe successfully without operator action.
    const lazyStage = path.join(stageParent, `lazy-${Math.random().toString(36).slice(2)}`);
    expect(fs.existsSync(lazyStage)).toBe(false);
    const { jobId } = setupDispatch({ stageRoot: lazyStage });

    await loopOnce();

    expect(fs.existsSync(lazyStage)).toBe(true); // mkdir self-heal proved
    const job = db.prepare('SELECT status, error_msg FROM job WHERE id = ?').get(jobId) as {
      status: string;
      error_msg: string | null;
    };
    expect(job.status).not.toBe('failed');
    expect(job.error_msg ?? '').not.toMatch(/^cache_pool_unavailable:/);
    expect(job.error_msg ?? '').not.toMatch(/^statfs_failed:/);
  });

  it('AC-2: assertCachePoolWritable throws EACCES → failJob cache_pool_unavailable:EACCES + warn payload', async () => {
    const lazyStage = path.join(stageParent, 'eacces-target');
    const stub: typeof realStaging.assertCachePoolWritable = () => {
      throw new CachePoolUnavailableError('EACCES', 'cache_pool_unavailable:EACCES (mkdir)');
    };
    const { jobId, fileId } = setupDispatch({
      stageRoot: lazyStage,
      stagingOverrides: { assertCachePoolWritable: stub },
    });

    await loopOnce();

    const job = db
      .prepare('SELECT status, error_msg, exit_code FROM job WHERE id = ?')
      .get(jobId) as {
      status: string;
      error_msg: string;
      exit_code: number;
    };
    expect(job.status).toBe('failed');
    expect(job.error_msg).toBe('cache_pool_unavailable:EACCES');
    expect(job.exit_code).toBe(0);
    expect(fileRepo.getById(fileId)?.status).toBe('failed');

    // audit M5 + AC-12: pre-failJob structured warn carries cachePath + jobId + phase
    const warns = warnSpy.mock.calls.filter(
      (c) => c[0]?.action === 'cache_pool_unavailable' && c[0]?.phase === 'dispatch',
    );
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({
      action: 'cache_pool_unavailable',
      cachePath: lazyStage,
      code: 'EACCES',
      jobId,
      fileId,
      phase: 'dispatch',
    });
  });

  it('AC-3: downstream statfs ENOENT → remapped to cache_pool_unavailable:ENOENT (NOT statfs_failed)', async () => {
    const lazyStage = path.join(stageParent, 'statfs-late-enoent');
    const statfs = (_p: string) => {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT', syscall: 'statfs' });
      throw err;
    };
    const { jobId } = setupDispatch({ stageRoot: lazyStage, statfsImpl: statfs as never });

    await loopOnce();

    const job = db.prepare('SELECT status, error_msg FROM job WHERE id = ?').get(jobId) as {
      status: string;
      error_msg: string;
    };
    expect(job.status).toBe('failed');
    expect(job.error_msg).toBe('cache_pool_unavailable:ENOENT');
    expect(job.error_msg).not.toMatch(/^statfs_failed:/);

    const warns = warnSpy.mock.calls.filter(
      (c) => c[0]?.action === 'cache_pool_unavailable' && c[0]?.phase === 'statfs-late',
    );
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({
      cachePath: lazyStage,
      code: 'ENOENT',
      syscall: 'statfs',
      phase: 'statfs-late',
    });
  });

  it('AC-3 open-set: downstream statfs EIO → cache_pool_unavailable:EIO', async () => {
    const lazyStage = path.join(stageParent, 'statfs-late-eio');
    const statfs = (_p: string) => {
      const err = Object.assign(new Error('EIO'), { code: 'EIO', syscall: 'statfs' });
      throw err;
    };
    const { jobId } = setupDispatch({ stageRoot: lazyStage, statfsImpl: statfs as never });

    await loopOnce();

    const job = db.prepare('SELECT error_msg FROM job WHERE id = ?').get(jobId) as {
      error_msg: string;
    };
    expect(job.error_msg).toBe('cache_pool_unavailable:EIO');
  });

  it('shape-error preserved: empty cache_pool_path → invalid_cache_pool_path:empty (NOT remapped)', async () => {
    // Must seed the DB row first via setupDispatch (which sets cache_pool_path
    // to a valid stageRoot), THEN overwrite the setting to '' before loopOnce.
    const { jobId } = setupDispatch();
    settingRepo.set('cache_pool_path', '');

    await loopOnce();

    const job = db.prepare('SELECT status, error_msg FROM job WHERE id = ?').get(jobId) as {
      status: string;
      error_msg: string;
    };
    expect(job.status).toBe('failed');
    expect(job.error_msg).toBe('invalid_cache_pool_path:empty');
    expect(job.error_msg).not.toMatch(/^cache_pool_unavailable:/);
  });

  it('AC-5 carry-forward: preflight_statfs_probe still emits paths_probed.length=3 on happy path', async () => {
    const lazyStage = path.join(stageParent, 'happy-preflight');
    const { jobId } = setupDispatch({ stageRoot: lazyStage });

    await loopOnce();

    // Job must succeed past the cache-pool pre-flight to reach the preflight_statfs_probe site.
    const job = db.prepare('SELECT status FROM job WHERE id = ?').get(jobId) as { status: string };
    expect(job.status).not.toBe('failed');

    const probeLogs = logSpy.mock.calls.filter((c) => c[1] === 'preflight_statfs_probe');
    expect(probeLogs).toHaveLength(1);
    const payload = probeLogs[0][0] as { paths_probed: Array<{ statfs_ok: boolean }> };
    expect(payload.paths_probed).toHaveLength(3);
    for (const entry of payload.paths_probed) {
      expect(entry.statfs_ok).toBe(true);
    }
  });
});
