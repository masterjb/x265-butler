// 15-01 T4: storageRepo aggregation contract — KPIs, buckets, codec-pie,
// shares-table, top-folders. In-memory better-sqlite3 + migrate + direct
// makeStorageRepo construction. Mirrors share-repo.test.ts setup pattern.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeStorageRepo, type StorageRepo } from '@/src/lib/db/repos/storage';
import { makeShareRepo, type ShareRepo } from '@/src/lib/db/repos/share';

type Db = InstanceType<typeof Database>;

interface SeedFile {
  path: string;
  size_bytes: number;
  codec: string | null;
  status?: string;
  share_id: number | null;
}

function freshDb(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  // 0026 backfill seeds a "Library" share from settings; reset for clean slate.
  db.prepare('DELETE FROM shares').run();
  db.prepare("DELETE FROM sqlite_sequence WHERE name='shares'").run();
  return db;
}

function insertShare(db: Db, name: string, path: string): number {
  const r = db
    .prepare(
      `INSERT INTO shares (name, path, min_size_mb, extensions_csv, max_depth)
       VALUES (?, ?, 0, 'mkv,mp4', NULL) RETURNING id`,
    )
    .get(name, path) as { id: number };
  return r.id;
}

function insertFile(db: Db, f: SeedFile): void {
  db.prepare(
    `INSERT INTO file
       (path, size_bytes, mtime, content_hash, codec, bitrate, duration_seconds,
        width, height, container, last_scanned_at, status, share_id)
     VALUES (?, ?, 0, '0', ?, NULL, NULL, NULL, NULL, NULL, 0, ?, ?)`,
  ).run(f.path, f.size_bytes, f.codec, f.status ?? 'pending', f.share_id);
}

function insertJob(
  db: Db,
  fileId: number,
  bytesIn: number,
  bytesOut: number,
  status = 'done',
): void {
  db.prepare(
    `INSERT INTO job (file_id, status, bytes_in, bytes_out, finished_at, created_at)
     VALUES (?, ?, ?, ?, 0, 0)`,
  ).run(fileId, status, bytesIn, bytesOut);
}

describe('storageRepo aggregation contract', () => {
  let db: Db;
  let repo: StorageRepo;
  let shareRepo: ShareRepo;

  beforeEach(() => {
    db = freshDb();
    shareRepo = makeShareRepo(db);
    repo = makeStorageRepo(db, { shareRepo });
  });

  afterEach(() => {
    db.close();
  });

  describe('getKpis', () => {
    it('cross-share totals across multi-share corpus', () => {
      const a = insertShare(db, 'A', '/mnt/a');
      const b = insertShare(db, 'B', '/mnt/b');
      insertFile(db, { path: '/mnt/a/X/1.mkv', size_bytes: 100, codec: 'hevc', share_id: a });
      insertFile(db, { path: '/mnt/a/X/2.mkv', size_bytes: 200, codec: 'h264', share_id: a });
      insertFile(db, { path: '/mnt/b/Y/3.mkv', size_bytes: 50, codec: 'hevc', share_id: b });

      const kpis = repo.getKpis({ shareId: 'all' });
      expect(kpis.totalSizeBytes).toBe(350);
      // largestFolder = /mnt/a/X (300 vs 50)
      expect(kpis.largestFolder).toMatchObject({ path: 'X', sizeBytes: 300, shareId: a });
      // legacyCodec = 200 / 350 ≈ 57.14
      expect(kpis.legacyCodecPercent).toBeCloseTo(57.14, 1);
    });

    it('share-filter narrows totalSizeBytes + largestFolder; mostOptimizedShare stays cross-share (A6)', () => {
      const a = insertShare(db, 'A', '/mnt/a');
      const b = insertShare(db, 'B', '/mnt/b');
      // B has 100% HEVC → should win mostOptimizedShare regardless of filter.
      insertFile(db, { path: '/mnt/a/X/1.mkv', size_bytes: 1000, codec: 'h264', share_id: a });
      insertFile(db, { path: '/mnt/b/Y/2.mkv', size_bytes: 100, codec: 'hevc', share_id: b });

      const kpis = repo.getKpis({ shareId: a });
      expect(kpis.totalSizeBytes).toBe(1000);
      expect(kpis.legacyCodecPercent).toBe(100);
      expect(kpis.mostOptimizedShare?.shareId).toBe(b);
    });

    it('SR2: mostOptimizedShare === null when no share has any HEVC bytes', () => {
      const a = insertShare(db, 'A', '/mnt/a');
      const b = insertShare(db, 'B', '/mnt/b');
      const c = insertShare(db, 'C', '/mnt/c');
      insertFile(db, { path: '/mnt/a/x.mp4', size_bytes: 100, codec: 'h264', share_id: a });
      insertFile(db, { path: '/mnt/b/x.mp4', size_bytes: 100, codec: 'av1', share_id: b });
      insertFile(db, { path: '/mnt/c/x.mp4', size_bytes: 100, codec: null, share_id: c });

      const kpis = repo.getKpis({ shareId: 'all' });
      expect(kpis.mostOptimizedShare).toBeNull();
    });

    it('SR4 canonical empty-state: empty DB → zeroed kpis (no exceptions)', () => {
      const kpis = repo.getKpis({ shareId: 'all' });
      expect(kpis.totalSizeBytes).toBe(0);
      expect(kpis.largestFolder).toBeNull();
      expect(kpis.mostOptimizedShare).toBeNull();
      expect(kpis.legacyCodecPercent).toBe(0);
    });
  });

  describe('getSizeBuckets', () => {
    it('AC-2: 4 fixed buckets cross-share with edge-case boundary distribution', () => {
      const a = insertShare(db, 'A', '/mnt/a');
      // bucket boundaries: <100MB (0..99MB), 100MB-1GB, 1-10GB, 10GB+
      const MB = 1024 * 1024;
      insertFile(db, { path: '/mnt/a/sm.mkv', size_bytes: 50 * MB, codec: 'hevc', share_id: a });
      insertFile(db, { path: '/mnt/a/md.mkv', size_bytes: 500 * MB, codec: 'hevc', share_id: a });
      insertFile(db, {
        path: '/mnt/a/lg.mkv',
        size_bytes: 5 * 1024 * MB,
        codec: 'hevc',
        share_id: a,
      });
      insertFile(db, {
        path: '/mnt/a/xl.mkv',
        size_bytes: 50 * 1024 * MB,
        codec: 'hevc',
        share_id: a,
      });

      const buckets = repo.getSizeBuckets({ shareId: 'all' });
      expect(buckets).toHaveLength(4);
      const byLabel = Object.fromEntries(buckets.map((b) => [b.label, b]));
      expect(byLabel['<100MB'].fileCount).toBe(1);
      expect(byLabel['100MB-1GB'].fileCount).toBe(1);
      expect(byLabel['1-10GB'].fileCount).toBe(1);
      expect(byLabel['10GB+'].fileCount).toBe(1);
    });

    it('SR4 canonical empty-state: empty DB → 4 zero-rows (NOT empty array)', () => {
      const buckets = repo.getSizeBuckets({ shareId: 'all' });
      expect(buckets).toHaveLength(4);
      for (const b of buckets) {
        expect(b.fileCount).toBe(0);
        expect(b.totalBytes).toBe(0);
      }
    });

    it('share-filter scopes buckets to one share', () => {
      const a = insertShare(db, 'A', '/mnt/a');
      const b = insertShare(db, 'B', '/mnt/b');
      const MB = 1024 * 1024;
      insertFile(db, { path: '/mnt/a/1.mkv', size_bytes: 50 * MB, codec: 'hevc', share_id: a });
      insertFile(db, { path: '/mnt/b/2.mkv', size_bytes: 50 * MB, codec: 'hevc', share_id: b });

      const aBuckets = repo.getSizeBuckets({ shareId: a });
      const small = aBuckets.find((b) => b.label === '<100MB')!;
      expect(small.fileCount).toBe(1);
    });
  });

  describe('getCodecPie', () => {
    it('groups NULL codec into unknown bucket', () => {
      const a = insertShare(db, 'A', '/mnt/a');
      insertFile(db, { path: '/mnt/a/1.mkv', size_bytes: 100, codec: 'hevc', share_id: a });
      insertFile(db, { path: '/mnt/a/2.mkv', size_bytes: 200, codec: 'h264', share_id: a });
      insertFile(db, { path: '/mnt/a/3.mkv', size_bytes: 50, codec: null, share_id: a });

      const codecs = repo.getCodecPie({ shareId: 'all' });
      const byCodec = Object.fromEntries(codecs.map((c) => [c.codec, c]));
      expect(byCodec.hevc.totalBytes).toBe(100);
      expect(byCodec.h264.totalBytes).toBe(200);
      expect(byCodec.unknown.totalBytes).toBe(50);
    });

    it('SR4 canonical empty-state: empty DB → empty array', () => {
      const codecs = repo.getCodecPie({ shareId: 'all' });
      expect(codecs).toEqual([]);
    });
  });

  describe('getSharesTable', () => {
    it('one row per share + savingsBytes from done-smaller jobs', () => {
      const a = insertShare(db, 'A', '/mnt/a');
      const b = insertShare(db, 'B', '/mnt/b');
      insertFile(db, {
        path: '/mnt/a/movies/1.mkv',
        size_bytes: 500,
        codec: 'hevc',
        status: 'done-smaller',
        share_id: a,
      });
      insertFile(db, {
        path: '/mnt/b/y/2.mkv',
        size_bytes: 1000,
        codec: 'h264',
        share_id: b,
      });
      // job for the 500-byte file: was 1000, encoded to 500 → savings 500
      const fileId = db.prepare("SELECT id FROM file WHERE path = '/mnt/a/movies/1.mkv'").get() as {
        id: number;
      };
      insertJob(db, fileId.id, 1000, 500);

      const rows = repo.getSharesTable();
      expect(rows).toHaveLength(2);
      const aRow = rows.find((r) => r.shareId === a)!;
      expect(aRow.totalSizeBytes).toBe(500);
      expect(aRow.hevcPercent).toBe(100);
      expect(aRow.savingsBytes).toBe(500);
      expect(aRow.largestFolder?.path).toBe('movies');

      const bRow = rows.find((r) => r.shareId === b)!;
      expect(bRow.savingsBytes).toBe(0);
    });

    it('SR3 orphan-row PINNED shape appended last when share_id IS NULL files exist', () => {
      const a = insertShare(db, 'A', '/mnt/a');
      insertFile(db, { path: '/mnt/a/1.mkv', size_bytes: 100, codec: 'hevc', share_id: a });
      insertFile(db, {
        path: '/somewhere/orphan.mkv',
        size_bytes: 200,
        codec: 'h264',
        share_id: null,
      });

      const rows = repo.getSharesTable();
      expect(rows).toHaveLength(2);
      const orphan = rows[rows.length - 1];
      // SR3 pinned shape — fields validated exactly.
      expect(orphan.shareId).toBeNull();
      expect(orphan.sharePath).toBeNull();
      expect(orphan.totalSizeBytes).toBe(200);
      expect(orphan.hevcPercent).toBe(0); // h264 file → 0% HEVC
      expect(orphan.savingsBytes).toBe(0);
      expect(orphan.largestFolder).toBeNull();
    });

    it('SR4 canonical empty-state: 0 shares + 0 orphans → empty array', () => {
      const rows = repo.getSharesTable();
      expect(rows).toEqual([]);
    });
  });

  describe('getTopFolders', () => {
    it('depth=1 cross-share groups top-level folder per share', () => {
      const a = insertShare(db, 'A', '/mnt/a');
      const b = insertShare(db, 'B', '/mnt/b');
      insertFile(db, { path: '/mnt/a/Movies/1.mkv', size_bytes: 100, codec: 'hevc', share_id: a });
      insertFile(db, { path: '/mnt/a/Movies/2.mkv', size_bytes: 200, codec: 'hevc', share_id: a });
      insertFile(db, { path: '/mnt/b/TV/x.mkv', size_bytes: 500, codec: 'hevc', share_id: b });

      const result = repo.getTopFolders({ shareId: 'all', depth: 1 });
      expect(result.truncated).toBe(false);
      expect(result.rows[0]).toMatchObject({ path: 'TV', sizeBytes: 500, shareId: b });
      expect(result.rows[1]).toMatchObject({ path: 'Movies', sizeBytes: 300, shareId: a });
    });

    it('depth=2 aggregates at second segment; depth=5 caps at file folder', () => {
      const a = insertShare(db, 'A', '/mnt/a');
      insertFile(db, { path: '/mnt/a/A/B/C/x.mkv', size_bytes: 100, codec: 'hevc', share_id: a });
      insertFile(db, { path: '/mnt/a/A/B/D/y.mkv', size_bytes: 200, codec: 'hevc', share_id: a });
      insertFile(db, { path: '/mnt/a/A/B/C/z.mkv', size_bytes: 50, codec: 'hevc', share_id: a });

      const d2 = repo.getTopFolders({ shareId: 'all', depth: 2 });
      expect(d2.rows).toHaveLength(1);
      expect(d2.rows[0]).toMatchObject({ path: 'A/B', sizeBytes: 350 });

      const d5 = repo.getTopFolders({ shareId: 'all', depth: 5 });
      const byPath = Object.fromEntries(d5.rows.map((r) => [r.path, r]));
      expect(byPath['A/B/C'].sizeBytes).toBe(150);
      expect(byPath['A/B/D'].sizeBytes).toBe(200);
    });

    it('share-filter excludes rows from other shares', () => {
      const a = insertShare(db, 'A', '/mnt/a');
      const b = insertShare(db, 'B', '/mnt/b');
      insertFile(db, { path: '/mnt/a/X/1.mkv', size_bytes: 100, codec: 'hevc', share_id: a });
      insertFile(db, { path: '/mnt/b/Y/2.mkv', size_bytes: 999, codec: 'hevc', share_id: b });

      const result = repo.getTopFolders({ shareId: a, depth: 1 });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].shareId).toBe(a);
    });

    it('SR4 canonical empty-state: empty DB → { rows: [], truncated: false }', () => {
      const result = repo.getTopFolders({ shareId: 'all', depth: 2 });
      expect(result.rows).toEqual([]);
      expect(result.truncated).toBe(false);
    });

    it('SR1 DoS-budget: >50_000 rows trips truncated:true; rows still capped at 10', () => {
      const a = insertShare(db, 'A', '/mnt/a');
      // Bulk insert via transaction for speed. Each file gets a unique top-folder
      // so cardinality matches row count post-aggregate at depth=1.
      const insert = db.prepare(
        `INSERT INTO file
           (path, size_bytes, mtime, content_hash, codec, bitrate, duration_seconds,
            width, height, container, last_scanned_at, status, share_id)
         VALUES (?, ?, 0, '0', 'hevc', NULL, NULL, NULL, NULL, NULL, 0, 'pending', ?)`,
      );
      const tx = db.transaction((count: number) => {
        for (let i = 0; i < count; i++) {
          insert.run(`/mnt/a/folder${i}/file.mkv`, 1000, a);
        }
      });
      tx(50_001);

      const result = repo.getTopFolders({ shareId: 'all', depth: 1, limit: 10 });
      expect(result.truncated).toBe(true);
      expect(result.rows.length).toBeLessThanOrEqual(10);
    }, 30_000);
  });

  describe('EXPLAIN-perf gate (AC-9)', () => {
    it('share-filtered file queries use the share_id index (no SCAN file)', () => {
      const a = insertShare(db, 'A', '/mnt/a');
      insertFile(db, { path: '/mnt/a/x.mkv', size_bytes: 100, codec: 'hevc', share_id: a });
      // EXPLAIN QUERY PLAN — assert the index is used.
      const plan = db
        .prepare('EXPLAIN QUERY PLAN SELECT * FROM file WHERE share_id = ?')
        .all(a) as Array<{ detail: string }>;
      const detail = plan.map((p) => p.detail).join(' | ');
      expect(detail).toMatch(/USING (INDEX|INTEGER PRIMARY KEY)/i);
    });
  });
});
