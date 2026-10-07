// @vitest-environment node
// Job repository helpers used to put interrupted jobs back in the queue after a
// restart: recovery returns the rows it touched, the finished history of a file,
// the guarded writes on interrupted rows, and one transaction around all of it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';
import { makeJobRepo, type JobRepo } from '@/src/lib/db/repos/job';
import { toScanMtime } from '@/src/lib/scan/walker';

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

function encoding(fileId: number): number {
  const j = jobRepo.create({ file_id: fileId, encoder: 'libx265', crf: null })!;
  db.prepare("UPDATE job SET status='encoding', started_at=100 WHERE id=?").run(j.id);
  return j.id;
}

const row = (id: number) =>
  db.prepare('SELECT status, error_msg, finished_at FROM job WHERE id=?').get(id) as {
    status: string;
    error_msg: string | null;
    finished_at: number | null;
  };

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

describe('recoverStaleEncoding', () => {
  it('returns the rows it marked interrupted and nothing else', () => {
    const a = encoding(seedFile('/m/a.mkv'));
    const b = encoding(seedFile('/m/b.mkv'));
    const waiting = jobRepo.create({
      file_id: seedFile('/m/c.mkv'),
      encoder: 'libx265',
      crf: null,
    })!;
    const old = jobRepo.create({ file_id: seedFile('/m/d.mkv'), encoder: 'libx265', crf: null })!;
    db.prepare("UPDATE job SET status='interrupted', finished_at=5 WHERE id=?").run(old.id);

    const rows = jobRepo.recoverStaleEncoding(500, 0);

    expect(rows.map((r) => r.id).sort()).toEqual([a, b].sort());
    expect(rows.every((r) => r.status === 'interrupted' && r.finished_at === 500)).toBe(true);
    expect(row(waiting.id).status).toBe('queued');
    expect(row(old.id).finished_at).toBe(5);
    expect(jobRepo.recoverStaleEncoding(600, 0)).toEqual([]);
  });
});

describe('listFinishedByFileId', () => {
  it('lists finished jobs of the file up to and including the given job, newest first', () => {
    const f = seedFile('/m/a.mkv');
    const other = seedFile('/m/b.mkv');
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const j = jobRepo.create({ file_id: f, encoder: 'libx265', crf: null })!;
      db.prepare("UPDATE job SET status='interrupted', finished_at=? WHERE id=?").run(i + 1, j.id);
      ids.push(j.id);
    }
    const foreign = jobRepo.create({ file_id: other, encoder: 'libx265', crf: null })!;
    db.prepare("UPDATE job SET status='done', finished_at=9 WHERE id=?").run(foreign.id);
    const later = jobRepo.create({ file_id: f, encoder: 'libx265', crf: null })!;

    expect(jobRepo.listFinishedByFileId(f, ids[2], 10).map((r) => r.id)).toEqual(
      [...ids].reverse(),
    );
    expect(jobRepo.listFinishedByFileId(f, ids[1], 10).map((r) => r.id)).toEqual([ids[1], ids[0]]);
    expect(jobRepo.listFinishedByFileId(f, later.id, 2).map((r) => r.id)).toEqual([ids[2], ids[1]]);
  });
});

describe('guarded writes on interrupted rows', () => {
  it('setInterruptedNote only touches interrupted rows', () => {
    const f = seedFile('/m/a.mkv');
    const j = encoding(f);
    expect(jobRepo.setInterruptedNote(j, 'resumed_after_restart')).toBe(false);
    expect(row(j).error_msg).toBeNull();
    jobRepo.recoverStaleEncoding(500, 0);
    expect(jobRepo.setInterruptedNote(j, 'resumed_after_restart')).toBe(true);
    expect(row(j)).toMatchObject({ status: 'interrupted', error_msg: 'resumed_after_restart' });
  });

  it('markInterruptedFailed only turns interrupted rows into failed', () => {
    const f = seedFile('/m/a.mkv');
    const j = encoding(f);
    expect(jobRepo.markInterruptedFailed(j, 'interrupted_repeatedly')).toBeNull();
    expect(row(j).status).toBe('encoding');
    jobRepo.recoverStaleEncoding(500, 0);
    const failed = jobRepo.markInterruptedFailed(j, 'interrupted_repeatedly');
    expect(failed).toMatchObject({
      status: 'failed',
      error_msg: 'interrupted_repeatedly',
      finished_at: 500,
    });
    expect(jobRepo.markInterruptedFailed(j, 'interrupted_repeatedly')).toBeNull();
  });
});

describe('runInTransaction', () => {
  it('commits recovery and enqueue together', () => {
    const f = seedFile('/m/a.mkv');
    const j = encoding(f);
    const out = jobRepo.runInTransaction(() => {
      jobRepo.recoverStaleEncoding(500, 0);
      const fresh = fileRepo.getById(f)!;
      return jobRepo.enqueue(f, 'libx265', fresh.version, null);
    });
    expect(out?.status).toBe('queued');
    expect(row(j).status).toBe('interrupted');
  });

  it('keeps enqueue rollbacks local: a rejected enqueue returns null and the rest commits', () => {
    const f = seedFile('/m/a.mkv');
    const j = encoding(f);
    const out = jobRepo.runInTransaction(() => {
      jobRepo.recoverStaleEncoding(500, 0);
      jobRepo.setInterruptedNote(j, 'resume_skipped:enqueue_rejected');
      return jobRepo.enqueue(f, 'libx265', 9999, null);
    });
    expect(out).toBeNull();
    expect(row(j)).toMatchObject({
      status: 'interrupted',
      error_msg: 'resume_skipped:enqueue_rejected',
    });
    expect(jobRepo.countByStatus('queued')).toBe(0);
  });

  it('rolls everything back when the body throws', () => {
    const f = seedFile('/m/a.mkv');
    const g = seedFile('/m/b.mkv');
    const j = encoding(f);
    const k = encoding(g);
    expect(() =>
      jobRepo.runInTransaction(() => {
        jobRepo.recoverStaleEncoding(500, 0);
        jobRepo.setInterruptedNote(j, 'resumed_after_restart');
        jobRepo.enqueue(f, 'libx265', fileRepo.getById(f)!.version, null);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(row(j)).toMatchObject({ status: 'encoding', error_msg: null });
    expect(row(k).status).toBe('encoding');
    expect(jobRepo.countByStatus('queued')).toBe(0);
    expect(fileRepo.getById(f)?.status).toBe('pending');
  });
});

describe('toScanMtime', () => {
  it('is whole seconds, the unit the scanner stores', () => {
    expect(toScanMtime({ mtimeMs: 1_700_000_000_999.7 })).toBe(1_700_000_000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-mtime-'));
    try {
      const p = path.join(dir, 'a.bin');
      fs.writeFileSync(p, 'x');
      const st = fs.statSync(p);
      expect(toScanMtime(st)).toBe(Math.floor(st.mtimeMs / 1000));
      expect(toScanMtime(st)).not.toBe(st.mtimeMs);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
