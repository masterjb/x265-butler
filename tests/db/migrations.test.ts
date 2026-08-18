// 05-08 B4 (audit S8): assert that migration 0012 adds `crf` to the `job`
// table with the expected SQL CHECK constraint enforcing 0..51 OR NULL.
// Runs the full migration sequence 0001..0012 against an in-memory SQLite DB.
//
// Without this gate, a regression to migration 0012 could silently drop the
// CHECK constraint or the column itself, and the only signal would be runtime
// JobRow shape errors deep in the orchestrator commit-step.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';

type Db = InstanceType<typeof Database>;

let db: Db;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
});

describe('migration 0012: jobs.crf column', () => {
  it('test_PRAGMA_table_info_job_includes_crf_column_with_INTEGER_type', () => {
    const cols = db.prepare("PRAGMA table_info('job')").all() as {
      name: string;
      type: string;
      notnull: number;
    }[];
    const crfCol = cols.find((c) => c.name === 'crf');
    expect(crfCol).toBeDefined();
    expect(crfCol?.type).toMatch(/INTEGER/i);
    // CHECK allows NULL
    expect(crfCol?.notnull).toBe(0);
  });

  it('test_insert_job_with_crf_NULL_then_accepted_by_CHECK_constraint', () => {
    // Seed a file row first (FK target).
    db.prepare(
      `INSERT INTO file (path, size_bytes, mtime, content_hash, status, last_scanned_at, created_at, updated_at)
       VALUES ('/m/a.mkv', 100, 0, 'hash1', 'pending', 0, 0, 0)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO job (file_id, status, encoder, created_at, crf)
           VALUES (1, 'queued', 'libx265', 0, NULL)`,
        )
        .run(),
    ).not.toThrow();
  });

  it('test_insert_job_with_crf_23_then_accepted', () => {
    db.prepare(
      `INSERT INTO file (path, size_bytes, mtime, content_hash, status, last_scanned_at, created_at, updated_at)
       VALUES ('/m/b.mkv', 100, 0, 'hash2', 'pending', 0, 0, 0)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO job (file_id, status, encoder, created_at, crf)
           VALUES (1, 'queued', 'libx265', 0, 23)`,
        )
        .run(),
    ).not.toThrow();
  });

  it('test_insert_job_with_crf_neg1_then_CHECK_violation', () => {
    db.prepare(
      `INSERT INTO file (path, size_bytes, mtime, content_hash, status, last_scanned_at, created_at, updated_at)
       VALUES ('/m/c.mkv', 100, 0, 'hash3', 'pending', 0, 0, 0)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO job (file_id, status, encoder, created_at, crf)
           VALUES (1, 'queued', 'libx265', 0, -1)`,
        )
        .run(),
    ).toThrow(/CHECK/i);
  });

  it('test_insert_job_with_crf_52_then_CHECK_violation', () => {
    db.prepare(
      `INSERT INTO file (path, size_bytes, mtime, content_hash, status, last_scanned_at, created_at, updated_at)
       VALUES ('/m/d.mkv', 100, 0, 'hash4', 'pending', 0, 0, 0)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO job (file_id, status, encoder, created_at, crf)
           VALUES (1, 'queued', 'libx265', 0, 52)`,
        )
        .run(),
    ).toThrow(/CHECK/i);
  });
});

// 05-14: migration 0015 seeds the operator-selectable output_container setting.
// Default 'mkv' preserves pre-05-14 behavior; INSERT OR IGNORE makes re-runs
// idempotent and never overwrites operator-edited values.
describe('migration 0015: output_container setting seed', () => {
  it('test_setting_output_container_default_value_is_mkv_on_fresh_db', () => {
    const row = db.prepare("SELECT value FROM setting WHERE key = 'output_container'").get() as
      | { value: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.value).toBe('mkv');
  });

  it('test_migration_0015_re_run_idempotent_preserves_operator_edited_value', () => {
    // Operator flips to 'mp4' after first run.
    db.prepare("UPDATE setting SET value = 'mp4' WHERE key = 'output_container'").run();

    // Force-re-apply the migration runner against the same DB. INSERT OR IGNORE
    // semantics — the existing row is preserved.
    db.prepare('DELETE FROM schema_migrations WHERE version = 15').run();
    migrate(db);

    const row = db.prepare("SELECT value FROM setting WHERE key = 'output_container'").get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe('mp4');
  });

  it('test_schema_migrations_records_version_15_after_initial_run', () => {
    const row = db.prepare('SELECT version FROM schema_migrations WHERE version = 15').get() as
      | { version: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.version).toBe(15);
  });
});

// 11-03 AC-1: migration 0022 NULL-safe Pass-2 metrics
describe('migration 0022: bench_combo Pass-2 metrics columns', () => {
  it('test_PRAGMA_table_info_bench_combo_includes_pass2_columns_NULLable', () => {
    const cols = db.prepare("PRAGMA table_info('bench_combo')").all() as {
      name: string;
      type: string;
      notnull: number;
    }[];
    const vmaf = cols.find((c) => c.name === 'pass2_vmaf');
    const size = cols.find((c) => c.name === 'pass2_size_bytes');
    const sec = cols.find((c) => c.name === 'pass2_encode_seconds');
    const completed = cols.find((c) => c.name === 'pass2_completed_at');
    expect(vmaf?.type).toMatch(/REAL/i);
    expect(vmaf?.notnull).toBe(0);
    expect(size?.type).toMatch(/INTEGER/i);
    expect(size?.notnull).toBe(0);
    expect(sec?.type).toMatch(/REAL/i);
    expect(sec?.notnull).toBe(0);
    expect(completed?.type).toMatch(/INTEGER/i);
    expect(completed?.notnull).toBe(0);
  });

  it('test_schema_migrations_records_version_22_after_apply', () => {
    const row = db.prepare('SELECT version FROM schema_migrations WHERE version = 22').get() as
      | { version: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.version).toBe(22);
  });
});

// 11-02-FIX-V2 UAT-003: migration 0021 NULL-safe additivity
describe('migration 0021: bench_combo.source_sample_bytes column', () => {
  it('test_PRAGMA_table_info_bench_combo_includes_source_sample_bytes_INTEGER_NULLable', () => {
    const cols = db.prepare("PRAGMA table_info('bench_combo')").all() as {
      name: string;
      type: string;
      notnull: number;
    }[];
    const col = cols.find((c) => c.name === 'source_sample_bytes');
    expect(col).toBeDefined();
    expect(col?.type).toMatch(/INTEGER/i);
    expect(col?.notnull).toBe(0); // NULLable per audit M1 NULL-safe legacy compat
  });

  it('test_schema_migrations_records_version_21_after_apply', () => {
    const row = db.prepare('SELECT version FROM schema_migrations WHERE version = 21').get() as
      | { version: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.version).toBe(21);
  });
});
