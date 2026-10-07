// @vitest-environment node
// Expired trash entries are removed together with their file. A row is only
// deleted once the file is gone, a path outside the trash layout is never
// touched, and the kill switch keeps everything in place.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo } from '@/src/lib/db/repos/file';
import { makeTrashRepo, type TrashRepo } from '@/src/lib/db/repos/trash';
import { trashPathFor } from '@/src/lib/encode/staging';
import {
  purgeExpiredTrash,
  isPurgeableTrashPath,
  resolveTrashPurgeEnabled,
  __forTests_resetTrashPurge,
} from '@/src/lib/trash/purge';
import type { AppLogger } from '@/src/lib/logger';

type Db = InstanceType<typeof Database>;

const NOW = 2_000_000_000;

function makeLogger() {
  const logger = {
    debug: vi.fn(),
    telemetry: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

describe('purgeExpiredTrash', () => {
  let db: Db;
  let repo: TrashRepo;
  let root: string;
  let fileId: number;
  let logger: ReturnType<typeof makeLogger>;
  let seq = 0;

  function addEntry(opts: {
    expired?: boolean;
    withFile?: boolean;
    trashPath?: string;
    originalPath?: string;
  }) {
    seq += 1;
    const originalPath = opts.originalPath ?? `/media/show/${seq}.mkv`;
    const trashPath = opts.trashPath ?? trashPathFor(originalPath, root, seq, 1_700_000_000);
    if (opts.withFile !== false) {
      fs.mkdirSync(path.dirname(trashPath), { recursive: true });
      fs.writeFileSync(trashPath, 'x');
    }
    const row = repo.create({
      file_id: fileId,
      original_path: originalPath,
      trash_path: trashPath,
      size_bytes: 1,
      retention_days: 30,
    });
    const expiresAt = opts.expired === false ? NOW + 86_400 : NOW - 10;
    db.prepare('UPDATE trash_entry SET expires_at = ? WHERE id = ?').run(expiresAt, row.id);
    return { ...row, trash_path: trashPath };
  }

  function rowCount(): number {
    return (db.prepare('SELECT COUNT(*) AS c FROM trash_entry').get() as { c: number }).c;
  }

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repo = makeTrashRepo(db);
    fileId = makeFileRepo(db).upsertByPath({
      path: '/media/show/source.mkv',
      size_bytes: 1000,
      mtime: 1_700_000_000,
      content_hash: 'a'.repeat(64),
      codec: 'h264',
      bitrate: 1,
      duration_seconds: 1,
      width: 1,
      height: 1,
      container: 'mkv',
      last_scanned_at: 1_700_000_000,
      share_id: null,
    }).id;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-'));
    logger = makeLogger();
    seq = 0;
    __forTests_resetTrashPurge();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.TRASH_PURGE_DISABLED;
    __forTests_resetTrashPurge();
  });

  const run = (extra: Partial<Parameters<typeof purgeExpiredTrash>[0]> = {}) =>
    purgeExpiredTrash({ now: NOW, repo, logger: logger as unknown as AppLogger, ...extra });

  it('deletes the file, the row and the empty job folder of an expired entry', async () => {
    const e = addEntry({});
    const result = await run();
    expect(result.deleted).toBe(1);
    expect(fs.existsSync(e.trash_path)).toBe(false);
    expect(fs.existsSync(path.dirname(e.trash_path))).toBe(false);
    expect(fs.existsSync(path.join(root, 'trash'))).toBe(true);
    expect(rowCount()).toBe(0);
  });

  it('leaves unexpired and restored entries alone', async () => {
    const fresh = addEntry({ expired: false });
    const restored = addEntry({});
    repo.restore(restored.id);
    const result = await run();
    expect(result.deleted).toBe(0);
    expect(fs.existsSync(fresh.trash_path)).toBe(true);
    expect(fs.existsSync(restored.trash_path)).toBe(true);
    expect(rowCount()).toBe(2);
  });

  it('ENOENT counts as gone', async () => {
    addEntry({ withFile: false });
    const result = await run();
    expect(result.deleted).toBe(1);
    expect(rowCount()).toBe(0);
  });

  it('keeps the row and logs on EACCES, retries next run', async () => {
    const e = addEntry({});
    const err = Object.assign(new Error('denied'), { code: 'EACCES' });
    const unlink = vi.fn().mockRejectedValueOnce(err);
    const first = await run({ fs: { unlink, rmdir: vi.fn() } });
    expect(first.failed).toBe(1);
    expect(rowCount()).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'trash_purge_failed', count: 1 }),
      expect.any(String),
    );
    const failLog = logger.error.mock.calls[0][0] as { examples: Array<Record<string, unknown>> };
    expect(failLog.examples[0]).toMatchObject({
      id: e.id,
      trashPath: e.trash_path,
      errno: 'EACCES',
    });

    const second = await run();
    expect(second.deleted).toBe(1);
    expect(rowCount()).toBe(0);
  });

  it('failing entries do not starve later ones', async () => {
    const failing = Array.from({ length: 5 }, () => addEntry({}));
    const good = addEntry({});
    const err = Object.assign(new Error('denied'), { code: 'EACCES' });
    const failingPaths = new Set(failing.map((f) => f.trash_path));
    const unlink = vi.fn(async (p: string) => {
      if (failingPaths.has(p)) throw err;
      await fs.promises.unlink(p);
    });
    const result = await run({
      fs: { unlink, rmdir: fs.promises.rmdir },
      batchSize: 2,
      maxBatches: 10,
    });
    expect(result.failed).toBe(5);
    expect(result.deleted).toBe(1);
    expect(fs.existsSync(good.trash_path)).toBe(false);
    expect(rowCount()).toBe(5);
  });

  it('refuses paths outside the trash layout', async () => {
    const outside = path.join(root, 'movies', 'film.mkv');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, 'x');
    addEntry({ trashPath: outside, withFile: false });
    const result = await run();
    expect(result.skipped).toBe(1);
    expect(fs.existsSync(outside)).toBe(true);
    expect(rowCount()).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'trash_purge_failed' }),
      expect.any(String),
    );
    const failLog = logger.error.mock.calls[0][0] as { examples: Array<Record<string, unknown>> };
    expect(failLog.examples[0]).toMatchObject({ reason: 'trash_path_unexpected' });
  });

  it('refuses trash_path equal to original_path', async () => {
    const p = trashPathFor('/media/a.mkv', root, 7, 1_700_000_000);
    addEntry({ trashPath: p, originalPath: p });
    const result = await run();
    expect(result.skipped).toBe(1);
    expect(fs.existsSync(p)).toBe(true);
  });

  it('skips an entry restored after listing', async () => {
    const e = addEntry({});
    const realFindById = repo.findById.bind(repo);
    const findById = vi.fn((id: number) => {
      repo.restore(id);
      return realFindById(id);
    });
    const result = await run({ repo: { ...repo, findById } });
    expect(result.deleted).toBe(0);
    expect(fs.existsSync(e.trash_path)).toBe(true);
    expect(rowCount()).toBe(1);
  });

  it('does not overlap runs', async () => {
    addEntry({});
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const unlink = vi.fn(async (p: string) => {
      await gate;
      await fs.promises.unlink(p);
    });
    const first = run({ fs: { unlink, rmdir: fs.promises.rmdir } });
    const second = await run({ fs: { unlink, rmdir: fs.promises.rmdir } });
    expect(second.ran).toBe(false);
    release();
    const done = await first;
    expect(done.deleted).toBe(1);
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('aggregates failures into one log line', async () => {
    for (let i = 0; i < 15; i++) addEntry({});
    const err = Object.assign(new Error('denied'), { code: 'EIO' });
    const unlink = vi.fn().mockRejectedValue(err);
    const result = await run({ fs: { unlink, rmdir: vi.fn() } });
    expect(result.failed).toBe(15);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const failLog = logger.error.mock.calls[0][0] as { count: number; examples: unknown[] };
    expect(failLog.count).toBe(15);
    expect(failLog.examples).toHaveLength(10);
  });

  it('TRASH_PURGE_DISABLED=1 skips purging and logs once', async () => {
    process.env.TRASH_PURGE_DISABLED = '1';
    const e = addEntry({});
    await run();
    await run();
    expect(fs.existsSync(e.trash_path)).toBe(true);
    expect(rowCount()).toBe(1);
    const infoCalls = logger.info.mock.calls.filter(
      (c) => (c[0] as { action?: string }).action === 'trash_purge_resolved',
    );
    expect(infoCalls).toHaveLength(1);
    expect(infoCalls[0][0]).toMatchObject({ enabled: false });
  });

  it.each(['0', 'true', '', ' '])('other values keep purging (%j)', (v) => {
    expect(resolveTrashPurgeEnabled(v)).toBe(true);
  });

  it('unset keeps purging', () => {
    expect(resolveTrashPurgeEnabled(undefined)).toBe(true);
    expect(resolveTrashPurgeEnabled('1')).toBe(false);
  });
});

describe('isPurgeableTrashPath', () => {
  it.each([
    '/media/show/Episode 01.mkv',
    '/media/Filme/Überraschung – Teil 2.mkv',
    '/media/show/.hidden.mkv',
    `/media/show/${'a'.repeat(200)}.mkv`,
  ])('accepts every path trashPathFor builds (%s)', (original) => {
    for (const root of ['/mnt/cache/x265-butler', '/media/show/.x265-butler-trash', '/']) {
      const p = trashPathFor(original, root, 12345, 1_700_000_000);
      expect(isPurgeableTrashPath(p, original)).toBe(true);
    }
  });

  it.each([
    'trash/1-20231114221320/a.mkv',
    '/x/trash/1-20231114221320/../../a.mkv',
    '/x/trash/../trash/1-20231114221320/a.mkv',
    '/x/trash/abc-20231114221320/a.mkv',
    '/x/trash/1-2023/a.mkv',
    '/x/notrash/1-20231114221320/a.mkv',
    '/x/trash/1-20231114221320/',
    '/media/film.mkv',
  ])('rejects relative and dot-dot paths and other layouts (%s)', (p) => {
    expect(isPurgeableTrashPath(p, '/media/film.mkv')).toBe(false);
  });
});
