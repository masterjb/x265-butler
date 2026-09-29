/*
 * 14-04 Task 2: migration 0027 outcomes — Drop legacy share settings.
 *
 * AC-1a (happy path + idempotency): 4 legacy keys absent post-migrate,
 *   schema_migrations records version 27, re-running is no-op.
 * AC-1b (safety pre-check): empty shares AND legacy keys present trips the
 *   temp-trigger RAISE(ABORT); migrate.ts's tx wrapper rolls back BOTH the
 *   DELETE attempt AND the schema_migrations insert.
 *
 * Pattern mirrors tests/db/share-migration-backfill.test.ts:
 *   migrateThrough26() → manipulate state → migrate(db) which applies only 0027.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '@/src/lib/db/migrate';

type Db = InstanceType<typeof Database>;

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
const LEGACY_KEYS = ['scan_root', 'min_size_mb', 'extensions', 'max_depth'] as const;

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

function migrateThrough26(db: Db): string {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-migrate-0027-'));
  copyMigrationsThrough(26, tmpdir);
  migrate(db, tmpdir);
  return tmpdir;
}

function countLegacyKeys(db: Db): number {
  const placeholders = LEGACY_KEYS.map(() => '?').join(',');
  return (
    db
      .prepare<
        string[],
        { c: number }
      >(`SELECT COUNT(*) AS c FROM setting WHERE key IN (${placeholders})`)
      .get(...LEGACY_KEYS) as { c: number }
  ).c;
}

function schemaHasVersion(db: Db, version: number): boolean {
  return (
    db
      .prepare<
        [number],
        { c: number }
      >('SELECT COUNT(*) AS c FROM schema_migrations WHERE version = ?')
      .get(version)?.c === 1
  );
}

describe('migration 0027 — Drop legacy single-share settings', () => {
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

  it('test_migrate_when_4_legacy_keys_and_1_share_then_all_keys_removed_and_v27_recorded', () => {
    tmpdir = migrateThrough26(db);
    expect(countLegacyKeys(db)).toBe(4);
    expect((db.prepare('SELECT COUNT(*) AS c FROM shares').get() as { c: number }).c).toBe(1);

    migrate(db);

    expect(countLegacyKeys(db)).toBe(0);
    expect(schemaHasVersion(db, 27)).toBe(true);
  });

  it('test_migrate_when_only_2_legacy_keys_present_and_1_share_then_idempotent_and_no_error', () => {
    tmpdir = migrateThrough26(db);
    db.prepare("DELETE FROM setting WHERE key IN ('extensions', 'max_depth')").run();
    expect(countLegacyKeys(db)).toBe(2);

    expect(() => migrate(db)).not.toThrow();
    expect(countLegacyKeys(db)).toBe(0);
    expect(schemaHasVersion(db, 27)).toBe(true);
  });

  it('test_migrate_when_empty_setting_table_and_1_share_then_noop_and_v27_recorded', () => {
    tmpdir = migrateThrough26(db);
    db.prepare('DELETE FROM setting').run();
    expect(countLegacyKeys(db)).toBe(0);

    expect(() => migrate(db)).not.toThrow();
    expect(countLegacyKeys(db)).toBe(0);
    expect(schemaHasVersion(db, 27)).toBe(true);
  });

  it('test_migrate_when_empty_setting_table_and_0_shares_then_precheck_passes_v27_recorded', () => {
    tmpdir = migrateThrough26(db);
    db.prepare('DELETE FROM setting').run();
    db.prepare('DELETE FROM shares').run();
    expect(countLegacyKeys(db)).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM shares').get() as { c: number }).c).toBe(0);

    expect(() => migrate(db)).not.toThrow();
    expect(schemaHasVersion(db, 27)).toBe(true);
  });

  it('test_migrate_when_4_legacy_keys_present_and_0_shares_then_safety_aborts_and_v27_not_recorded', () => {
    tmpdir = migrateThrough26(db);
    db.prepare('DELETE FROM shares').run();
    expect(countLegacyKeys(db)).toBe(4);
    expect((db.prepare('SELECT COUNT(*) AS c FROM shares').get() as { c: number }).c).toBe(0);

    expect(() => migrate(db)).toThrow(/migration_0027_unsafe_shares_empty_legacy_present/);

    expect(countLegacyKeys(db)).toBe(4);
    expect(schemaHasVersion(db, 27)).toBe(false);
  });

  it('test_migrate_when_run_twice_then_second_run_is_noop_v27_exactly_once', () => {
    tmpdir = migrateThrough26(db);
    migrate(db);
    expect(countLegacyKeys(db)).toBe(0);
    expect(schemaHasVersion(db, 27)).toBe(true);

    migrate(db);

    expect(countLegacyKeys(db)).toBe(0);
    const versionCount = (
      db
        .prepare<
          [],
          { c: number }
        >('SELECT COUNT(*) AS c FROM schema_migrations WHERE version = 27')
        .get() as { c: number }
    ).c;
    expect(versionCount).toBe(1);
  });
});
