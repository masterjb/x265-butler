import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '@/src/lib/db/migrate';

type Db = InstanceType<typeof Database>;

function tableNames(db: Db): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

function indexNames(db: Db): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

describe('migrate', () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('test_migrate_when_blank_db_then_applies_initial_and_creates_tables', () => {
    migrate(db);
    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    expect(versions).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
      { version: 12 },
      { version: 13 },
      { version: 14 },
      { version: 15 },
      { version: 16 },
      { version: 17 },
      { version: 18 },
      { version: 19 },
      { version: 20 },
      { version: 21 },
      { version: 22 },
      { version: 23 },
      { version: 24 },
      { version: 25 },
      { version: 26 },
      { version: 27 },
      { version: 28 },
    ]);

    const tables = tableNames(db);
    expect(tables).toContain('file');
    expect(tables).toContain('setting');
    expect(tables).toContain('schema_migrations');
    // 14-01: shares table introduced by migration 0026.
    expect(tables).toContain('shares');

    const indexes = indexNames(db);
    expect(indexes).toContain('idx_file_content_hash');
    expect(indexes).toContain('idx_file_status');
    // 03-04 audit M6: covering index on (status, finished_at) added by migration 0006.
    expect(indexes).toContain('idx_job_status_finished_at');
    // 14-01: index on file.share_id for fast Library Filter-Pill + Backfill UPDATE.
    expect(indexes).toContain('idx_file_share_id');

    // 14-04 (Plan 14-04 Task 2): migration 0027 drops the 4 legacy
    // single-share keys after 0026 backfill creates the placeholder share.
    // Post-migrate-chain those keys MUST be absent.
    const seedKeys = (
      db
        .prepare(
          "SELECT key FROM setting WHERE key IN ('extensions','max_depth','min_size_mb','scan_root') ORDER BY key",
        )
        .all() as { key: string }[]
    ).map((r) => r.key);
    expect(seedKeys).toEqual([]);
  });

  it('test_migrate_when_run_twice_then_idempotent', () => {
    migrate(db);
    const settingsBefore = db.prepare('SELECT * FROM setting ORDER BY key').all();
    migrate(db);
    const settingsAfter = db.prepare('SELECT * FROM setting ORDER BY key').all();

    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    expect(versions).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
      { version: 12 },
      { version: 13 },
      { version: 14 },
      { version: 15 },
      { version: 16 },
      { version: 17 },
      { version: 18 },
      { version: 19 },
      { version: 20 },
      { version: 21 },
      { version: 22 },
      { version: 23 },
      { version: 24 },
      { version: 25 },
      { version: 26 },
      { version: 27 },
      { version: 28 },
    ]);
    // Seeds remain unchanged on re-run.
    expect(settingsAfter).toEqual(settingsBefore);
  });

  // audit-added S3: rollback-on-malformed-sql test
  it('test_migrate_when_malformed_sql_in_later_migration_then_rolls_back_and_throws', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-rollback-'));
    try {
      fs.writeFileSync(
        path.join(tmpdir, '0001_initial.sql'),
        'CREATE TABLE t1 (id INTEGER PRIMARY KEY);',
      );
      fs.writeFileSync(
        path.join(tmpdir, '0002_broken.sql'),
        'CREATE TABLE t2 (id INTEGER PRIMARY KEY);\nINVALID SYNTAX HERE;',
      );

      expect(() => migrate(db, tmpdir)).toThrow(/0002_broken\.sql/);

      const versions = db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as { version: number }[];
      expect(versions).toEqual([{ version: 1 }]);

      const tables = tableNames(db);
      expect(tables).toContain('t1');
      // Critical: 0002's partial table must NOT exist — transaction was rolled back.
      expect(tables).not.toContain('t2');
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it('test_migrate_when_directory_missing_then_throws_actionable_error', () => {
    expect(() => migrate(db, path.join(os.tmpdir(), `__nonexistent_${Date.now()}`))).toThrow(
      /migrations directory not found/,
    );
  });

  it('test_migrate_when_filename_lacks_version_prefix_then_throws', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-bad-name-'));
    try {
      fs.writeFileSync(path.join(tmpdir, 'no_prefix.sql'), 'CREATE TABLE t1 (id INTEGER);');
      expect(() => migrate(db, tmpdir)).toThrow(/NNNN_/);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });
});

// 02-01: migration 0002 adds job + trash_entry tables, file.version, 4 settings.
describe('migrate 0002 — job + trash_entry + file.version + new settings', () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('test_migrate_when_run_against_fresh_db_then_applies_0001_and_0002_idempotently', () => {
    migrate(db);
    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    expect(versions).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
      { version: 12 },
      { version: 13 },
      { version: 14 },
      { version: 15 },
      { version: 16 },
      { version: 17 },
      { version: 18 },
      { version: 19 },
      { version: 20 },
      { version: 21 },
      { version: 22 },
      { version: 23 },
      { version: 24 },
      { version: 25 },
      { version: 26 },
      { version: 27 },
      { version: 28 },
    ]);

    const tables = tableNames(db);
    expect(tables).toContain('job');
    expect(tables).toContain('trash_entry');
  });

  it('test_migrate_when_run_twice_then_schema_migrations_has_each_version_once', () => {
    migrate(db);
    migrate(db);
    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    expect(versions).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
      { version: 12 },
      { version: 13 },
      { version: 14 },
      { version: 15 },
      { version: 16 },
      { version: 17 },
      { version: 18 },
      { version: 19 },
      { version: 20 },
      { version: 21 },
      { version: 22 },
      { version: 23 },
      { version: 24 },
      { version: 25 },
      { version: 26 },
      { version: 27 },
      { version: 28 },
    ]);
  });

  it('test_migrate_when_0002_applied_then_job_table_has_expected_columns', () => {
    migrate(db);
    const cols = (
      db.prepare('PRAGMA table_info(job)').all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }[]
    ).map((r) => r.name);
    expect(cols).toEqual([
      'id',
      'file_id',
      'status',
      'started_at',
      'finished_at',
      'encoder',
      'bytes_in',
      'bytes_out',
      'duration_ms',
      'exit_code',
      'error_msg',
      'log_tail',
      'created_at',
      // 05-08 B4 (migration 0012): crf added at end via ALTER TABLE.
      'crf',
      // 05-12 (migration 0014): queue_position added at end via ALTER TABLE.
      'queue_position',
      // 10-03 E-D5 (migration 0018): force_container for force-retry override.
      'force_container',
      // 12-03 (migration 0025): preset_used persisted at dispatch boundary.
      'preset_used',
    ]);
  });

  it('test_migrate_when_0002_applied_then_trash_entry_table_has_expected_columns', () => {
    migrate(db);
    const cols = (db.prepare('PRAGMA table_info(trash_entry)').all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(cols).toEqual([
      'id',
      'file_id',
      'original_path',
      'trash_path',
      'size_bytes',
      'trashed_at',
      'expires_at',
      'restored_at',
    ]);
  });

  it('test_migrate_when_0002_applied_then_file_has_version_column_default_0', () => {
    migrate(db);
    const cols = db.prepare('PRAGMA table_info(file)').all() as {
      name: string;
      dflt_value: string | null;
      notnull: number;
    }[];
    const versionCol = cols.find((c) => c.name === 'version');
    expect(versionCol).toBeDefined();
    expect(versionCol?.notnull).toBe(1);
    expect(versionCol?.dflt_value).toBe('0');
  });

  it('test_migrate_when_0002_applied_then_four_new_settings_seeded', () => {
    migrate(db);
    const seedKeys = db
      .prepare(
        "SELECT key, value FROM setting WHERE key IN ('cache_pool_path','default_crf','min_savings_percent','trash_retention_days') ORDER BY key",
      )
      .all() as { key: string; value: string }[];
    expect(seedKeys).toEqual([
      { key: 'cache_pool_path', value: '/mnt/cache/x265-butler' },
      { key: 'default_crf', value: '23' },
      { key: 'min_savings_percent', value: '5' },
      { key: 'trash_retention_days', value: '30' },
    ]);
  });

  it('test_migrate_when_0002_applied_then_indexes_present', () => {
    migrate(db);
    const indexes = indexNames(db);
    expect(indexes).toContain('idx_job_file_id');
    expect(indexes).toContain('idx_job_status');
    expect(indexes).toContain('idx_job_created_at');
    expect(indexes).toContain('idx_job_active_per_file');
    expect(indexes).toContain('idx_trash_expires_at');
    expect(indexes).toContain('idx_trash_file_id');
  });

  // audit-added S1: SQL CHECK on job.status — defense-in-depth above the TS literal-union.
  it('test_migrate_when_inserting_invalid_job_status_then_check_constraint_rejects', () => {
    migrate(db);
    // Need an existing file row for FK
    db.prepare(
      "INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at) VALUES ('/m/x.mp4', 1, 1, 'h', 1)",
    ).run();
    expect(() => db.prepare("INSERT INTO job (file_id, status) VALUES (1, 'bogus')").run()).toThrow(
      /CHECK constraint failed/,
    );
  });

  // audit-added M4: partial UNIQUE INDEX prevents double-enqueue.
  it('test_migrate_when_inserting_second_active_job_for_same_file_then_unique_index_rejects', () => {
    migrate(db);
    db.prepare(
      "INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at) VALUES ('/m/x.mp4', 1, 1, 'h', 1)",
    ).run();
    db.prepare("INSERT INTO job (file_id, status) VALUES (1, 'queued')").run();
    expect(() =>
      db.prepare("INSERT INTO job (file_id, status) VALUES (1, 'queued')").run(),
    ).toThrow(/UNIQUE constraint failed/);
    // Once first job is terminal, a new active job is allowed.
    db.prepare("UPDATE job SET status = 'done' WHERE id = 1").run();
    expect(() =>
      db.prepare("INSERT INTO job (file_id, status) VALUES (1, 'queued')").run(),
    ).not.toThrow();
  });

  // audit-added S6: trash_entry path length CHECK.
  it('test_migrate_when_trash_entry_path_5000_chars_then_check_constraint_rejects', () => {
    migrate(db);
    const longPath = '/x/' + 'a'.repeat(5000);
    expect(() =>
      db
        .prepare(
          'INSERT INTO trash_entry (original_path, trash_path, size_bytes, trashed_at, expires_at) VALUES (?, ?, 0, 0, 0)',
        )
        .run(longPath, '/t/short'),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db
        .prepare(
          'INSERT INTO trash_entry (original_path, trash_path, size_bytes, trashed_at, expires_at) VALUES (?, ?, 0, 0, 0)',
        )
        .run('/o/short', longPath),
    ).toThrow(/CHECK constraint failed/);
  });

  // audit-added S8: PROD upgrade path — 0001 applied first, then 0002 added on disk later.
  it('test_migrate_when_applied_in_two_runtime_passes_then_0001_then_0002_in_order', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-seq-'));
    try {
      const real0001 = fs.readFileSync(
        path.join(process.cwd(), 'migrations', '0001_initial.sql'),
        'utf8',
      );
      const real0002 = fs.readFileSync(
        path.join(process.cwd(), 'migrations', '0002_jobs.sql'),
        'utf8',
      );

      // Pass 1: only 0001 on disk
      fs.writeFileSync(path.join(tmpdir, '0001_initial.sql'), real0001);
      migrate(db, tmpdir);
      const v1 = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
        version: number;
      }[];
      expect(v1).toEqual([{ version: 1 }]);

      // Pass 2: add 0002, migrate again
      fs.writeFileSync(path.join(tmpdir, '0002_jobs.sql'), real0002);
      migrate(db, tmpdir);
      const v2 = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
        version: number;
      }[];
      expect(v2).toEqual([{ version: 1 }, { version: 2 }]);

      // 0001-applied artefacts still present
      expect(tableNames(db)).toContain('file');
      expect(tableNames(db)).toContain('job');
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });
});

// 02-03: migration 0003 — pure-data seed `queue_paused='false'` (resolves 02-02 D10).
// 05-09: migration 0013 — retire queue_paused setting (Pause concept removed).
describe('migrate 0003 + 0013 — queue_paused setting lifecycle', () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  // 05-09 AC-8: post-0013 the queue_paused row MUST be absent on a fresh migrate.
  it('test_migrate_when_run_against_fresh_db_then_queue_paused_row_absent_after_0013', () => {
    migrate(db);
    const row = db.prepare("SELECT value FROM setting WHERE key = 'queue_paused'").get() as
      | { value: string }
      | undefined;
    expect(row).toBeUndefined();
  });

  // 05-09 AC-8: a database that has 0001..0012 + a manually-inserted
  // queue_paused='true' row gets cleanly cleared when 0013 lands.
  it('test_migrate_0013_when_preexisting_queue_paused_true_row_then_removed', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-0013-retire-'));
    try {
      // Pass 1: migrate up through 0012 only by copying real files 0001..0012.
      for (const name of [
        '0001_initial.sql',
        '0002_jobs.sql',
        '0003_queue_settings.sql',
        '0004_auto_enqueue_setting.sql',
        '0005_encoder_settings.sql',
        '0006_idx_job_status_finished_at.sql',
        '0007_onboarding_seed.sql',
        '0008_blocklist.sql',
        '0009_user.sql',
        '0010_auth_settings.sql',
        '0011_encode_behavior_settings.sql',
        '0012_jobs_crf.sql',
      ]) {
        const real = fs.readFileSync(path.join(process.cwd(), 'migrations', name), 'utf8');
        fs.writeFileSync(path.join(tmpdir, name), real);
      }
      migrate(db, tmpdir);

      // queue_paused seed from 0003 still present.
      db.prepare("UPDATE setting SET value='true' WHERE key='queue_paused'").run();
      const before = db.prepare("SELECT value FROM setting WHERE key='queue_paused'").get() as {
        value: string;
      };
      expect(before.value).toBe('true');

      // Pass 2: drop in 0013 and re-migrate.
      const real0013 = fs.readFileSync(
        path.join(process.cwd(), 'migrations', '0013_retire_queue_paused.sql'),
        'utf8',
      );
      fs.writeFileSync(path.join(tmpdir, '0013_retire_queue_paused.sql'), real0013);
      migrate(db, tmpdir);

      const after = db.prepare("SELECT value FROM setting WHERE key='queue_paused'").get();
      expect(after).toBeUndefined();
      const versions = db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as { version: number }[];
      // Test fixture only ships 0001..0013; tmpdir does NOT contain 0014.
      expect(versions[versions.length - 1]).toEqual({ version: 13 });
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it('test_migrate_when_re_run_then_schema_migrations_stays_at_5', () => {
    migrate(db);
    migrate(db);
    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    expect(versions).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
      { version: 12 },
      { version: 13 },
      { version: 14 },
      { version: 15 },
      { version: 16 },
      { version: 17 },
      { version: 18 },
      { version: 19 },
      { version: 20 },
      { version: 21 },
      { version: 22 },
      { version: 23 },
      { version: 24 },
      { version: 25 },
      { version: 26 },
      { version: 27 },
      { version: 28 },
    ]);
  });

  // audit-added S8: production upgrade race — operator manually flipped queue_paused
  // to 'true' as a workaround during the 02-02 → 02-03 ship gap. After upgrade,
  // OR IGNORE must NOT clobber the user's value.
  it('test_migrate_0003_when_user_preset_queue_paused_true_then_OR_IGNORE_preserves', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-0003-preserve-'));
    try {
      const real0001 = fs.readFileSync(
        path.join(process.cwd(), 'migrations', '0001_initial.sql'),
        'utf8',
      );
      const real0002 = fs.readFileSync(
        path.join(process.cwd(), 'migrations', '0002_jobs.sql'),
        'utf8',
      );
      const real0003 = fs.readFileSync(
        path.join(process.cwd(), 'migrations', '0003_queue_settings.sql'),
        'utf8',
      );

      // Pass 1: only 0001 + 0002 on disk
      fs.writeFileSync(path.join(tmpdir, '0001_initial.sql'), real0001);
      fs.writeFileSync(path.join(tmpdir, '0002_jobs.sql'), real0002);
      migrate(db, tmpdir);

      // User manually inserts queue_paused='true' as a workaround
      db.prepare("INSERT INTO setting (key, value) VALUES ('queue_paused', 'true')").run();

      // Pass 2: add 0003, migrate again — OR IGNORE must NOT clobber 'true'
      fs.writeFileSync(path.join(tmpdir, '0003_queue_settings.sql'), real0003);
      migrate(db, tmpdir);

      const versions = db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as { version: number }[];
      expect(versions).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);

      const row = db.prepare("SELECT value FROM setting WHERE key = 'queue_paused'").get() as {
        value: string;
      };
      // Critical: user's 'true' preserved by OR IGNORE; NOT overwritten to 'false'
      expect(row.value).toBe('true');
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it('test_migrate_0003_when_run_three_passes_then_each_version_recorded_once', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-0003-three-passes-'));
    try {
      const real0001 = fs.readFileSync(
        path.join(process.cwd(), 'migrations', '0001_initial.sql'),
        'utf8',
      );
      const real0002 = fs.readFileSync(
        path.join(process.cwd(), 'migrations', '0002_jobs.sql'),
        'utf8',
      );
      const real0003 = fs.readFileSync(
        path.join(process.cwd(), 'migrations', '0003_queue_settings.sql'),
        'utf8',
      );

      fs.writeFileSync(path.join(tmpdir, '0001_initial.sql'), real0001);
      migrate(db, tmpdir);
      fs.writeFileSync(path.join(tmpdir, '0002_jobs.sql'), real0002);
      migrate(db, tmpdir);
      fs.writeFileSync(path.join(tmpdir, '0003_queue_settings.sql'), real0003);
      migrate(db, tmpdir);

      const versions = db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as { version: number }[];
      expect(versions).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });
});

// 03-01 audit S9: corrected upgrade-race scenario for migration 0005.
// The actual production failure mode is NOT "operator pre-set value before
// migration runs" (impossible — 0005 INSERTs the row). It IS "schema_migrations
// row missing on disaster recovery → migration runner re-applies → must NOT
// clobber operator-modified values."
describe('migrate 0005 — encoder + concurrency + per-encoder CRF seeds', () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('test_migrate_0005_when_re_applied_after_operator_modified_encoder_then_OR_IGNORE_preserves_value', () => {
    // First pass: full migrate seeds encoder='auto', etc.
    migrate(db);
    const seedRow = db.prepare("SELECT value FROM setting WHERE key='encoder'").get() as {
      value: string;
    };
    expect(seedRow.value).toBe('auto');

    // Operator picks NVENC via Settings UI (simulated SQL UPDATE).
    db.prepare("UPDATE setting SET value='nvenc' WHERE key='encoder'").run();

    // Disaster recovery: schema_migrations row for 5 missing on disk
    // (corruption, partial restore, etc.) → migration runner re-applies 0005.
    db.prepare('DELETE FROM schema_migrations WHERE version=5').run();
    migrate(db);

    // Versions back to full set + operator value preserved by OR IGNORE.
    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    expect(versions).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
      { version: 12 },
      { version: 13 },
      { version: 14 },
      { version: 15 },
      { version: 16 },
      { version: 17 },
      { version: 18 },
      { version: 19 },
      { version: 20 },
      { version: 21 },
      { version: 22 },
      { version: 23 },
      { version: 24 },
      { version: 25 },
      { version: 26 },
      { version: 27 },
      { version: 28 },
    ]);
    const after = db.prepare("SELECT value FROM setting WHERE key='encoder'").get() as {
      value: string;
    };
    expect(after.value).toBe('nvenc');
    // Other 0005 seeds idempotent (still '23' / '22').
    const crfLib = db.prepare("SELECT value FROM setting WHERE key='crf_libx265'").get() as {
      value: string;
    };
    expect(crfLib.value).toBe('23');
  });

  it('test_migrate_0005_when_run_against_fresh_db_then_seeds_six_keys', () => {
    migrate(db);
    const rows = db
      .prepare(
        "SELECT key, value FROM setting WHERE key IN ('encoder','concurrency','crf_libx265','crf_nvenc','crf_qsv','crf_vaapi') ORDER BY key",
      )
      .all() as { key: string; value: string }[];
    expect(rows).toEqual([
      { key: 'concurrency', value: 'auto' },
      { key: 'crf_libx265', value: '23' },
      { key: 'crf_nvenc', value: '23' },
      { key: 'crf_qsv', value: '22' },
      { key: 'crf_vaapi', value: '22' },
      { key: 'encoder', value: 'auto' },
    ]);
  });
});

// 03-04 audit M6: migration 0006 covering index on job(status, finished_at).
describe('migrate 0006 — covering index for /api/stats KPI queries', () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('test_migrate_0006_when_applied_then_idx_job_status_finished_at_present', () => {
    migrate(db);
    const indexes = indexNames(db);
    expect(indexes).toContain('idx_job_status_finished_at');
  });

  it('test_migrate_0006_when_applied_then_NO_new_tables_introduced', () => {
    migrate(db);
    const tables = tableNames(db);
    // 0006 adds an INDEX, no new TABLE. Filter tables added by later migrations.
    const userTables = tables.filter(
      (t) =>
        t !== 'sqlite_sequence' &&
        t !== 'blocklist_entry' &&
        t !== 'user' &&
        t !== 'bench_run' &&
        t !== 'bench_combo' &&
        t !== 'shares',
    );
    expect(userTables).toEqual(['file', 'job', 'schema_migrations', 'setting', 'trash_entry']);
  });

  it('test_migrate_0006_when_applied_then_query_planner_uses_index_for_done_finished_predicate', () => {
    migrate(db);
    // EXPLAIN QUERY PLAN reports `USING INDEX idx_job_status_finished_at` for the
    // KPI predicate. Statement first must be parameterized in the same shape as
    // statsRepo's queries.
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT COUNT(*) FROM job WHERE status = 'done' AND finished_at >= ?`,
      )
      .all(0) as { detail: string }[];
    const detail = plan.map((p) => p.detail).join(' | ');
    expect(detail).toMatch(/idx_job_status_finished_at/);
  });

  it('test_migrate_0006_when_run_twice_then_index_create_idempotent', () => {
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    const versions = (
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
        version: number;
      }[]
    ).map((r) => r.version);
    expect(versions).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
      27, 28,
    ]);
  });
});

// 03-05 Plan Task 1 — migration 0007 seeds onboarding_completed='false'.
// Pure-data migration; INSERT OR IGNORE preserves operator-set value across
// re-runs (audit S2 — version-targeted assertion replaces fragile absolute count).
describe('migrate 0007 — onboarding_completed seed', () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('test_migrate_0007_when_applied_then_seeds_onboarding_completed_false', () => {
    migrate(db);
    const row = db.prepare("SELECT value FROM setting WHERE key = 'onboarding_completed'").get() as
      | { value: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.value).toBe('false');
  });

  // audit S2: version-targeted assertion (rebase-safe — absolute count would
  // break if a future migration lands between branches).
  it('test_migrate_0007_when_applied_then_version_7_row_exists_in_schema_migrations', () => {
    migrate(db);
    const row = db.prepare('SELECT 1 AS present FROM schema_migrations WHERE version = 7').get() as
      | { present: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.present).toBe(1);

    const count = (db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number })
      .c;
    expect(count).toBeGreaterThanOrEqual(7);
  });

  it('test_migrate_0007_when_re_applied_after_operator_set_true_then_OR_IGNORE_preserves', () => {
    // First pass: full migrate seeds onboarding_completed='false'
    migrate(db);
    const seedRow = db
      .prepare("SELECT value FROM setting WHERE key='onboarding_completed'")
      .get() as { value: string };
    expect(seedRow.value).toBe('false');

    // Operator finishes wizard → flag flips to 'true' (simulated SQL UPDATE).
    db.prepare("UPDATE setting SET value='true' WHERE key='onboarding_completed'").run();

    // Disaster recovery: schema_migrations row for 7 missing on disk
    // (corruption, partial restore, etc.) → migration runner re-applies 0007.
    db.prepare('DELETE FROM schema_migrations WHERE version=7').run();
    migrate(db);

    // Versions back to full set + operator value preserved by OR IGNORE.
    const after = db
      .prepare("SELECT value FROM setting WHERE key='onboarding_completed'")
      .get() as { value: string };
    expect(after.value).toBe('true');
  });

  it('test_migrate_0007_when_applied_then_NO_new_tables_introduced', () => {
    migrate(db);
    const tables = tableNames(db);
    // 0007 is pure-data (INSERT OR IGNORE), no new TABLE. Filter tables added by later migrations.
    const userTables = tables.filter(
      (t) =>
        t !== 'sqlite_sequence' &&
        t !== 'blocklist_entry' &&
        t !== 'user' &&
        t !== 'bench_run' &&
        t !== 'bench_combo' &&
        t !== 'shares',
    );
    expect(userTables).toEqual(['file', 'job', 'schema_migrations', 'setting', 'trash_entry']);
  });

  it('test_migrate_0007_when_run_twice_then_idempotent', () => {
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    const versions = (
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
        version: number;
      }[]
    ).map((r) => r.version);
    expect(versions).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
      27, 28,
    ]);
  });
});

// 04-02: migration 0008 — blocklist_entry table.
describe('migrate 0008 — blocklist_entry table (04-02)', () => {
  let db: InstanceType<typeof Database>;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });
  afterEach(() => db.close());

  it('test_migrate_0008_when_applied_then_creates_blocklist_entry_table', () => {
    migrate(db);
    expect(tableNames(db)).toContain('blocklist_entry');
    const cols = (db.prepare('PRAGMA table_info(blocklist_entry)').all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(cols).toEqual(['id', 'file_id', 'path_pattern', 'reason', 'created_at']);
  });

  it('test_migrate_0008_when_applied_then_indexes_present', () => {
    migrate(db);
    const indexes = indexNames(db);
    expect(indexes).toContain('idx_blocklist_file_id');
    expect(indexes).toContain('idx_blocklist_created_at');
    expect(indexes).toContain('idx_blocklist_file_id_unique');
  });

  it('test_migrate_0008_when_applied_then_version_8_row_exists_in_schema_migrations', () => {
    migrate(db);
    const row = db
      .prepare<
        [],
        { present: number }
      >('SELECT 1 AS present FROM schema_migrations WHERE version = 8')
      .get();
    expect(row?.present).toBe(1);
  });

  // audit M1: partial UNIQUE INDEX on file_id WHERE file_id IS NOT NULL.
  it('test_migrate_0008_when_inserting_second_file_pinned_entry_for_same_file_then_unique_index_rejects', () => {
    migrate(db);
    db.prepare(
      "INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at) VALUES ('/m/x.mp4', 1, 1, 'h', 1)",
    ).run();
    db.prepare("INSERT INTO blocklist_entry (file_id, reason) VALUES (1, 'operator')").run();
    expect(() =>
      db.prepare("INSERT INTO blocklist_entry (file_id, reason) VALUES (1, 'operator')").run(),
    ).toThrow(/UNIQUE constraint failed/);
  });

  // audit M1: pattern entries with file_id=NULL coexist normally (no UNIQUE conflict).
  it('test_migrate_0008_when_multiple_pattern_entries_with_null_file_id_then_no_unique_conflict', () => {
    migrate(db);
    expect(() => {
      db.prepare(
        "INSERT INTO blocklist_entry (path_pattern, reason) VALUES ('/a/*', 'operator')",
      ).run();
      db.prepare(
        "INSERT INTO blocklist_entry (path_pattern, reason) VALUES ('/b/*', 'operator')",
      ).run();
    }).not.toThrow();
  });

  it('test_migrate_0008_when_inserting_both_file_id_AND_path_pattern_then_check_rejects', () => {
    migrate(db);
    db.prepare(
      "INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at) VALUES ('/m/x.mp4', 1, 1, 'h', 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO blocklist_entry (file_id, path_pattern, reason) VALUES (1, '/x/*', 'operator')",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('test_migrate_0008_when_inserting_neither_file_id_NOR_path_pattern_then_check_rejects', () => {
    migrate(db);
    expect(() =>
      db.prepare("INSERT INTO blocklist_entry (reason) VALUES ('operator')").run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('test_migrate_0008_when_FK_CASCADE_file_deleted_then_pinned_entry_removed', () => {
    migrate(db);
    db.prepare(
      "INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at) VALUES ('/m/x.mp4', 1, 1, 'h', 1)",
    ).run();
    db.prepare("INSERT INTO blocklist_entry (file_id, reason) VALUES (1, 'operator')").run();
    db.prepare('DELETE FROM file WHERE id = 1').run();
    const count = (db.prepare('SELECT COUNT(*) AS c FROM blocklist_entry').get() as { c: number })
      .c;
    expect(count).toBe(0);
  });

  // audit S5: reason CHECK accepts all 3 values forward-compat.
  it('test_migrate_0008_when_reason_auto_failure_or_auto_skip_then_accepted_at_SQL_layer', () => {
    migrate(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO blocklist_entry (path_pattern, reason) VALUES ('/x/*', 'auto-failure')",
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      db
        .prepare("INSERT INTO blocklist_entry (path_pattern, reason) VALUES ('/y/*', 'auto-skip')")
        .run(),
    ).not.toThrow();
    expect(() =>
      db.prepare("INSERT INTO blocklist_entry (path_pattern, reason) VALUES ('/z/*', 'foo')").run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('test_migrate_0008_when_path_pattern_5000_chars_then_check_rejects', () => {
    migrate(db);
    const longPattern = '/x/'.repeat(2000);
    expect(() =>
      db
        .prepare("INSERT INTO blocklist_entry (path_pattern, reason) VALUES (?, 'operator')")
        .run(longPattern),
    ).toThrow(/CHECK constraint failed/);
  });

  it('test_migrate_0008_when_run_twice_then_idempotent', () => {
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });
});

// 11-01: migrations 0019 (bench_run + settings-seed) + 0020 (bench_combo + indexes).
describe('migrate 0019 + 0020 — bench_run + bench_combo tables', () => {
  let db: InstanceType<typeof Database>;
  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });
  afterEach(() => db.close());

  it('test_migrate_0019_when_applied_then_bench_run_table_has_expected_columns', () => {
    migrate(db);
    const cols = (db.prepare('PRAGMA table_info(bench_run)').all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(cols).toEqual([
      'id',
      'mode',
      'status',
      'file_ids_json',
      'matrix_json',
      'sample_count',
      'sample_duration_seconds',
      'vmaf_buckets_json',
      'vmaf_model',
      'actor_id',
      'error_reason',
      'created_at',
      'started_at',
      'completed_at',
      'version',
    ]);
  });

  it('test_migrate_0020_when_applied_then_bench_combo_table_has_expected_columns', () => {
    migrate(db);
    const cols = (db.prepare('PRAGMA table_info(bench_combo)').all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(cols).toEqual([
      'id',
      'run_id',
      'file_id',
      'encoder',
      'preset',
      'native_quality_param',
      'native_quality_value',
      'vmaf_target',
      'sample_idx',
      'vmaf',
      'size_bytes',
      'encode_seconds',
      'status',
      'error_reason',
      'is_pareto',
      'top3_role',
      'created_at',
      'completed_at',
      'source_sample_bytes',
      // 11-03 migration 0022: Pass-2 full-file verify metrics
      'pass2_vmaf',
      'pass2_size_bytes',
      'pass2_encode_seconds',
      'pass2_completed_at',
    ]);
  });

  it('test_migrate_0020_when_applied_then_indexes_present', () => {
    migrate(db);
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(indexes).toContain('idx_bench_combo_run');
    expect(indexes).toContain('idx_bench_combo_run_file');
  });

  it('test_migrate_0019_when_applied_then_6_bench_settings_seeded', () => {
    migrate(db);
    const rows = db
      .prepare("SELECT key, value FROM setting WHERE key LIKE 'bench_%' ORDER BY key")
      .all() as { key: string; value: string }[];
    expect(rows).toEqual([
      // 11-06: migration 0023 adds 3 default-matrix keys (encoders/presets/native_values).
      { key: 'bench_default_encoders', value: 'libx265' },
      { key: 'bench_default_mode', value: 'native-sweep' },
      { key: 'bench_default_native_values', value: '23,28' },
      { key: 'bench_default_presets', value: 'veryfast,medium,slow' },
      { key: 'bench_max_concurrent_runs', value: '1' },
      { key: 'bench_sample_count', value: '3' },
      { key: 'bench_sample_duration_seconds', value: '20' },
      { key: 'bench_vmaf_buckets', value: '95,92,88' },
      { key: 'bench_vmaf_model', value: 'vmaf_v0.6.1' },
    ]);
  });

  it('test_migrate_when_run_twice_with_0019_0020_then_idempotent', () => {
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    const count = (db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number })
      .c;
    expect(count).toBe(28); // 16-05: added 0028 (UPDATE legacy-default output_suffix → '-x265')
  });

  it('test_migrate_0020_bench_combo_cascade_delete_removes_combos_when_run_deleted', () => {
    migrate(db);
    db.prepare(
      "INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at) VALUES ('/x.mkv', 1, 1, 'h', 1)",
    ).run();
    db.prepare(
      "INSERT INTO bench_run (mode, status, file_ids_json, matrix_json, created_at) VALUES ('native-sweep','pending','[]','{}',1)",
    ).run();
    const runId = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
    db.prepare(
      'INSERT INTO bench_combo (run_id, file_id, encoder, native_quality_param, native_quality_value, sample_idx, status, created_at) VALUES (?, 1, ?, ?, 23, 0, ?, 1)',
    ).run(runId, 'libx265', '-crf', 'pending');
    db.prepare('DELETE FROM bench_run WHERE id=?').run(runId);
    const remaining = (db.prepare('SELECT COUNT(*) AS c FROM bench_combo').get() as { c: number })
      .c;
    expect(remaining).toBe(0);
  });
});

// 12-03: migration 0024 — per-encoder preset_<encoder> seeds (mirror 0005
// CRF pattern). Defaults match pre-12-03 PROFILE_BUILDERS hardcoded preset
// per encoder so AC-12 byte-identical orchestrator output holds.
describe('migrate 0024 — per-encoder preset seeds', () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('test_migrate_0024_when_applied_then_seeds_four_preset_keys_matching_defaults', () => {
    migrate(db);
    const rows = db
      .prepare(
        "SELECT key, value FROM setting WHERE key IN ('preset_libx265','preset_nvenc','preset_qsv','preset_vaapi') ORDER BY key",
      )
      .all() as { key: string; value: string }[];
    expect(rows).toEqual([
      { key: 'preset_libx265', value: 'medium' },
      { key: 'preset_nvenc', value: 'p5' },
      { key: 'preset_qsv', value: 'slow' },
      { key: 'preset_vaapi', value: 'slow' },
    ]);
  });

  it('test_migrate_0024_when_version_24_row_exists_in_schema_migrations', () => {
    migrate(db);
    const row = db.prepare('SELECT version FROM schema_migrations WHERE version = 24').get() as
      | { version: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.version).toBe(24);
  });

  it('test_migrate_0024_when_re_applied_after_operator_modified_preset_then_OR_IGNORE_preserves_value', () => {
    migrate(db);
    const seedRow = db.prepare("SELECT value FROM setting WHERE key='preset_libx265'").get() as {
      value: string;
    };
    expect(seedRow.value).toBe('medium');

    // Operator picks 'slow' via Settings UI (simulated SQL UPDATE).
    db.prepare("UPDATE setting SET value='slow' WHERE key='preset_libx265'").run();

    // Disaster recovery: schema_migrations row for 24 missing on disk →
    // migration runner re-applies 0024. INSERT OR IGNORE must NOT clobber.
    db.prepare('DELETE FROM schema_migrations WHERE version=24').run();
    migrate(db);

    const after = db.prepare("SELECT value FROM setting WHERE key='preset_libx265'").get() as {
      value: string;
    };
    expect(after.value).toBe('slow');
    // Other preset seeds idempotent.
    const nvenc = db.prepare("SELECT value FROM setting WHERE key='preset_nvenc'").get() as {
      value: string;
    };
    expect(nvenc.value).toBe('p5');
  });

  it('test_migrate_0024_when_run_twice_then_idempotent', () => {
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    const count = (db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number })
      .c;
    expect(count).toBe(28);
  });
});

// 12-03 inline-extend Route-1: migration 0025 — ALTER TABLE job ADD COLUMN
// preset_used TEXT. Companion to migration 0012 (crf column). Orchestrator
// dispatch writes the resolved preset alongside setCrf at the same boundary.
describe('migrate 0025 — job.preset_used column', () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('test_migrate_0025_when_applied_then_job_table_has_preset_used_column', () => {
    migrate(db);
    const cols = db.prepare("PRAGMA table_info('job')").all() as {
      name: string;
      type: string;
      notnull: number;
    }[];
    const presetCol = cols.find((c) => c.name === 'preset_used');
    expect(presetCol).toBeDefined();
    expect(presetCol?.type).toMatch(/TEXT/i);
    // NULLable (no CHECK constraint, no NOT NULL).
    expect(presetCol?.notnull).toBe(0);
  });

  it('test_migrate_0025_when_version_25_row_exists_in_schema_migrations', () => {
    migrate(db);
    const row = db.prepare('SELECT version FROM schema_migrations WHERE version = 25').get() as
      | { version: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.version).toBe(25);
  });

  it('test_migrate_0025_when_insert_job_with_preset_used_then_persisted', () => {
    migrate(db);
    db.prepare(
      `INSERT INTO file (path, size_bytes, mtime, content_hash, status, last_scanned_at, created_at, updated_at)
       VALUES ('/m/a.mkv', 100, 0, 'hash1', 'pending', 0, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO job (file_id, status, encoder, created_at, crf, preset_used)
       VALUES (1, 'done', 'libx265', 0, 23, 'slow')`,
    ).run();
    const row = db.prepare('SELECT preset_used FROM job WHERE id = 1').get() as {
      preset_used: string;
    };
    expect(row.preset_used).toBe('slow');
  });

  it('test_migrate_0025_when_insert_job_without_preset_used_then_NULL', () => {
    migrate(db);
    db.prepare(
      `INSERT INTO file (path, size_bytes, mtime, content_hash, status, last_scanned_at, created_at, updated_at)
       VALUES ('/m/b.mkv', 100, 0, 'hash2', 'pending', 0, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO job (file_id, status, encoder, created_at, crf)
       VALUES (1, 'queued', 'libx265', 0, NULL)`,
    ).run();
    const row = db.prepare('SELECT preset_used FROM job WHERE id = 1').get() as {
      preset_used: string | null;
    };
    expect(row.preset_used).toBeNull();
  });
});
