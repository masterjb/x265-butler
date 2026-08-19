// 05-09 audit M2: bulkSetStatusToPendingByIds — status-guarded bulk file→pending
// helper for cancel-all single-TX path. Per-row setStatus is FORBIDDEN inside
// cancelAllQueued (race window with concurrent scan/trash on stale version).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';

type Db = InstanceType<typeof Database>;

function setupDb(): { db: Db; fileRepo: FileRepo } {
  const db = new Database(':memory:');
  migrate(db);
  db.pragma('foreign_keys = ON');
  const fileRepo = makeFileRepo(db);
  return { db, fileRepo };
}

function seedFile(fileRepo: FileRepo, p: string, hash: string) {
  return fileRepo.upsertByPath({
    path: p,
    size_bytes: 1000,
    mtime: 1700000000,
    content_hash: hash,
    codec: 'h264',
    bitrate: 5_000_000,
    duration_seconds: 60,
    width: 1280,
    height: 720,
    container: 'mp4',
    last_scanned_at: 1700000000,

    share_id: null,
  });
}

describe('fileRepo.bulkSetStatusToPendingByIds', () => {
  let db: Db;
  let fileRepo: FileRepo;

  beforeEach(() => {
    ({ db, fileRepo } = setupDb());
  });

  afterEach(() => {
    db.close();
  });

  it('test_bulk_when_empty_ids_then_zero_no_op', () => {
    const changes = fileRepo.bulkSetStatusToPendingByIds([], ['queued', 'encoding']);
    expect(changes).toBe(0);
  });

  it('test_bulk_when_queued_and_encoding_then_both_flip_to_pending_version_bumped', () => {
    const f1 = seedFile(fileRepo, '/m/1.mp4', 'a'.repeat(64));
    const f2 = seedFile(fileRepo, '/m/2.mp4', 'b'.repeat(64));
    db.prepare("UPDATE file SET status='queued', version=version+1 WHERE id=?").run(f1.id);
    db.prepare("UPDATE file SET status='encoding', version=version+1 WHERE id=?").run(f2.id);
    const v1Before = (
      db.prepare('SELECT version FROM file WHERE id=?').get(f1.id) as { version: number }
    ).version;
    const v2Before = (
      db.prepare('SELECT version FROM file WHERE id=?').get(f2.id) as { version: number }
    ).version;
    const changes = fileRepo.bulkSetStatusToPendingByIds([f1.id, f2.id], ['queued', 'encoding']);
    expect(changes).toBe(2);
    const after = db.prepare('SELECT id, status, version FROM file ORDER BY id').all() as {
      id: number;
      status: string;
      version: number;
    }[];
    expect(after[0].status).toBe('pending');
    expect(after[1].status).toBe('pending');
    expect(after[0].version).toBe(v1Before + 1);
    expect(after[1].version).toBe(v2Before + 1);
  });

  it('test_bulk_when_status_outside_guard_then_status_guard_skips_no_flip', () => {
    const f1 = seedFile(fileRepo, '/m/1.mp4', 'a'.repeat(64));
    db.prepare("UPDATE file SET status='done-smaller', version=version+1 WHERE id=?").run(f1.id);
    const changes = fileRepo.bulkSetStatusToPendingByIds([f1.id], ['queued', 'encoding']);
    expect(changes).toBe(0);
    const status = (
      db.prepare('SELECT status FROM file WHERE id=?').get(f1.id) as { status: string }
    ).status;
    expect(status).toBe('done-smaller');
  });

  it('test_bulk_when_empty_expected_states_then_throws_TypeError', () => {
    const f1 = seedFile(fileRepo, '/m/1.mp4', 'a'.repeat(64));
    expect(() => fileRepo.bulkSetStatusToPendingByIds([f1.id], [])).toThrow(TypeError);
  });

  it('test_bulk_when_invalid_expected_state_then_throws_TypeError', () => {
    const f1 = seedFile(fileRepo, '/m/1.mp4', 'a'.repeat(64));
    expect(() => fileRepo.bulkSetStatusToPendingByIds([f1.id], ['bogus' as 'queued'])).toThrow(
      TypeError,
    );
  });
});
