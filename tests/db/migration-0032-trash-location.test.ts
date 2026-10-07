/*
 * Migration 0032 seeds trash_location.
 *
 * New installs get 'share' (trash inside the share of the file). Existing
 * installs (onboarding finished or any job row) get 'cache', the place they
 * used before. An existing value is never touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '@/src/lib/db/migrate';

type Db = InstanceType<typeof Database>;

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

function migrateThrough31(db: Db, tmpdirs: string[]): void {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'm0032-through31-'));
  tmpdirs.push(tmpdir);
  for (const name of fs.readdirSync(MIGRATIONS_DIR)) {
    const match = name.match(/^(\d+)_.*\.sql$/);
    if (match && parseInt(match[1], 10) <= 31) {
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

function trashLocation(db: Db): string | undefined {
  return (
    db.prepare("SELECT value FROM setting WHERE key = 'trash_location'").get() as
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

describe('migration 0032: trash_location seed', () => {
  let db: Db;
  const tmpdirs: string[] = [];

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
    for (const d of tmpdirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('fresh install gets the share location', () => {
    migrate(db);
    expect(trashLocation(db)).toBe('share');
  });

  it('onboarded install keeps the cache location', () => {
    migrateThrough31(db, tmpdirs);
    setSetting(db, 'onboarding_completed', 'true');
    migrate(db);
    expect(trashLocation(db)).toBe('cache');
  });

  it('install with jobs keeps the cache location', () => {
    migrateThrough31(db, tmpdirs);
    seedJob(db);
    migrate(db);
    expect(trashLocation(db)).toBe('cache');
  });

  it('not onboarded and no jobs gets the share location', () => {
    migrateThrough31(db, tmpdirs);
    migrate(db);
    expect(trashLocation(db)).toBe('share');
  });

  it('an existing value is left untouched', () => {
    migrateThrough31(db, tmpdirs);
    setSetting(db, 'onboarding_completed', 'true');
    setSetting(db, 'trash_location', 'share');
    migrate(db);
    expect(trashLocation(db)).toBe('share');
  });

  it('running twice keeps a single row', () => {
    migrate(db);
    migrate(db);
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM setting WHERE key = 'trash_location'").get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(1);
  });
});
