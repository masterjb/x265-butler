/*
 * Plan 47-03 Task 1: migration 0029 — bench_combo.file_id nullable + SET NULL.
 *
 * The repo's FIRST table rebuild. Covers:
 *   AC-1  file_id notnull=0 + on_delete SET NULL; run_id still CASCADE
 *   AC-2  orphaned file_id self-heals to NULL instead of throwing at boot
 *   AC-3  column / CHECK / index parity across the rebuild
 *   AC-3b sqlite_sequence high-water mark survives DROP TABLE (purge scenario
 *         + empty-table scenario)
 *   AC-4  row data byte-identical across the rebuild
 *   M3    row-count guard is sharp: a partial copy aborts the migration AND
 *         rolls back schema_migrations (DB untouched)
 *
 * Pattern mirrors tests/db/share-migration-0027.test.ts: copy migrations
 * <= 28 into a tmpdir, migrate() through them, manipulate state, then call
 * migrate(db) against the real migrations/ dir which applies only 0029.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '@/src/lib/db/migrate';

type Db = InstanceType<typeof Database>;

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
const MIGRATION_0029 = '0029_bench_combo_file_id_nullable.sql';

type ColumnInfo = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};
type FkInfo = {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_delete: string;
};
type IndexInfo = { name: string };

function copyMigrationsThrough(version: number, destDir: string): void {
  for (const name of fs.readdirSync(MIGRATIONS_DIR)) {
    if (!name.endsWith('.sql')) continue;
    const match = name.match(/^(\d+)_/);
    if (!match) continue;
    if (parseInt(match[1], 10) <= version) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(destDir, name));
    }
  }
}

function migrateThrough28(db: Db, tmpdirs: string[]): void {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'm0029-through28-'));
  tmpdirs.push(tmpdir);
  copyMigrationsThrough(28, tmpdir);
  migrate(db, tmpdir);
}

function tableInfo(db: Db): ColumnInfo[] {
  return db.prepare('PRAGMA table_info(bench_combo)').all() as ColumnInfo[];
}

function foreignKeys(db: Db): FkInfo[] {
  return db.prepare('PRAGMA foreign_key_list(bench_combo)').all() as FkInfo[];
}

function indexNames(db: Db): string[] {
  return (db.prepare('PRAGMA index_list(bench_combo)').all() as IndexInfo[])
    .map((r) => r.name)
    .filter((n) => !n.startsWith('sqlite_'))
    .sort();
}

function schemaHasVersion(db: Db, version: number): boolean {
  return (
    (
      db.prepare('SELECT COUNT(*) AS c FROM schema_migrations WHERE version = ?').get(version) as {
        c: number;
      }
    ).c === 1
  );
}

function benchComboSeq(db: Db): number | null {
  const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'bench_combo'").get() as
    | { seq: number }
    | undefined;
  return row ? row.seq : null;
}

let fileSeq = 0;
function insertFile(db: Db, id?: number): number {
  fileSeq += 1;
  const suffix = `${fileSeq}-${Math.random().toString(36).slice(2, 8)}`;
  const cols = id === undefined ? '' : 'id, ';
  const vals = id === undefined ? '' : '?, ';
  const params: unknown[] = id === undefined ? [] : [id];
  const info = db
    .prepare(
      `INSERT INTO file (${cols}path, size_bytes, mtime, content_hash, last_scanned_at)
       VALUES (${vals}?, ?, ?, ?, ?)`,
    )
    .run(...params, `/media/f-${suffix}.mkv`, 1000, 1, `hash-${suffix}`, 1);
  return Number(info.lastInsertRowid);
}

function insertRun(db: Db, status = 'complete'): number {
  const info = db
    .prepare(
      `INSERT INTO bench_run (mode, status, file_ids_json, matrix_json, created_at)
       VALUES ('native-sweep', ?, '[]', '{}', 1)`,
    )
    .run(status);
  return Number(info.lastInsertRowid);
}

function insertCombo(
  db: Db,
  runId: number,
  fileId: number | null,
  overrides: Partial<Record<string, unknown>> = {},
): number {
  const row = {
    id: null as number | null,
    encoder: 'libx265',
    preset: 'medium',
    native_quality_param: 'crf',
    native_quality_value: 24,
    vmaf_target: null as number | null,
    sample_idx: 0,
    vmaf: null as number | null,
    size_bytes: null as number | null,
    encode_seconds: null as number | null,
    status: 'complete',
    error_reason: null as string | null,
    is_pareto: 0,
    top3_role: null as string | null,
    created_at: 100,
    completed_at: null as number | null,
    source_sample_bytes: null as number | null,
    pass2_vmaf: null as number | null,
    pass2_size_bytes: null as number | null,
    pass2_encode_seconds: null as number | null,
    pass2_completed_at: null as number | null,
    ...overrides,
  };
  const idCol = row.id === null ? '' : 'id, ';
  const idVal = row.id === null ? '' : '?, ';
  const idParam: unknown[] = row.id === null ? [] : [row.id];
  const info = db
    .prepare(
      `INSERT INTO bench_combo (
         ${idCol}run_id, file_id, encoder, preset, native_quality_param, native_quality_value,
         vmaf_target, sample_idx, vmaf, size_bytes, encode_seconds, status, error_reason,
         is_pareto, top3_role, created_at, completed_at, source_sample_bytes,
         pass2_vmaf, pass2_size_bytes, pass2_encode_seconds, pass2_completed_at
       ) VALUES (${idVal}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ...idParam,
      runId,
      fileId,
      row.encoder,
      row.preset,
      row.native_quality_param,
      row.native_quality_value,
      row.vmaf_target,
      row.sample_idx,
      row.vmaf,
      row.size_bytes,
      row.encode_seconds,
      row.status,
      row.error_reason,
      row.is_pareto,
      row.top3_role,
      row.created_at,
      row.completed_at,
      row.source_sample_bytes,
      row.pass2_vmaf,
      row.pass2_size_bytes,
      row.pass2_encode_seconds,
      row.pass2_completed_at,
    );
  return Number(info.lastInsertRowid);
}

describe('migration 0029 — bench_combo.file_id nullable + ON DELETE SET NULL', () => {
  let db: Db;
  let tmpdirs: string[];

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    tmpdirs = [];
  });

  afterEach(() => {
    db.close();
    for (const d of tmpdirs) fs.rmSync(d, { recursive: true, force: true });
  });

  // ── AC-1 ────────────────────────────────────────────────────────────────
  it('test_migrate_0029_when_applied_then_file_id_nullable_and_on_delete_set_null', () => {
    migrateThrough28(db, tmpdirs);
    const before = tableInfo(db).find((c) => c.name === 'file_id')!;
    expect(before.notnull).toBe(1);

    migrate(db);

    expect(schemaHasVersion(db, 29)).toBe(true);
    const after = tableInfo(db).find((c) => c.name === 'file_id')!;
    expect(after.notnull).toBe(0);

    const fks = foreignKeys(db);
    const fileFk = fks.find((f) => f.from === 'file_id')!;
    expect(fileFk.table).toBe('file');
    expect(fileFk.on_delete).toBe('SET NULL');
    const runFk = fks.find((f) => f.from === 'run_id')!;
    expect(runFk.table).toBe('bench_run');
    expect(runFk.on_delete).toBe('CASCADE');
  });

  it('test_delete_file_when_referenced_by_combo_then_set_null_instead_of_fk_error', () => {
    migrateThrough28(db, tmpdirs);
    const fileId = insertFile(db);
    const runId = insertRun(db, 'failed');
    const comboId = insertCombo(db, runId, fileId, {
      vmaf: 95.5,
      size_bytes: 42,
      encode_seconds: 7.5,
    });

    migrate(db);

    expect(() => db.prepare('DELETE FROM file WHERE id = ?').run(fileId)).not.toThrow();
    const combo = db.prepare('SELECT * FROM bench_combo WHERE id = ?').get(comboId) as {
      file_id: number | null;
      vmaf: number | null;
      size_bytes: number | null;
      encode_seconds: number | null;
    };
    expect(combo.file_id).toBeNull();
    expect(combo.vmaf).toBe(95.5);
    expect(combo.size_bytes).toBe(42);
    expect(combo.encode_seconds).toBe(7.5);
  });

  it('test_delete_bench_run_after_0029_then_combos_still_cascade', () => {
    migrateThrough28(db, tmpdirs);
    const fileId = insertFile(db);
    const runId = insertRun(db);
    insertCombo(db, runId, fileId);

    migrate(db);

    db.prepare('DELETE FROM bench_run WHERE id = ?').run(runId);
    const count = (
      db.prepare('SELECT COUNT(*) AS c FROM bench_combo WHERE run_id = ?').get(runId) as {
        c: number;
      }
    ).c;
    expect(count).toBe(0);
  });

  // ── AC-2 ────────────────────────────────────────────────────────────────
  it('test_migrate_0029_when_orphaned_file_id_then_row_survives_with_null_and_no_throw', () => {
    migrateThrough28(db, tmpdirs);
    const liveFileId = insertFile(db);
    const runId = insertRun(db, 'failed');
    const goodCombo = insertCombo(db, runId, liveFileId);

    // Smuggle an orphan past FK enforcement — no open transaction here, so the
    // PRAGMA actually takes effect (unlike inside migrate()'s tx).
    db.pragma('foreign_keys = OFF');
    const orphanCombo = insertCombo(db, runId, 999_999);
    db.pragma('foreign_keys = ON');

    expect(() => migrate(db)).not.toThrow();

    const orphan = db.prepare('SELECT file_id FROM bench_combo WHERE id = ?').get(orphanCombo) as {
      file_id: number | null;
    };
    expect(orphan.file_id).toBeNull();
    const good = db.prepare('SELECT file_id FROM bench_combo WHERE id = ?').get(goodCombo) as {
      file_id: number | null;
    };
    expect(good.file_id).toBe(liveFileId);
    expect((db.prepare('SELECT COUNT(*) AS c FROM bench_combo').get() as { c: number }).c).toBe(2);
  });

  // ── AC-3 ────────────────────────────────────────────────────────────────
  it('test_migrate_0029_when_applied_then_all_23_columns_identical_except_file_id', () => {
    migrateThrough28(db, tmpdirs);
    const before = tableInfo(db);
    expect(before).toHaveLength(23);

    migrate(db);

    const after = tableInfo(db);
    expect(after).toHaveLength(23);
    expect(after.map((c) => c.name)).toEqual(before.map((c) => c.name));
    for (const col of before) {
      const now = after.find((c) => c.name === col.name)!;
      expect({ name: now.name, type: now.type, pk: now.pk, dflt_value: now.dflt_value }).toEqual({
        name: col.name,
        type: col.type,
        pk: col.pk,
        dflt_value: col.dflt_value,
      });
      if (col.name !== 'file_id') expect(now.notnull).toBe(col.notnull);
    }
  });

  it('test_migrate_0029_when_applied_then_status_and_top3_role_checks_survive', () => {
    migrateThrough28(db, tmpdirs);
    const fileId = insertFile(db);
    const runId = insertRun(db);

    migrate(db);

    expect(() => insertCombo(db, runId, fileId, { status: 'bogus' })).toThrow(/CHECK constraint/);
    expect(() => insertCombo(db, runId, fileId, { top3_role: 'bogus' })).toThrow(
      /CHECK constraint/,
    );
    expect(() => insertCombo(db, runId, fileId, { top3_role: 'balanced' })).not.toThrow();
    expect(() => insertCombo(db, runId, fileId, { top3_role: null })).not.toThrow();
  });

  it('test_migrate_0029_when_applied_then_both_indexes_exist', () => {
    migrateThrough28(db, tmpdirs);
    expect(indexNames(db)).toEqual(['idx_bench_combo_run', 'idx_bench_combo_run_file']);

    migrate(db);

    expect(indexNames(db)).toEqual(['idx_bench_combo_run', 'idx_bench_combo_run_file']);
  });

  // ── AC-3b ───────────────────────────────────────────────────────────────
  it('test_migrate_0029_when_purged_high_ids_then_sqlite_sequence_high_water_survives', () => {
    migrateThrough28(db, tmpdirs);
    const fileId = insertFile(db);
    const purgedRun = insertRun(db, 'complete');
    insertCombo(db, purgedRun, fileId, { id: 500 });
    insertCombo(db, purgedRun, fileId, { id: 501 });
    // 47-01 purge: deleting the run CASCADEs the combos away; sqlite_sequence
    // keeps the high-water mark.
    db.prepare('DELETE FROM bench_run WHERE id = ?').run(purgedRun);

    const survivingRun = insertRun(db, 'failed');
    insertCombo(db, survivingRun, fileId, { id: 3 });
    const seqBefore = benchComboSeq(db);
    expect(seqBefore).toBe(501);
    expect((db.prepare('SELECT MAX(id) AS m FROM bench_combo').get() as { m: number }).m).toBe(3);

    migrate(db);

    expect(benchComboSeq(db)).toBe(501);
    const newId = insertCombo(db, survivingRun, fileId);
    expect(newId).toBe(502);
  });

  it('test_migrate_0029_when_bench_combo_empty_then_no_throw_and_ids_start_at_1', () => {
    migrateThrough28(db, tmpdirs);
    expect(benchComboSeq(db)).toBeNull();

    expect(() => migrate(db)).not.toThrow();

    // The step-1b INSERT … SELECT copies nothing (no source row). The zero-row
    // data INSERT of step 2 still makes SQLite write the AUTOINCREMENT sequence
    // back at statement end, so a seq=0 row may exist afterwards. Either shape
    // is correct — what matters is that the counter did not start above 0.
    expect(benchComboSeq(db) ?? 0).toBe(0);
    const fileId = insertFile(db);
    const runId = insertRun(db);
    expect(insertCombo(db, runId, fileId)).toBe(1);
  });

  it('test_migrate_0029_when_all_rows_purged_then_seq_kept_and_ids_do_not_repeat', () => {
    migrateThrough28(db, tmpdirs);
    const fileId = insertFile(db);
    const runId = insertRun(db);
    insertCombo(db, runId, fileId, { id: 77 });
    db.prepare('DELETE FROM bench_run WHERE id = ?').run(runId);
    expect((db.prepare('SELECT COUNT(*) AS c FROM bench_combo').get() as { c: number }).c).toBe(0);
    expect(benchComboSeq(db)).toBe(77);

    migrate(db);

    expect(benchComboSeq(db)).toBe(77);
    const run2 = insertRun(db);
    expect(insertCombo(db, run2, fileId)).toBe(78);
  });

  // ── AC-4 ────────────────────────────────────────────────────────────────
  it('test_migrate_0029_when_rows_across_runs_then_every_column_value_preserved', () => {
    migrateThrough28(db, tmpdirs);
    const fileA = insertFile(db);
    const fileB = insertFile(db);
    const runA = insertRun(db, 'complete');
    const runB = insertRun(db, 'failed');
    insertCombo(db, runA, fileA, {
      encoder: 'libx265',
      preset: 'slow',
      native_quality_value: 22,
      vmaf_target: 95,
      sample_idx: 1,
      vmaf: 94.25,
      size_bytes: 123456,
      encode_seconds: 12.5,
      source_sample_bytes: 654321,
      pass2_vmaf: 93.75,
      pass2_size_bytes: 999,
      pass2_encode_seconds: 61.5,
      pass2_completed_at: 1700,
      is_pareto: 1,
      top3_role: 'balanced',
      completed_at: 1600,
    });
    insertCombo(db, runA, fileB, {
      encoder: 'qsv',
      preset: null,
      status: 'failed',
      error_reason: 'boom',
    });
    insertCombo(db, runB, fileB, { status: 'skipped', sample_idx: 2 });

    const before = db.prepare('SELECT * FROM bench_combo ORDER BY id').all();
    expect(before).toHaveLength(3);

    migrate(db);

    const after = db.prepare('SELECT * FROM bench_combo ORDER BY id').all();
    expect(after).toEqual(before);
  });

  // ── M3 row-count guard ──────────────────────────────────────────────────
  it('test_migrate_0029_when_copy_incomplete_then_aborts_and_rolls_back_schema_migrations', () => {
    migrateThrough28(db, tmpdirs);
    const fileId = insertFile(db);
    const runId = insertRun(db);
    insertCombo(db, runId, fileId);
    insertCombo(db, runId, fileId);
    const before = db.prepare('SELECT * FROM bench_combo ORDER BY id').all();

    // Sabotage the copy so bench_combo_new ends up short — exactly the failure
    // mode the guard exists for.
    const mutatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm0029-mutated-'));
    tmpdirs.push(mutatedDir);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_0029), 'utf8');
    expect(sql).toContain('FROM bench_combo bc;');
    fs.writeFileSync(
      path.join(mutatedDir, MIGRATION_0029),
      sql.replace('FROM bench_combo bc;', 'FROM bench_combo bc WHERE bc.id < 0;'),
    );

    expect(() => migrate(db, mutatedDir)).toThrow(/CHECK constraint failed/);

    expect(schemaHasVersion(db, 29)).toBe(false);
    expect(db.prepare('SELECT * FROM bench_combo ORDER BY id').all()).toEqual(before);
    expect(tableInfo(db).find((c) => c.name === 'file_id')!.notnull).toBe(1);

    // The intact migration still applies cleanly afterwards.
    expect(() => migrate(db)).not.toThrow();
    expect(schemaHasVersion(db, 29)).toBe(true);
    expect(tableInfo(db).find((c) => c.name === 'file_id')!.notnull).toBe(0);
  });

  it('test_migrate_0029_when_run_twice_then_idempotent_v29_exactly_once', () => {
    migrateThrough28(db, tmpdirs);
    migrate(db);
    migrate(db);
    const c = (
      db.prepare('SELECT COUNT(*) AS c FROM schema_migrations WHERE version = 29').get() as {
        c: number;
      }
    ).c;
    expect(c).toBe(1);
  });

  it('test_migrate_0029_when_fresh_db_from_scratch_then_chain_applies_through_29', () => {
    expect(() => migrate(db)).not.toThrow();
    expect(schemaHasVersion(db, 29)).toBe(true);
    expect(tableInfo(db).find((c) => c.name === 'file_id')!.notnull).toBe(0);
    expect(indexNames(db)).toEqual(['idx_bench_combo_run', 'idx_bench_combo_run_file']);
  });
});
