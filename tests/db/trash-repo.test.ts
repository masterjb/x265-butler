import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';
import { computeExpiresAt, makeTrashRepo, type TrashRepo } from '@/src/lib/db/repos/trash';

type Db = InstanceType<typeof Database>;

const SECONDS_PER_DAY = 86_400;

function setupDb(): { db: Db; fileRepo: FileRepo; trashRepo: TrashRepo } {
  const db = new Database(':memory:');
  migrate(db);
  // audit-added M3: FK enforcement for SET NULL claims.
  db.pragma('foreign_keys = ON');
  const fkOn = db.pragma('foreign_keys', { simple: true });
  if (fkOn !== 1) throw new Error(`expected foreign_keys=1, got ${String(fkOn)}`);
  const fileRepo = makeFileRepo(db);
  const trashRepo = makeTrashRepo(db);
  return { db, fileRepo, trashRepo };
}

function seedFile(fileRepo: FileRepo, p = '/media/x.mp4', hash = 'a'.repeat(64)) {
  return fileRepo.upsertByPath({
    path: p,
    size_bytes: 1000,
    mtime: 1_700_000_000,
    content_hash: hash,
    codec: 'h264',
    bitrate: 5_000_000,
    duration_seconds: 60,
    width: 1920,
    height: 1080,
    container: 'mp4',
    last_scanned_at: 1_700_000_500,

    share_id: null,
  });
}

describe('makeTrashRepo', () => {
  let db: Db;
  let fileRepo: FileRepo;
  let trashRepo: TrashRepo;

  beforeEach(() => {
    ({ db, fileRepo, trashRepo } = setupDb());
  });

  afterEach(() => {
    db.close();
  });

  it('test_create_when_called_then_inserts_with_trashed_at_now_expires_at_computed', () => {
    const file = seedFile(fileRepo);
    const before = Math.floor(Date.now() / 1000);
    const entry = trashRepo.create({
      file_id: file.id,
      original_path: '/media/x.mp4',
      trash_path: '/cache/trash/x.mp4',
      size_bytes: 1_000_000_000,
      retention_days: 30,
    });
    expect(entry.trashed_at).toBeGreaterThanOrEqual(before);
    expect(entry.expires_at).toBe(entry.trashed_at + 30 * SECONDS_PER_DAY);
    expect(entry.restored_at).toBeNull();
  });

  it('test_create_when_retention_30_days_then_expires_at_is_trashed_at_plus_2_592_000', () => {
    const file = seedFile(fileRepo);
    const entry = trashRepo.create({
      file_id: file.id,
      original_path: '/m/a.mp4',
      trash_path: '/c/a.mp4',
      size_bytes: 100,
      retention_days: 30,
    });
    expect(entry.expires_at - entry.trashed_at).toBe(2_592_000);
  });

  // S3 retention validation
  for (const bad of [0, -1, 3651, NaN, Infinity, 1.5]) {
    it(`test_create_when_retention_${String(bad)}_then_throws_RangeError`, () => {
      const file = seedFile(fileRepo);
      expect(() =>
        trashRepo.create({
          file_id: file.id,
          original_path: '/m/x.mp4',
          trash_path: `/c/x-${String(bad)}.mp4`,
          size_bytes: 1,
          retention_days: bad,
        }),
      ).toThrow(RangeError);
    });
  }

  it('test_create_when_retention_invalid_then_no_DB_row_inserted', () => {
    const file = seedFile(fileRepo);
    const before = (db.prepare('SELECT COUNT(*) AS c FROM trash_entry').get() as { c: number }).c;
    expect(() =>
      trashRepo.create({
        file_id: file.id,
        original_path: '/m/x.mp4',
        trash_path: '/c/x.mp4',
        size_bytes: 1,
        retention_days: 0,
      }),
    ).toThrow(RangeError);
    const after = (db.prepare('SELECT COUNT(*) AS c FROM trash_entry').get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it('test_list_when_called_then_orders_by_trashed_at_desc_excludes_restored', () => {
    const file = seedFile(fileRepo);
    const e1 = trashRepo.create({
      file_id: file.id,
      original_path: '/m/a.mp4',
      trash_path: '/c/a.mp4',
      size_bytes: 100,
      retention_days: 30,
    });
    db.prepare('UPDATE trash_entry SET trashed_at = ? WHERE id = ?').run(1000, e1.id);
    const e2 = trashRepo.create({
      file_id: file.id,
      original_path: '/m/b.mp4',
      trash_path: '/c/b.mp4',
      size_bytes: 100,
      retention_days: 30,
    });
    db.prepare('UPDATE trash_entry SET trashed_at = ? WHERE id = ?').run(2000, e2.id);
    trashRepo.restore(e2.id);
    const result = trashRepo.list({ page: 1, size: 50 });
    expect(result.total).toBe(1);
    expect(result.rows[0].id).toBe(e1.id);
  });

  it('test_list_when_includeRestored_true_then_includes_restored_entries', () => {
    const file = seedFile(fileRepo);
    const e = trashRepo.create({
      file_id: file.id,
      original_path: '/m/a.mp4',
      trash_path: '/c/a.mp4',
      size_bytes: 100,
      retention_days: 30,
    });
    trashRepo.restore(e.id);
    const result = trashRepo.list({ page: 1, size: 50, includeRestored: true });
    expect(result.total).toBe(1);
    expect(result.rows[0].restored_at).not.toBeNull();
  });

  it('test_list_when_paginated_then_respects_page_size_offset', () => {
    const file = seedFile(fileRepo);
    for (let i = 0; i < 5; i++) {
      const e = trashRepo.create({
        file_id: file.id,
        original_path: `/m/${i}.mp4`,
        trash_path: `/c/${i}.mp4`,
        size_bytes: 100,
        retention_days: 30,
      });
      db.prepare('UPDATE trash_entry SET trashed_at = ? WHERE id = ?').run(1000 + i, e.id);
    }
    const page1 = trashRepo.list({ page: 1, size: 2 });
    const page2 = trashRepo.list({ page: 2, size: 2 });
    expect(page1.total).toBe(5);
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(2);
    // page1 newest first → trashed_at = 1004 then 1003
    expect(page1.rows.map((r) => r.trashed_at)).toEqual([1004, 1003]);
    expect(page2.rows.map((r) => r.trashed_at)).toEqual([1002, 1001]);
  });

  it('test_restore_when_called_then_sets_restored_at_now', () => {
    const file = seedFile(fileRepo);
    const e = trashRepo.create({
      file_id: file.id,
      original_path: '/m/a.mp4',
      trash_path: '/c/a.mp4',
      size_bytes: 100,
      retention_days: 30,
    });
    expect(trashRepo.restore(e.id)).toBe(true);
    const list = trashRepo.list({ page: 1, size: 10 });
    expect(list.total).toBe(0);
  });

  it('test_restore_when_already_restored_then_returns_false', () => {
    const file = seedFile(fileRepo);
    const e = trashRepo.create({
      file_id: file.id,
      original_path: '/m/a.mp4',
      trash_path: '/c/a.mp4',
      size_bytes: 100,
      retention_days: 30,
    });
    expect(trashRepo.restore(e.id)).toBe(true);
    expect(trashRepo.restore(e.id)).toBe(false);
  });

  it('test_deleteExpired_when_some_past_some_future_then_deletes_only_past_unrestored', () => {
    const file = seedFile(fileRepo);
    const past = trashRepo.create({
      file_id: file.id,
      original_path: '/m/past.mp4',
      trash_path: '/c/past.mp4',
      size_bytes: 100,
      retention_days: 1,
    });
    db.prepare('UPDATE trash_entry SET expires_at = ? WHERE id = ?').run(100, past.id);
    const future = trashRepo.create({
      file_id: file.id,
      original_path: '/m/future.mp4',
      trash_path: '/c/future.mp4',
      size_bytes: 100,
      retention_days: 30,
    });
    const deleted = trashRepo.deleteExpired(1000);
    expect(deleted).toBe(1);
    expect(db.prepare('SELECT id FROM trash_entry').all()).toEqual([{ id: future.id }]);
  });

  it('test_deleteExpired_when_restored_entry_past_expiry_then_NOT_deleted', () => {
    const file = seedFile(fileRepo);
    const e = trashRepo.create({
      file_id: file.id,
      original_path: '/m/a.mp4',
      trash_path: '/c/a.mp4',
      size_bytes: 100,
      retention_days: 1,
    });
    db.prepare('UPDATE trash_entry SET expires_at = 100 WHERE id = ?').run(e.id);
    trashRepo.restore(e.id);
    expect(trashRepo.deleteExpired(1000)).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM trash_entry').get() as { c: number }).c).toBe(1);
  });

  // S4 batch
  it('test_deleteExpired_when_more_than_batchSize_expired_then_deletes_only_batchSize', () => {
    const file = seedFile(fileRepo);
    for (let i = 0; i < 50; i++) {
      const e = trashRepo.create({
        file_id: file.id,
        original_path: `/m/${i}.mp4`,
        trash_path: `/c/${i}.mp4`,
        size_bytes: 100,
        retention_days: 30,
      });
      db.prepare('UPDATE trash_entry SET expires_at = 100 WHERE id = ?').run(e.id);
    }
    expect(trashRepo.deleteExpired(1000, 10)).toBe(10);
    expect((db.prepare('SELECT COUNT(*) AS c FROM trash_entry').get() as { c: number }).c).toBe(40);
    let drained = 0;
    while (true) {
      const n = trashRepo.deleteExpired(1000, 10);
      drained += n;
      if (n === 0) break;
    }
    expect(drained).toBe(40);
    expect((db.prepare('SELECT COUNT(*) AS c FROM trash_entry').get() as { c: number }).c).toBe(0);
  });

  it('test_deleteExpired_when_batchSize_huge_then_clamped_to_max_10000', () => {
    const file = seedFile(fileRepo);
    const e = trashRepo.create({
      file_id: file.id,
      original_path: '/m/a.mp4',
      trash_path: '/c/a.mp4',
      size_bytes: 100,
      retention_days: 30,
    });
    db.prepare('UPDATE trash_entry SET expires_at = 100 WHERE id = ?').run(e.id);
    // Pathological huge batch — should still complete (clamp prevents overflow / massive bind).
    expect(trashRepo.deleteExpired(1000, 99_999_999)).toBe(1);
  });

  it('test_deleteExpired_when_batchSize_zero_or_negative_then_clamped_to_at_least_1', () => {
    const file = seedFile(fileRepo);
    const e = trashRepo.create({
      file_id: file.id,
      original_path: '/m/a.mp4',
      trash_path: '/c/a.mp4',
      size_bytes: 100,
      retention_days: 30,
    });
    db.prepare('UPDATE trash_entry SET expires_at = 100 WHERE id = ?').run(e.id);
    expect(trashRepo.deleteExpired(1000, 0)).toBe(1);
  });

  // M3 FK SET NULL
  it('test_FK_when_file_deleted_then_trash_entry_file_id_set_null', () => {
    const file = seedFile(fileRepo);
    trashRepo.create({
      file_id: file.id,
      original_path: '/m/a.mp4',
      trash_path: '/c/a.mp4',
      size_bytes: 100,
      retention_days: 30,
    });
    db.prepare('DELETE FROM file WHERE id = ?').run(file.id);
    const row = db.prepare('SELECT file_id FROM trash_entry').get() as { file_id: number | null };
    expect(row.file_id).toBeNull();
  });

  it('test_computeExpiresAt_pure_function_correct_arithmetic', () => {
    expect(computeExpiresAt(1000, 1)).toBe(1000 + SECONDS_PER_DAY);
    expect(computeExpiresAt(0, 30)).toBe(30 * SECONDS_PER_DAY);
    expect(computeExpiresAt(1_700_000_000, 365)).toBe(1_700_000_000 + 365 * SECONDS_PER_DAY);
  });

  it('test_computeExpiresAt_when_retention_invalid_then_throws_RangeError', () => {
    expect(() => computeExpiresAt(1000, 0)).toThrow(RangeError);
    expect(() => computeExpiresAt(1000, -1)).toThrow(RangeError);
    expect(() => computeExpiresAt(1000, 3651)).toThrow(RangeError);
    expect(() => computeExpiresAt(1000, NaN)).toThrow(RangeError);
    expect(() => computeExpiresAt(1000, 1.5)).toThrow(RangeError);
  });
});
