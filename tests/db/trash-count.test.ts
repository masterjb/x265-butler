import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo } from '@/src/lib/db/repos/file';
import { makeTrashRepo, type TrashRepo } from '@/src/lib/db/repos/trash';

type Db = InstanceType<typeof Database>;

describe('TrashRepo.count (02-03 additive)', () => {
  let db: Db;
  let trashRepo: TrashRepo;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
    db.pragma('foreign_keys = ON');
    const fileRepo = makeFileRepo(db);
    trashRepo = makeTrashRepo(db);

    // Seed file rows so trash entries can FK to them.
    for (let i = 1; i <= 5; i++) {
      fileRepo.upsertByPath({
        path: `/m/f${i}.mp4`,
        size_bytes: 1000,
        mtime: 1700000000,
        content_hash: `h${i}`,
        codec: 'h264',
        bitrate: 1000,
        duration_seconds: 10,
        width: 100,
        height: 100,
        container: 'mp4',
        last_scanned_at: 1700000000,

        share_id: null,
      });
    }
  });

  afterEach(() => {
    db.close();
  });

  it('test_count_when_empty_then_zero', () => {
    expect(trashRepo.count()).toBe(0);
  });

  it('test_count_after_3_inserts_then_3', () => {
    for (let i = 1; i <= 3; i++) {
      trashRepo.create({
        file_id: i,
        original_path: `/m/f${i}.mp4`,
        trash_path: `/cache/trash/${i}-foo/f${i}.mp4`,
        size_bytes: 1000,
        retention_days: 30,
      });
    }
    expect(trashRepo.count()).toBe(3);
  });

  it('test_count_excludes_restored_by_default', () => {
    const t1 = trashRepo.create({
      file_id: 1,
      original_path: '/m/f1.mp4',
      trash_path: '/cache/trash/1-foo/f1.mp4',
      size_bytes: 1000,
      retention_days: 30,
    });
    trashRepo.create({
      file_id: 2,
      original_path: '/m/f2.mp4',
      trash_path: '/cache/trash/2-foo/f2.mp4',
      size_bytes: 1000,
      retention_days: 30,
    });
    trashRepo.restore(t1.id);
    expect(trashRepo.count()).toBe(1); // only the non-restored one
    expect(trashRepo.count(true)).toBe(2); // includeRestored=true
  });
});
