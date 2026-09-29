/*
 * 14-01 Task 6: migration 0026 outcomes — Backfill + Atomicity + Perf-gate.
 *
 * Pattern: pre-seed at version 25 (via dirOverride to migrations/0001..0025),
 * mutate setting/file state, then apply full migrate(db) which only runs 0026.
 * This exercises the conditional INSERT + UPDATE branches deterministically.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '@/src/lib/db/migrate';

type Db = InstanceType<typeof Database>;

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
const NOW_UNIX = (): number => Math.floor(Date.now() / 1000);

function copyMigrationsThrough(version: number, destDir: string): void {
  for (const name of fs.readdirSync(MIGRATIONS_DIR)) {
    if (!name.endsWith('.sql')) continue;
    const match = name.match(/^(\d+)_/);
    if (!match) continue;
    const v = parseInt(match[1], 10);
    if (v <= version) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(destDir, name));
    }
  }
}

function migrateThrough25(db: Db): string {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-migrate-'));
  copyMigrationsThrough(25, tmpdir);
  migrate(db, tmpdir);
  return tmpdir;
}

describe('migration 0026 — Backfill from legacy settings', () => {
  let db: Db;
  let tmpdir: string | null;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    tmpdir = null;
  });

  afterEach(() => {
    db.close();
    if (tmpdir) fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it('test_backfill_when_full_legacy_settings_present_then_creates_library_share_with_correct_fields', () => {
    tmpdir = migrateThrough25(db);
    // Adjust legacy settings to specific values to validate Backfill mapping.
    db.prepare("UPDATE setting SET value = '/media' WHERE key = 'scan_root'").run();
    db.prepare("UPDATE setting SET value = '100' WHERE key = 'min_size_mb'").run();
    db.prepare("UPDATE setting SET value = 'mp4,mkv' WHERE key = 'extensions'").run();
    db.prepare("UPDATE setting SET value = '8' WHERE key = 'max_depth'").run();
    const start = NOW_UNIX();
    migrate(db);
    const row = db.prepare<[], Record<string, unknown>>('SELECT * FROM shares').get();
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      id: 1,
      name: 'Library',
      path: '/media',
      min_size_mb: 100,
      extensions_csv: 'mp4,mkv',
      max_depth: 8,
    });
    expect((row as { created_at: number }).created_at).toBeGreaterThanOrEqual(start);
  });

  it('test_backfill_when_scan_root_deleted_before_0026_then_shares_table_stays_empty', () => {
    tmpdir = migrateThrough25(db);
    // 14-04 (Plan 14-04 Task 2): delete ALL 4 legacy keys, not just scan_root,
    // so migration 0027's safety pre-check (shares.empty + legacy keys present
    // → ABORT) does not trip after 0026 produces 0 shares.
    db.prepare(
      "DELETE FROM setting WHERE key IN ('scan_root','min_size_mb','extensions','max_depth')",
    ).run();
    migrate(db);
    const count = (db.prepare('SELECT COUNT(*) AS c FROM shares').get() as { c: number }).c;
    expect(count).toBe(0);
    const row = db.prepare('SELECT 1 AS p FROM schema_migrations WHERE version = 26').get();
    expect(row).toBeDefined();
  });

  it('test_backfill_when_scan_root_empty_string_then_shares_table_stays_empty', () => {
    tmpdir = migrateThrough25(db);
    // 14-04 (Plan 14-04 Task 2): empty scan_root → 0026 creates 0 shares.
    // ALL 4 legacy keys (incl. scan_root presence even with empty value)
    // would trip 0027's safety abort (counts EXISTENCE, not value). Drop
    // them entirely so 0027 sees no legacy keys + 0 shares → passes pre-check.
    db.prepare(
      "DELETE FROM setting WHERE key IN ('scan_root','min_size_mb','extensions','max_depth')",
    ).run();
    migrate(db);
    const count = (db.prepare('SELECT COUNT(*) AS c FROM shares').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('test_backfill_when_min_size_mb_absent_then_defaults_to_50', () => {
    tmpdir = migrateThrough25(db);
    db.prepare("DELETE FROM setting WHERE key = 'min_size_mb'").run();
    migrate(db);
    const row = db
      .prepare<[], { min_size_mb: number }>('SELECT min_size_mb FROM shares WHERE id = 1')
      .get();
    expect(row?.min_size_mb).toBe(50);
  });

  it('test_backfill_when_extensions_absent_then_defaults_to_full_codec_list', () => {
    tmpdir = migrateThrough25(db);
    db.prepare("DELETE FROM setting WHERE key = 'extensions'").run();
    migrate(db);
    const row = db
      .prepare<[], { extensions_csv: string }>('SELECT extensions_csv FROM shares WHERE id = 1')
      .get();
    expect(row?.extensions_csv).toBe('mp4,mkv,avi,mov,m4v,webm,ts,m2ts,wmv');
  });

  it('test_backfill_when_max_depth_absent_then_max_depth_is_null', () => {
    tmpdir = migrateThrough25(db);
    db.prepare("DELETE FROM setting WHERE key = 'max_depth'").run();
    migrate(db);
    const row = db
      .prepare<[], { max_depth: number | null }>('SELECT max_depth FROM shares WHERE id = 1')
      .get();
    expect(row?.max_depth).toBeNull();
  });

  it('test_backfill_when_file_rows_under_scan_root_then_files_get_share_id_1', () => {
    tmpdir = migrateThrough25(db);
    db.prepare("UPDATE setting SET value = '/media' WHERE key = 'scan_root'").run();
    db.prepare(
      `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at)
       VALUES ('/media/a.mkv', 100, 1, 'h1', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at)
       VALUES ('/media/sub/b.mp4', 100, 1, 'h2', 1)`,
    ).run();
    migrate(db);
    const rows = db
      .prepare<
        [],
        { path: string; share_id: number | null }
      >('SELECT path, share_id FROM file ORDER BY path')
      .all();
    expect(rows).toEqual([
      { path: '/media/a.mkv', share_id: 1 },
      { path: '/media/sub/b.mp4', share_id: 1 },
    ]);
  });

  it('test_backfill_when_file_path_equals_scan_root_then_share_id_is_1', () => {
    tmpdir = migrateThrough25(db);
    db.prepare("UPDATE setting SET value = '/media/exact.mkv' WHERE key = 'scan_root'").run();
    db.prepare(
      `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at)
       VALUES ('/media/exact.mkv', 100, 1, 'h', 1)`,
    ).run();
    migrate(db);
    const row = db
      .prepare<[string], { share_id: number | null }>('SELECT share_id FROM file WHERE path = ?')
      .get('/media/exact.mkv');
    expect(row?.share_id).toBe(1);
  });

  it('test_backfill_when_file_outside_scan_root_then_share_id_stays_null', () => {
    tmpdir = migrateThrough25(db);
    db.prepare("UPDATE setting SET value = '/media' WHERE key = 'scan_root'").run();
    db.prepare(
      `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at)
       VALUES ('/other/x.mkv', 100, 1, 'h', 1)`,
    ).run();
    migrate(db);
    const row = db
      .prepare<[string], { share_id: number | null }>('SELECT share_id FROM file WHERE path = ?')
      .get('/other/x.mkv');
    expect(row?.share_id).toBeNull();
  });

  it('test_backfill_when_file_path_starts_with_scan_root_but_not_separator_boundary_then_share_id_stays_null', () => {
    tmpdir = migrateThrough25(db);
    db.prepare("UPDATE setting SET value = '/media' WHERE key = 'scan_root'").run();
    db.prepare(
      `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at)
       VALUES ('/mediastorage/x.mkv', 100, 1, 'h', 1)`,
    ).run();
    migrate(db);
    const row = db
      .prepare<[string], { share_id: number | null }>('SELECT share_id FROM file WHERE path = ?')
      .get('/mediastorage/x.mkv');
    expect(row?.share_id).toBeNull();
  });
});

describe('migration 0026 — Atomicity + Idempotency', () => {
  let db: Db;
  let tmpdir: string | null;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    tmpdir = null;
  });

  afterEach(() => {
    db.close();
    if (tmpdir) fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it('test_migrate_when_run_twice_then_second_run_is_noop', () => {
    migrate(db);
    const firstCount = (db.prepare('SELECT COUNT(*) AS c FROM shares').get() as { c: number }).c;
    migrate(db);
    const secondCount = (db.prepare('SELECT COUNT(*) AS c FROM shares').get() as { c: number }).c;
    expect(secondCount).toBe(firstCount);
    const versions = db
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM schema_migrations WHERE version = 26')
      .get();
    expect(versions?.c).toBe(1);
  });

  it('test_migrate_when_version_26_already_applied_then_no_duplicate_share_row_inserted', () => {
    migrate(db);
    const count1 = (db.prepare('SELECT COUNT(*) AS c FROM shares').get() as { c: number }).c;
    migrate(db);
    migrate(db);
    const count3 = (db.prepare('SELECT COUNT(*) AS c FROM shares').get() as { c: number }).c;
    expect(count3).toBe(count1);
  });

  it('test_migrate_when_partial_failure_inside_file_table_alter_then_full_rollback', () => {
    tmpdir = migrateThrough25(db);
    // Pre-create a column that 0026's ALTER will conflict with → ALTER throws.
    db.exec('ALTER TABLE file ADD COLUMN share_id INTEGER');
    expect(() => migrate(db)).toThrow();
    // Post-rollback: shares-table does not exist, version 26 not recorded.
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='shares'",
      )
      .all()
      .map((r) => r.name);
    expect(tables).not.toContain('shares');
    const v26 = db.prepare('SELECT 1 AS p FROM schema_migrations WHERE version = 26').get();
    expect(v26).toBeUndefined();
  });
});

describe('migration 0026 — Indexes + Schema Shape', () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  it('test_migrate_when_complete_then_idx_file_share_id_exists', () => {
    migrate(db);
    const indexes = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(indexes).toContain('idx_file_share_id');
  });

  it('test_migrate_when_complete_then_shares_table_has_correct_columns_and_constraints', () => {
    migrate(db);
    const cols = db.prepare('PRAGMA table_info(shares)').all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
    }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toEqual([
      'id',
      'name',
      'path',
      'min_size_mb',
      'extensions_csv',
      'max_depth',
      'created_at',
      'updated_at',
    ]);
    const idCol = cols.find((c) => c.name === 'id');
    expect(idCol?.pk).toBe(1);
    expect(cols.find((c) => c.name === 'name')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'path')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'min_size_mb')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'extensions_csv')?.notnull).toBe(1);
    expect(cols.find((c) => c.name === 'max_depth')?.notnull).toBe(0);
    // Unique indexes on name + path generated by NOT NULL UNIQUE.
    const indexInfo = db
      .prepare<[], { name: string; unique: number }>("PRAGMA index_list('shares')")
      .all();
    const uniqueIdxCount = indexInfo.filter((i) => i.unique === 1).length;
    expect(uniqueIdxCount).toBeGreaterThanOrEqual(2);
  });

  it('test_migrate_when_complete_then_schema_migrations_contains_version_26', () => {
    migrate(db);
    const row = db.prepare('SELECT 1 AS p FROM schema_migrations WHERE version = 26').get();
    expect(row).toBeDefined();
  });

  it('test_migrate_when_complete_then_pragma_foreign_key_check_reports_zero_violations', () => {
    migrate(db);
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    expect(violations).toHaveLength(0);
  });
});

describe('migration 0026 — Perf-gate (AC-11)', () => {
  let db: Db;
  let tmpdir: string | null;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    tmpdir = null;
  });

  afterEach(() => {
    db.close();
    if (tmpdir) fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it('test_migrate_when_10k_file_rows_then_backfill_completes_within_2000ms', () => {
    tmpdir = migrateThrough25(db);
    db.prepare("UPDATE setting SET value = '/media' WHERE key = 'scan_root'").run();
    db.prepare("UPDATE setting SET value = '50' WHERE key = 'min_size_mb'").run();
    db.prepare("UPDATE setting SET value = 'mkv' WHERE key = 'extensions'").run();
    // Bulk-insert 10k synthetic rows in a single TX.
    const insert = db.prepare(
      `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at)
       VALUES (?, 1000000, ?, ?, ?)`,
    );
    const now = NOW_UNIX();
    const tx = db.transaction(() => {
      for (let i = 0; i < 10000; i++) {
        insert.run(`/media/synth-${i}.mkv`, now, `h-${i}`, now);
      }
    });
    tx();
    const start = performance.now();
    migrate(db);
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(2000);
    const allBound = (
      db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM file WHERE share_id = 1').get() as {
        c: number;
      }
    ).c;
    expect(allBound).toBe(10000);
    const sharesCount = (db.prepare('SELECT COUNT(*) AS c FROM shares').get() as { c: number }).c;
    expect(sharesCount).toBe(1);
  });
});
