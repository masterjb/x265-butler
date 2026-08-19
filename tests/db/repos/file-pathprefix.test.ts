// 15-01 T4: fileRepo.listPaginated pathPrefix filter — AC-6 + AC-8.
// Covers STARTS-WITH semantics, LIKE-wildcard escape, SQL-injection-safety,
// AND-composition with share/status/q.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo, type ListOptions } from '@/src/lib/db/repos/file';
import type { FileUpsertInput } from '@/src/lib/db/schema';

type Db = InstanceType<typeof Database>;

const defaultOpts: ListOptions = {
  page: 1,
  size: 100,
  sort: 'size',
  dir: 'desc',
};

const baseInput = (overrides: Partial<FileUpsertInput> = {}): FileUpsertInput => ({
  path: '/mnt/m/x.mkv',
  size_bytes: 100,
  mtime: 0,
  content_hash: '0',
  codec: 'hevc',
  bitrate: null,
  duration_seconds: null,
  width: null,
  height: null,
  container: null,
  last_scanned_at: 0,
  share_id: null,
  ...overrides,
});

describe('fileRepo.listPaginated pathPrefix filter', () => {
  let db: Db;
  let repo: FileRepo;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    repo = makeFileRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  it('AC-6 STARTS WITH: pathPrefix /mnt/movies/A returns A + A-subtree, excludes C', () => {
    repo.upsertByPath(baseInput({ path: '/mnt/movies/A/1.mkv' }));
    repo.upsertByPath(baseInput({ path: '/mnt/movies/A/B/2.mkv' }));
    repo.upsertByPath(baseInput({ path: '/mnt/movies/C/3.mkv' }));

    const result = repo.listPaginated({ ...defaultOpts, pathPrefix: '/mnt/movies/A' });
    const paths = result.rows.map((r) => r.path).sort();
    expect(paths).toEqual(['/mnt/movies/A/1.mkv', '/mnt/movies/A/B/2.mkv']);
    expect(result.total).toBe(2);
  });

  it('AC-6 trailing-slash idempotent: /mnt/movies/A/ behaves identically', () => {
    repo.upsertByPath(baseInput({ path: '/mnt/movies/A/1.mkv' }));
    repo.upsertByPath(baseInput({ path: '/mnt/movies/A2.mkv' }));

    const a = repo.listPaginated({ ...defaultOpts, pathPrefix: '/mnt/movies/A' });
    const aSlash = repo.listPaginated({ ...defaultOpts, pathPrefix: '/mnt/movies/A/' });
    expect(a.total).toBe(aSlash.total);
    expect(a.total).toBe(1);
  });

  it('AC-6 STARTS WITH does NOT pick up sibling-prefix collisions (Already vs A/)', () => {
    repo.upsertByPath(baseInput({ path: '/mnt/movies/A/1.mkv' }));
    repo.upsertByPath(baseInput({ path: '/mnt/movies/Already.mkv' }));

    const result = repo.listPaginated({ ...defaultOpts, pathPrefix: '/mnt/movies/A' });
    expect(result.total).toBe(1);
    expect(result.rows[0].path).toBe('/mnt/movies/A/1.mkv');
  });

  it('AC-8 ESCAPE: SQL wildcards (% and _) in pathPrefix treated as literals', () => {
    repo.upsertByPath(baseInput({ path: '/mnt/foo%bar/x.mkv' }));
    repo.upsertByPath(baseInput({ path: '/mnt/fooABCbar/x.mkv' })); // would match /mnt/foo%bar IF % were a wildcard
    repo.upsertByPath(baseInput({ path: '/mnt/foo_baz/y.mkv' }));
    repo.upsertByPath(baseInput({ path: '/mnt/fooXbaz/y.mkv' })); // would match /mnt/foo_baz IF _ were a wildcard

    const pct = repo.listPaginated({ ...defaultOpts, pathPrefix: '/mnt/foo%bar' });
    expect(pct.total).toBe(1);
    expect(pct.rows[0].path).toBe('/mnt/foo%bar/x.mkv');

    const usc = repo.listPaginated({ ...defaultOpts, pathPrefix: '/mnt/foo_baz' });
    expect(usc.total).toBe(1);
    expect(usc.rows[0].path).toBe('/mnt/foo_baz/y.mkv');
  });

  it('AC-8 SQL-injection payloads bound safely; files table unchanged', () => {
    repo.upsertByPath(baseInput({ path: '/mnt/safe/1.mkv' }));
    const before = (db.prepare('SELECT COUNT(*) AS c FROM file').get() as { c: number }).c;

    const payloads = [
      "'; DROP TABLE file; --",
      "foo' OR '1'='1",
      "foo%' UNION SELECT * FROM setting --",
    ];
    for (const p of payloads) {
      const result = repo.listPaginated({ ...defaultOpts, pathPrefix: p });
      expect(result.total).toBe(0);
    }

    const after = (db.prepare('SELECT COUNT(*) AS c FROM file').get() as { c: number }).c;
    expect(after).toBe(before);
    // Table still exists — DROP TABLE payload was bound as a string literal.
    expect(after).toBeGreaterThan(0);
  });

  it('empty pathPrefix treated as no filter', () => {
    repo.upsertByPath(baseInput({ path: '/a/1.mkv' }));
    repo.upsertByPath(baseInput({ path: '/b/2.mkv' }));

    const result = repo.listPaginated({ ...defaultOpts, pathPrefix: '' });
    expect(result.total).toBe(2);
  });

  it('AND-composition: pathPrefix + status filter applied together', () => {
    repo.upsertByPath(baseInput({ path: '/mnt/a/1.mkv' }));
    repo.upsertByPath(baseInput({ path: '/mnt/a/2.mkv' }));
    // flip the second row to a non-pending status
    const r2 = db.prepare("SELECT id, version FROM file WHERE path = '/mnt/a/2.mkv'").get() as {
      id: number;
      version: number;
    };
    repo.setStatus(r2.id, 'done-smaller', r2.version);

    const all = repo.listPaginated({ ...defaultOpts, pathPrefix: '/mnt/a' });
    expect(all.total).toBe(2);

    const filtered = repo.listPaginated({
      ...defaultOpts,
      pathPrefix: '/mnt/a',
      status: 'done-smaller',
    });
    expect(filtered.total).toBe(1);
    expect(filtered.rows[0].path).toBe('/mnt/a/2.mkv');
  });

  it('AND-composition: pathPrefix + share-id filter applied together', () => {
    const aId = (
      db
        .prepare(
          `INSERT INTO shares (name, path, min_size_mb, extensions_csv, max_depth)
           VALUES ('A', '/mnt/a', 0, 'mkv', NULL) RETURNING id`,
        )
        .get() as { id: number }
    ).id;
    const bId = (
      db
        .prepare(
          `INSERT INTO shares (name, path, min_size_mb, extensions_csv, max_depth)
           VALUES ('B', '/mnt/b', 0, 'mkv', NULL) RETURNING id`,
        )
        .get() as { id: number }
    ).id;
    repo.upsertByPath(baseInput({ path: '/mnt/a/X/1.mkv', share_id: aId }));
    repo.upsertByPath(baseInput({ path: '/mnt/b/X/2.mkv', share_id: bId }));

    const result = repo.listPaginated({
      ...defaultOpts,
      pathPrefix: '/mnt',
      shareId: aId,
    });
    expect(result.total).toBe(1);
    expect(result.rows[0].path).toBe('/mnt/a/X/1.mkv');
  });

  it('countByQuery + iterateAll honor pathPrefix identically to listPaginated', () => {
    repo.upsertByPath(baseInput({ path: '/mnt/m/1.mkv' }));
    repo.upsertByPath(baseInput({ path: '/mnt/m/2.mkv' }));
    repo.upsertByPath(baseInput({ path: '/elsewhere/3.mkv' }));

    const opts = { ...defaultOpts, pathPrefix: '/mnt/m' };
    expect(repo.countByQuery(opts)).toBe(2);
    expect(Array.from(repo.iterateAll(opts))).toHaveLength(2);
  });
});
