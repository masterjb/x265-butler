/*
 * Migration 0030 seeds the auto_encode master switch.
 *
 * New installs get 'false'. Existing installs (onboarding finished or any job
 * row) get the value that matches what they effectively had before: the
 * watcher's reconcile enqueued everything while auto-scan ran, and without the
 * watcher only auto_enqueue_after_scan='true' enqueued automatically.
 *
 * Pattern mirrors migration-0029: migrate through 0029 from a tmpdir copy,
 * shape the pre-0030 state, then migrate against the real migrations/ dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '@/src/lib/db/migrate';

type Db = InstanceType<typeof Database>;

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

function migrateThrough29(db: Db, tmpdirs: string[]): void {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'm0030-through29-'));
  tmpdirs.push(tmpdir);
  for (const name of fs.readdirSync(MIGRATIONS_DIR)) {
    const match = name.match(/^(\d+)_.*\.sql$/);
    if (match && parseInt(match[1], 10) <= 29) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(tmpdir, name));
    }
  }
  migrate(db, tmpdir);
}

function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

function autoEncode(db: Db): string | undefined {
  return (
    db.prepare("SELECT value FROM setting WHERE key = 'auto_encode'").get() as
      { value: string } | undefined
  )?.value;
}

function seedJob(db: Db): void {
  const fileId = db
    .prepare(
      `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at)
       VALUES ('/media/a.mkv', 1, 1, 'h', 1)`,
    )
    .run().lastInsertRowid;
  db.prepare("INSERT INTO job (file_id, status) VALUES (?, 'done')").run(fileId);
}

describe('migration 0030 — auto_encode master switch', () => {
  let db: Db;
  const tmpdirs: string[] = [];

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
    for (const d of tmpdirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('test_0030_when_fresh_install_then_auto_encode_false', () => {
    migrate(db);
    expect(autoEncode(db)).toBe('false');
  });

  it('test_0030_when_onboarded_and_autoscan_key_missing_then_true', () => {
    migrateThrough29(db, tmpdirs);
    setSetting(db, 'onboarding_completed', 'true');
    migrate(db);
    expect(autoEncode(db)).toBe('true');
  });

  it('test_0030_when_onboarded_and_autoscan_on_then_true', () => {
    migrateThrough29(db, tmpdirs);
    setSetting(db, 'onboarding_completed', 'true');
    setSetting(db, 'autoScan.enabled', 'true');
    migrate(db);
    expect(autoEncode(db)).toBe('true');
  });

  it('test_0030_when_onboarded_autoscan_off_and_scan_enqueue_on_then_true', () => {
    migrateThrough29(db, tmpdirs);
    setSetting(db, 'onboarding_completed', 'true');
    setSetting(db, 'autoScan.enabled', 'false');
    setSetting(db, 'auto_enqueue_after_scan', 'true');
    migrate(db);
    expect(autoEncode(db)).toBe('true');
  });

  it('test_0030_when_onboarded_autoscan_off_and_scan_enqueue_off_then_false', () => {
    migrateThrough29(db, tmpdirs);
    setSetting(db, 'onboarding_completed', 'true');
    setSetting(db, 'autoScan.enabled', 'false');
    setSetting(db, 'auto_enqueue_after_scan', 'false');
    migrate(db);
    expect(autoEncode(db)).toBe('false');
  });

  it('test_0030_when_not_onboarded_but_jobs_exist_then_true', () => {
    migrateThrough29(db, tmpdirs);
    seedJob(db);
    migrate(db);
    expect(autoEncode(db)).toBe('true');
  });

  it('test_0030_when_not_onboarded_and_no_jobs_then_false', () => {
    migrateThrough29(db, tmpdirs);
    migrate(db);
    expect(autoEncode(db)).toBe('false');
  });

  it('test_0030_when_value_already_present_then_untouched', () => {
    migrateThrough29(db, tmpdirs);
    setSetting(db, 'onboarding_completed', 'true');
    setSetting(db, 'auto_encode', 'false');
    migrate(db);
    expect(autoEncode(db)).toBe('false');
  });

  it('test_0030_when_run_twice_then_single_row', () => {
    migrate(db);
    migrate(db);
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM setting WHERE key = 'auto_encode'").get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(1);
  });
});
