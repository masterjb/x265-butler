// @vitest-environment node
// Migration 0031 adds job.queue_pinned. Existing rows get 0 (nothing pinned, so
// the pick order is unchanged) and the column only accepts 0 or 1.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '@/src/lib/db/migrate';

type Db = InstanceType<typeof Database>;

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

function migrateThrough30(db: Db, tmpdirs: string[]): void {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'm0031-through30-'));
  tmpdirs.push(tmpdir);
  for (const name of fs.readdirSync(MIGRATIONS_DIR)) {
    const match = name.match(/^(\d+)_.*\.sql$/);
    if (match && parseInt(match[1], 10) <= 30) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(tmpdir, name));
    }
  }
  migrate(db, tmpdir);
}

describe('migration 0031: job.queue_pinned', () => {
  let db: Db;
  const tmpdirs: string[] = [];

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
    for (const d of tmpdirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('existing queued rows get 0 and keep their position', () => {
    migrateThrough30(db, tmpdirs);
    const fileId = db
      .prepare(
        `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at)
         VALUES ('/media/a.mkv', 1, 1, 'h', 1)`,
      )
      .run().lastInsertRowid;
    db.prepare("INSERT INTO job (file_id, status, queue_position) VALUES (?, 'queued', 7)").run(
      fileId,
    );
    migrate(db);
    const row = db.prepare('SELECT queue_pinned, queue_position FROM job').get() as {
      queue_pinned: number;
      queue_position: number;
    };
    expect(row).toEqual({ queue_pinned: 0, queue_position: 7 });
  });

  it('rejects values other than 0 and 1', () => {
    migrate(db);
    const fileId = db
      .prepare(
        `INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at)
         VALUES ('/media/b.mkv', 1, 1, 'h', 1)`,
      )
      .run().lastInsertRowid;
    expect(() =>
      db
        .prepare("INSERT INTO job (file_id, status, queue_pinned) VALUES (?, 'queued', 2)")
        .run(fileId),
    ).toThrow(/CHECK constraint failed/);
  });
});
