import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';
import { makeTrashRepo, type TrashRepo } from '@/src/lib/db/repos/trash';

type Db = InstanceType<typeof Database>;

function setupDb(): { db: Db; fileRepo: FileRepo; trashRepo: TrashRepo } {
  const db = new Database(':memory:');
  migrate(db);
  db.pragma('foreign_keys = ON');
  return { db, fileRepo: makeFileRepo(db), trashRepo: makeTrashRepo(db) };
}

function seedFile(fileRepo: FileRepo, i = 1) {
  return fileRepo.upsertByPath({
    path: `/m/f${i}.mp4`,
    size_bytes: 1000 * i,
    mtime: 1_700_000_000 + i,
    content_hash: `h${i}${'x'.repeat(60 - String(i).length)}`,
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

function seedTrash(trashRepo: TrashRepo, fileId: number, i = 1, sizeBytes = 1_000_000) {
  return trashRepo.create({
    file_id: fileId,
    original_path: `/m/f${i}.mp4`,
    trash_path: `/cache/trash/f${i}.mp4`,
    size_bytes: sizeBytes,
    retention_days: 30,
  });
}

describe('trashRepo.findById', () => {
  let db: Db;
  let fileRepo: FileRepo;
  let trashRepo: TrashRepo;

  beforeEach(() => {
    ({ db, fileRepo, trashRepo } = setupDb());
  });

  afterEach(() => {
    db.close();
  });

  it('test_findById_when_present_then_returns_row', () => {
    const file = seedFile(fileRepo, 1);
    const entry = seedTrash(trashRepo, file.id, 1);
    const found = trashRepo.findById(entry.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(entry.id);
    expect(found!.original_path).toBe('/m/f1.mp4');
    expect(found!.trash_path).toBe('/cache/trash/f1.mp4');
    expect(found!.restored_at).toBeNull();
  });

  it('test_findById_when_absent_then_returns_undefined', () => {
    const found = trashRepo.findById(9999);
    expect(found).toBeUndefined();
  });
});

describe('trashRepo.summary', () => {
  let db: Db;
  let fileRepo: FileRepo;
  let trashRepo: TrashRepo;

  beforeEach(() => {
    ({ db, fileRepo, trashRepo } = setupDb());
  });

  afterEach(() => {
    db.close();
  });

  it('test_summary_when_empty_then_zero_zero', () => {
    const s = trashRepo.summary();
    expect(s.count).toBe(0);
    expect(s.bytesReclaimed).toBe(0);
  });

  it('test_summary_after_3_inserts_then_correct_count_and_sum', () => {
    const f1 = seedFile(fileRepo, 1);
    const f2 = seedFile(fileRepo, 2);
    const f3 = seedFile(fileRepo, 3);
    seedTrash(trashRepo, f1.id, 1, 1_000_000_000);
    seedTrash(trashRepo, f2.id, 2, 500_000_000);
    seedTrash(trashRepo, f3.id, 3, 250_000_000);
    const s = trashRepo.summary();
    expect(s.count).toBe(3);
    expect(s.bytesReclaimed).toBe(1_750_000_000);
  });

  it('test_summary_excludes_restored_entries', () => {
    const f1 = seedFile(fileRepo, 1);
    const f2 = seedFile(fileRepo, 2);
    const e1 = seedTrash(trashRepo, f1.id, 1, 1_000_000_000);
    seedTrash(trashRepo, f2.id, 2, 500_000_000);
    trashRepo.restore(e1.id);
    const s = trashRepo.summary();
    // Only e2 is active (not restored)
    expect(s.count).toBe(1);
    expect(s.bytesReclaimed).toBe(500_000_000);
  });

  it('test_summary_uses_COALESCE_for_empty_table_returns_zero', () => {
    // Explicit: must return number 0, not null, for empty table
    const s = trashRepo.summary();
    expect(typeof s.bytesReclaimed).toBe('number');
    expect(typeof s.count).toBe('number');
    expect(s.bytesReclaimed).toBe(0);
    expect(s.count).toBe(0);
  });
});
