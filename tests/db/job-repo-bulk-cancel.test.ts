// 05-09 audit S6: markCancelledBulk + cancelJobsAndPendFilesTx — atomic
// bulk cancel + file→pending for /api/queue/cancel-all single-TX path.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';
import { makeJobRepo, type JobRepo } from '@/src/lib/db/repos/job';

type Db = InstanceType<typeof Database>;

function setupDb(): { db: Db; fileRepo: FileRepo; jobRepo: JobRepo } {
  const db = new Database(':memory:');
  migrate(db);
  db.pragma('foreign_keys = ON');
  const fileRepo = makeFileRepo(db);
  const jobRepo = makeJobRepo(db, {
    setFileStatus: (id, status, expectedVersion) => fileRepo.setStatus(id, status, expectedVersion),
    bulkSetFileStatusToPending: (ids, expectedStates) =>
      fileRepo.bulkSetStatusToPendingByIds(ids, expectedStates),
  });
  return { db, fileRepo, jobRepo };
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

describe('jobRepo.markCancelledBulk', () => {
  let db: Db;
  let fileRepo: FileRepo;
  let jobRepo: JobRepo;

  beforeEach(() => {
    ({ db, fileRepo, jobRepo } = setupDb());
  });

  afterEach(() => {
    db.close();
  });

  it('test_markCancelledBulk_when_empty_array_then_zero_no_sql_execution', () => {
    const changes = jobRepo.markCancelledBulk([]);
    expect(changes).toBe(0);
  });

  it('test_markCancelledBulk_when_queued_and_encoding_then_both_cancelled_status_guarded', () => {
    const f1 = seedFile(fileRepo, '/m/1.mp4', 'a'.repeat(64));
    const f2 = seedFile(fileRepo, '/m/2.mp4', 'b'.repeat(64));
    const j1 = jobRepo.enqueue(f1.id, 'libx265', f1.version, null);
    const j2 = jobRepo.enqueue(f2.id, 'libx265', f2.version, null);
    expect(j1).not.toBeNull();
    expect(j2).not.toBeNull();
    db.prepare("UPDATE job SET status='encoding' WHERE id = ?").run(j2!.id);
    const changes = jobRepo.markCancelledBulk([j1!.id, j2!.id]);
    expect(changes).toBe(2);
    const rows = db.prepare('SELECT id, status FROM job ORDER BY id').all() as {
      id: number;
      status: string;
    }[];
    expect(rows.every((r) => r.status === 'cancelled')).toBe(true);
  });

  it('test_markCancelledBulk_when_terminal_rows_then_status_guard_skips', () => {
    const f1 = seedFile(fileRepo, '/m/3.mp4', 'c'.repeat(64));
    const j = jobRepo.enqueue(f1.id, 'libx265', f1.version, null);
    db.prepare("UPDATE job SET status='done', finished_at=1 WHERE id=?").run(j!.id);
    const changes = jobRepo.markCancelledBulk([j!.id]);
    expect(changes).toBe(0);
  });
});

describe('jobRepo.cancelJobsAndPendFilesTx', () => {
  let db: Db;
  let fileRepo: FileRepo;
  let jobRepo: JobRepo;

  beforeEach(() => {
    ({ db, fileRepo, jobRepo } = setupDb());
  });

  afterEach(() => {
    db.close();
  });

  it('test_cancelJobsAndPendFilesTx_when_empty_then_zero_zero_no_tx', () => {
    const result = jobRepo.cancelJobsAndPendFilesTx([], [], ['queued', 'encoding']);
    expect(result).toEqual({ cancelled: 0, fileChanges: 0 });
  });

  it('test_cancelJobsAndPendFilesTx_when_mixed_then_atomic_both_writes_commit', () => {
    const f1 = seedFile(fileRepo, '/m/1.mp4', 'a'.repeat(64));
    const f2 = seedFile(fileRepo, '/m/2.mp4', 'b'.repeat(64));
    const j1 = jobRepo.enqueue(f1.id, 'libx265', f1.version, null);
    const j2 = jobRepo.enqueue(f2.id, 'libx265', f2.version, null);
    db.prepare("UPDATE job SET status='encoding' WHERE id=?").run(j2!.id);
    db.prepare("UPDATE file SET status='encoding', version=version+1 WHERE id=?").run(f2.id);
    const result = jobRepo.cancelJobsAndPendFilesTx(
      [j1!.id, j2!.id],
      [f1.id, f2.id],
      ['queued', 'encoding'],
    );
    expect(result.cancelled).toBe(2);
    expect(result.fileChanges).toBe(2);
    const fileStatuses = db.prepare('SELECT status FROM file ORDER BY id').all() as {
      status: string;
    }[];
    expect(fileStatuses.every((r) => r.status === 'pending')).toBe(true);
    const jobStatuses = db.prepare('SELECT status FROM job ORDER BY id').all() as {
      status: string;
    }[];
    expect(jobStatuses.every((r) => r.status === 'cancelled')).toBe(true);
  });
});
