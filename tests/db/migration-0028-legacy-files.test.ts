// 16-05 audit S9 + AC-10: legacy library files invariant.
//
// Migration 0028 changes ONLY the `setting` table (UPDATE WHERE legacy-
// default). The `file` table — including any rows whose paths end in
// '.x265.mkv' from pre-16-05 encode outputs — MUST be untouched.
//
// Two layers verified:
//   1. Row count is preserved (no DELETE leakage)
//   2. Path strings byte-identical (no UPDATE leakage)
//
// AC-10 also calls for asserting scanner re-runs do not re-encode these
// rows — that contract is owned by the sidecar/skip-pipeline test suite
// (10-01) which already covers it independently per the boundary list in
// the 16-05 PLAN.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

import { migrate } from '@/src/lib/db/migrate';

type Db = InstanceType<typeof Database>;

describe('migration 0028 — legacy library files untouched (16-05 AC-10)', () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('file table rows whose paths end in .x265.mkv survive migration 0028 byte-identical', () => {
    // Apply all migrations first to materialize the `file` table.
    migrate(db);

    const legacyPaths = [
      '/media/movies/Foo (2023).x265.mkv',
      '/media/shows/Bar S01E01.x265.mkv',
      '/media/movies/Baz.x265.mkv',
    ];

    const insertFile = db.prepare(
      `INSERT INTO file (
         path, size_bytes, mtime, content_hash, codec, bitrate,
         duration_seconds, width, height, container, last_scanned_at, share_id
       ) VALUES (?, 1024, 1700000000, 'sha:abc', 'hevc', 5000000,
                 7200, 1920, 1080, 'matroska', 1700000000, NULL)`,
    );
    for (const p of legacyPaths) insertFile.run(p);

    const beforeCount = (db.prepare('SELECT COUNT(*) AS c FROM file').get() as { c: number }).c;
    expect(beforeCount).toBe(legacyPaths.length);

    // Force re-apply migration 0028 by deleting its applied-marker so the
    // runner sees it as pending again. (The SQL is idempotent on
    // already-migrated installs: UPDATE WHERE value='.x265.mkv' is a
    // no-op once the row is at '-x265' — but the test is about the FILE
    // table invariant, not the setting outcome.)
    db.prepare('DELETE FROM schema_migrations WHERE version = 28').run();
    migrate(db);

    const afterCount = (db.prepare('SELECT COUNT(*) AS c FROM file').get() as { c: number }).c;
    expect(afterCount).toBe(beforeCount);

    const afterPaths = (
      db.prepare('SELECT path FROM file ORDER BY path').all() as { path: string }[]
    ).map((r) => r.path);
    expect(afterPaths.sort()).toEqual([...legacyPaths].sort());
  });

  it('file table rows whose paths end in .x265.mp4 survive migration 0028 byte-identical', () => {
    // Sibling assertion: the LEGACY default sentinel is only '.x265.mkv'
    // but the file table may contain '.x265.mp4' encoded outputs from
    // operators who chose output_container='mp4' pre-16-05. These rows
    // are also unaffected by 0028's setting-table-only UPDATE.
    migrate(db);
    const path = '/media/movies/Qux (2024).x265.mp4';
    db.prepare(
      `INSERT INTO file (
         path, size_bytes, mtime, content_hash, codec, bitrate,
         duration_seconds, width, height, container, last_scanned_at, share_id
       ) VALUES (?, 1024, 1700000000, 'sha:xyz', 'hevc', 5000000,
                 7200, 1920, 1080, 'mov,mp4,m4a,3gp,3g2,mj2', 1700000000, NULL)`,
    ).run(path);

    db.prepare('DELETE FROM schema_migrations WHERE version = 28').run();
    migrate(db);

    const row = db.prepare('SELECT path FROM file WHERE content_hash = ?').get('sha:xyz') as {
      path: string;
    };
    expect(row.path).toBe(path);
  });
});
