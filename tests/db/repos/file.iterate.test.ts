// 05-04 T1.F: fileRepo.iterateAll + countByQuery contract tests.
// Phase 5 Plan 05-04 — AC-7 + audit M1.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo, type ListOptions } from '@/src/lib/db/repos/file';
import type { FileUpsertInput } from '@/src/lib/db/schema';

type Db = InstanceType<typeof Database>;

const baseInput = (overrides: Partial<FileUpsertInput> = {}): FileUpsertInput => ({
  path: '/media/movies/example.mp4',
  size_bytes: 100_000_000,
  mtime: 1_700_000_000,
  content_hash: 'a'.repeat(64),
  codec: 'h264',
  bitrate: 5_000_000,
  duration_seconds: 7200,
  width: 1920,
  height: 1080,
  container: 'mov',
  last_scanned_at: 1_700_000_500,
  share_id: null,
  ...overrides,
});

const defaultOpts: ListOptions = {
  page: 1,
  size: 100,
  sort: 'size',
  dir: 'desc',
};

describe('fileRepo.iterateAll + countByQuery', () => {
  let db: Db;
  let repo: FileRepo;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    repo = makeFileRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('iterateAll yields rows one at a time as IteratorResult<FileRow>', () => {
    repo.upsertByPath(baseInput({ path: '/a.mp4', size_bytes: 100 }));
    repo.upsertByPath(baseInput({ path: '/b.mp4', size_bytes: 200 }));
    repo.upsertByPath(baseInput({ path: '/c.mp4', size_bytes: 50 }));

    const iter = repo.iterateAll(defaultOpts);
    const first = iter.next();
    expect(first.done).toBe(false);
    expect(first.value.size_bytes).toBe(200); // size desc

    const second = iter.next();
    expect(second.done).toBe(false);
    expect(second.value.size_bytes).toBe(100);

    const third = iter.next();
    expect(third.done).toBe(false);
    expect(third.value.size_bytes).toBe(50);

    const end = iter.next();
    expect(end.done).toBe(true);
  });

  it('iterateAll filter (q) matches listPaginated under same opts', () => {
    repo.upsertByPath(baseInput({ path: '/movies/foo.mp4' }));
    repo.upsertByPath(baseInput({ path: '/movies/bar.mp4' }));
    repo.upsertByPath(baseInput({ path: '/shows/baz.mp4' }));
    const opts: ListOptions = { ...defaultOpts, q: 'movies', size: 200 };

    const iterPaths = Array.from(repo.iterateAll(opts), (r) => r.path);
    const listPaths = repo.listPaginated(opts).rows.map((r) => r.path);
    expect(iterPaths.sort()).toEqual(listPaths.sort());
  });

  it('iterateAll filter (status) matches listPaginated', () => {
    repo.upsertByPath(baseInput({ path: '/a.mp4' }));
    repo.upsertByPath(baseInput({ path: '/b.mp4' }));
    const inserted = repo.upsertByPath(baseInput({ path: '/c.mp4' }));
    repo.setStatus(inserted.id, 'failed', inserted.version);
    const opts: ListOptions = { ...defaultOpts, status: 'failed', size: 200 };

    const iterPaths = Array.from(repo.iterateAll(opts), (r) => r.path);
    const listPaths = repo.listPaginated(opts).rows.map((r) => r.path);
    expect(iterPaths).toEqual(listPaths);
    expect(iterPaths).toEqual(['/c.mp4']);
  });

  it('iterateAll respects includeVanished default-hidden', () => {
    const a = repo.upsertByPath(baseInput({ path: '/a.mp4' }));
    repo.upsertByPath(baseInput({ path: '/b.mp4' }));
    // Mark /a.mp4 as vanished by directly calling setStatus.
    repo.setStatus(a.id, 'vanished', a.version);

    const hidden = Array.from(repo.iterateAll(defaultOpts), (r) => r.path);
    expect(hidden).toEqual(['/b.mp4']);

    const shown = Array.from(
      repo.iterateAll({ ...defaultOpts, includeVanished: true }),
      (r) => r.path,
    );
    expect(shown.sort()).toEqual(['/a.mp4', '/b.mp4']);
  });

  it('iterateAll sort + dir matches listPaginated row order', () => {
    repo.upsertByPath(baseInput({ path: '/a.mp4', bitrate: 1000 }));
    repo.upsertByPath(baseInput({ path: '/b.mp4', bitrate: 5000 }));
    repo.upsertByPath(baseInput({ path: '/c.mp4', bitrate: 3000 }));
    const opts: ListOptions = { ...defaultOpts, sort: 'bitrate', dir: 'asc', size: 200 };

    const iterPaths = Array.from(repo.iterateAll(opts), (r) => r.path);
    const listPaths = repo.listPaginated(opts).rows.map((r) => r.path);
    expect(iterPaths).toEqual(listPaths);
  });

  it('countByQuery matches Array.from(iterateAll).length under all filter combos', () => {
    repo.upsertByPath(baseInput({ path: '/a.mp4' }));
    repo.upsertByPath(baseInput({ path: '/b.mp4' }));
    const c = repo.upsertByPath(baseInput({ path: '/c.mp4' }));
    repo.setStatus(c.id, 'failed', c.version);

    const opts1: ListOptions = { ...defaultOpts, size: 200 };
    expect(repo.countByQuery(opts1)).toBe(Array.from(repo.iterateAll(opts1)).length);

    const opts2: ListOptions = { ...defaultOpts, status: 'failed', size: 200 };
    expect(repo.countByQuery(opts2)).toBe(Array.from(repo.iterateAll(opts2)).length);
  });

  it('iter.return() releases the underlying statement without throwing', () => {
    repo.upsertByPath(baseInput({ path: '/a.mp4' }));
    repo.upsertByPath(baseInput({ path: '/b.mp4' }));
    const iter = repo.iterateAll(defaultOpts);
    iter.next();
    expect(() => iter.return?.()).not.toThrow();
  });

  it('audit M1: thrown body releases statement when iter.return() is called', () => {
    for (let i = 0; i < 5; i++) {
      repo.upsertByPath(baseInput({ path: `/row-${i}.mp4`, size_bytes: i + 1 }));
    }
    const iter = repo.iterateAll(defaultOpts);
    let firstSize: number | undefined;
    try {
      const first = iter.next();
      firstSize = first.value.size_bytes;
      throw new Error('synthetic mid-iteration failure');
    } catch (err) {
      iter.return?.();
      expect(err).toBeInstanceOf(Error);
    }
    expect(firstSize).toBeDefined();

    // After explicit return(), the underlying statement is released; a fresh
    // iterate completes without "database connection is busy" errors.
    const fresh = repo.iterateAll(defaultOpts);
    const next = fresh.next();
    expect(next.done).toBe(false);
    expect(next.value.size_bytes).toBe(5); // size desc → largest first
    fresh.return?.();
  });

  it('countByQuery=0 + iterateAll empty when no rows match', () => {
    repo.upsertByPath(baseInput({ path: '/a.mp4' }));
    const opts: ListOptions = { ...defaultOpts, q: 'nonexistent', size: 200 };
    expect(repo.countByQuery(opts)).toBe(0);
    expect(Array.from(repo.iterateAll(opts))).toEqual([]);
  });
});
