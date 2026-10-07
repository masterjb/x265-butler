// @vitest-environment node
// Job repository helpers used when a stalled encode is retried: the previous
// finished job of a file, and moving a queued job ahead of all others while
// queue_position stays non-negative.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';
import { makeJobRepo, type JobRepo } from '@/src/lib/db/repos/job';

type Db = InstanceType<typeof Database>;
let db: Db;
let fileRepo: FileRepo;
let jobRepo: JobRepo;

function seedFile(p: string): number {
  return fileRepo.upsertByPath({
    path: p,
    size_bytes: 1000,
    mtime: 1_700_000_000,
    content_hash: 'a'.repeat(64),
    codec: 'h264',
    bitrate: 1,
    duration_seconds: 60,
    width: 1920,
    height: 1080,
    container: 'mp4',
    last_scanned_at: 1_700_000_000,
    share_id: null,
  }).id;
}

function position(id: number): number {
  return (
    db.prepare('SELECT queue_position FROM job WHERE id = ?').get(id) as {
      queue_position: number;
    }
  ).queue_position;
}

function claimOrder(): number[] {
  return (
    db
      .prepare(
        "SELECT id FROM job WHERE status = 'queued' ORDER BY queue_position ASC, created_at ASC, id ASC",
      )
      .all() as { id: number }[]
  ).map((r) => r.id);
}

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  db.pragma('foreign_keys = ON');
  fileRepo = makeFileRepo(db);
  jobRepo = makeJobRepo(db, {
    setFileStatus: (id, status, v) => fileRepo.setStatus(id, status, v),
    bulkSetFileStatusToPending: (ids, s) => fileRepo.bulkSetStatusToPendingByIds(ids, s),
  });
});

afterEach(() => db.close());

describe('findPreviousFinishedByFileId', () => {
  it('returns the latest finished job of the file older than the given job', () => {
    const f = seedFile('/m/a.mkv');
    const other = seedFile('/m/b.mkv');
    const j1 = jobRepo.create({ file_id: f, encoder: 'libx265', crf: null })!;
    db.prepare(
      "UPDATE job SET status='failed', finished_at=1, error_msg='encode_stalled' WHERE id=?",
    ).run(j1.id);
    const jOther = jobRepo.create({ file_id: other, encoder: 'libx265', crf: null })!;
    db.prepare("UPDATE job SET status='done', finished_at=2 WHERE id=?").run(jOther.id);
    const j2 = jobRepo.create({ file_id: f, encoder: 'libx265', crf: null })!;

    const prev = jobRepo.findPreviousFinishedByFileId(f, j2.id);
    expect(prev?.id).toBe(j1.id);
    expect(prev?.error_msg).toBe('encode_stalled');
  });

  it('returns undefined when the file has no earlier finished job', () => {
    const f = seedFile('/m/a.mkv');
    const j1 = jobRepo.create({ file_id: f, encoder: 'libx265', crf: null })!;
    expect(jobRepo.findPreviousFinishedByFileId(f, j1.id)).toBeUndefined();
  });
});

describe('moveToFront', () => {
  it('puts the job ahead of every queued job when positions start above zero', () => {
    const ids = ['/m/1', '/m/2', '/m/3'].map(
      (p) => jobRepo.create({ file_id: seedFile(p), encoder: 'libx265', crf: null })!.id,
    );
    expect(jobRepo.moveToFront(ids[2])).toBe(true);
    expect(claimOrder()).toEqual([ids[2], ids[0], ids[1]]);
    expect(position(ids[2])).toBeGreaterThanOrEqual(0);
  });

  it('shifts the others when the front position is already zero', () => {
    const ids = ['/m/1', '/m/2', '/m/3'].map(
      (p) => jobRepo.create({ file_id: seedFile(p), encoder: 'libx265', crf: null })!.id,
    );
    db.prepare('UPDATE job SET queue_position = 0 WHERE id = ?').run(ids[0]);
    expect(jobRepo.moveToFront(ids[2])).toBe(true);
    expect(claimOrder()[0]).toBe(ids[2]);
    expect(claimOrder().slice(1)).toEqual([ids[0], ids[1]]);
    const min = (db.prepare('SELECT MIN(queue_position) AS m FROM job').get() as { m: number }).m;
    expect(min).toBe(0);
  });

  it('does nothing for a job that is not queued and leaves the others in place', () => {
    const other = jobRepo.create({ file_id: seedFile('/m/0'), encoder: 'libx265', crf: null })!.id;
    db.prepare('UPDATE job SET queue_position = 0 WHERE id = ?').run(other);
    const id = jobRepo.create({ file_id: seedFile('/m/1'), encoder: 'libx265', crf: null })!.id;
    db.prepare("UPDATE job SET status='encoding' WHERE id=?").run(id);
    expect(jobRepo.moveToFront(id)).toBe(false);
    expect(position(other)).toBe(0);
  });
});
