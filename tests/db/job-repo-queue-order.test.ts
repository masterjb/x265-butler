// @vitest-environment node
// Processing order of the queue: every pick path (peek, claim, listActive)
// follows the same order per mode, pinned jobs come first, moving a job pins
// everything up to its drop point, and clearing the manual order unpins.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';
import { makeJobRepo, type JobRepo } from '@/src/lib/db/repos/job';
import { QUEUE_ORDERS, resolveQueueOrder, type QueueOrder } from '@/src/lib/queue/queue-order';

type Db = InstanceType<typeof Database>;
let db: Db;
let fileRepo: FileRepo;
let jobRepo: JobRepo;
let seq = 0;

function seedFile(size: number): number {
  seq += 1;
  const id = fileRepo.upsertByPath({
    path: `/media/f${seq}.mkv`,
    size_bytes: size,
    mtime: 1_700_000_000,
    content_hash: 'a'.repeat(64),
    codec: 'h264',
    bitrate: 1,
    duration_seconds: 60,
    width: 1920,
    height: 1080,
    container: 'mkv',
    last_scanned_at: 1_700_000_000,
    share_id: null,
  }).id;
  return id;
}

// Queued job with an explicit creation time.
function queued(size: number, createdAt: number): number {
  const job = jobRepo.create({ file_id: seedFile(size), encoder: 'libx265', crf: null })!;
  db.prepare('UPDATE job SET created_at = ? WHERE id = ?').run(createdAt, job.id);
  return job.id;
}

const ids = (rows: { id: number }[]) => rows.map((r) => r.id);
const queuedIdsOf = (order: QueueOrder) =>
  ids(jobRepo.listActive(order).filter((r) => r.status === 'queued'));

function pinState(id: number): { queue_pinned: number; queue_position: number } {
  return db.prepare('SELECT queue_pinned, queue_position FROM job WHERE id = ?').get(id) as {
    queue_pinned: number;
    queue_position: number;
  };
}

beforeEach(() => {
  seq = 0;
  db = new Database(':memory:');
  migrate(db);
  db.pragma('foreign_keys = ON');
  fileRepo = makeFileRepo(db);
  jobRepo = makeJobRepo(db, {
    setFileStatus: (id, status, v) => fileRepo.setStatus(id, status, v),
    bulkSetFileStatusToPending: (fileIds, s) => fileRepo.bulkSetStatusToPendingByIds(fileIds, s),
  });
});

describe('queue order per mode', () => {
  // Insertion order a, b, c, d; ages and sizes deliberately not in that order.
  function seedFour() {
    const a = queued(500, 100);
    const b = queued(900, 400);
    const c = queued(100, 200);
    const d = queued(300, 300);
    return { a, b, c, d };
  }

  it('orders peek, claim and listActive alike per mode', () => {
    const { a, b, c, d } = seedFour();
    const expected: Record<QueueOrder, number[]> = {
      oldest: [a, b, c, d],
      newest: [b, d, c, a],
      largest: [b, a, d, c],
      smallest: [c, d, a, b],
    };
    for (const order of QUEUE_ORDERS) {
      expect(ids(jobRepo.peekQueued(100, order)), order).toEqual(expected[order]);
      expect(queuedIdsOf(order), order).toEqual(expected[order]);
    }
    for (const order of QUEUE_ORDERS) {
      const claimed = jobRepo.claimNext(order)!;
      expect(claimed.id, order).toBe(expected[order][0]);
      db.prepare("UPDATE job SET status = 'queued', started_at = NULL WHERE id = ?").run(
        claimed.id,
      );
    }
  });

  it('breaks ties by id', () => {
    const x = queued(500, 100);
    const y = queued(500, 100);
    expect(ids(jobRepo.peekQueued(100, 'largest'))).toEqual([x, y]);
    expect(ids(jobRepo.peekQueued(100, 'smallest'))).toEqual([x, y]);
    expect(ids(jobRepo.peekQueued(100, 'newest'))).toEqual([y, x]);
  });

  it('default equals the previous order including earlier manual sorting', () => {
    const a = queued(500, 100);
    const b = queued(900, 200);
    const c = queued(100, 300);
    // Earlier manual sorting wrote positions out of insertion order.
    db.prepare('UPDATE job SET queue_position = 3 WHERE id = ?').run(a);
    db.prepare('UPDATE job SET queue_position = 1 WHERE id = ?').run(c);
    db.prepare('UPDATE job SET queue_position = 2 WHERE id = ?').run(b);
    const reference = ids(
      db
        .prepare(
          "SELECT id FROM job WHERE status = 'queued' ORDER BY queue_position ASC, created_at ASC, id ASC",
        )
        .all() as { id: number }[],
    );
    expect(reference).toEqual([c, b, a]);
    expect(ids(jobRepo.peekQueued(100))).toEqual(reference);
    expect(queuedIdsOf('oldest')).toEqual(reference);
    expect(jobRepo.claimNext()!.id).toBe(c);
  });

  it('unknown stored value falls back to oldest', () => {
    expect(resolveQueueOrder('random')).toBe('oldest');
    expect(resolveQueueOrder(undefined)).toBe('oldest');
    expect(resolveQueueOrder(null)).toBe('oldest');
    expect(resolveQueueOrder('largest')).toBe('largest');
  });
});

describe('pinned jobs', () => {
  it('pinned jobs come first in every mode', () => {
    const small = queued(10, 100);
    const big1 = queued(900, 200);
    const big2 = queued(800, 300);
    db.prepare('UPDATE job SET queue_pinned = 1, queue_position = 0 WHERE id = ?').run(small);
    for (const order of QUEUE_ORDERS) {
      expect(ids(jobRepo.peekQueued(100, order))[0], order).toBe(small);
    }
    expect(ids(jobRepo.peekQueued(100, 'largest'))).toEqual([small, big1, big2]);
  });

  it('several pinned jobs follow their queue position', () => {
    const a = queued(10, 100);
    const b = queued(20, 200);
    const c = queued(900, 300);
    db.prepare('UPDATE job SET queue_pinned = 1, queue_position = 5 WHERE id = ?').run(a);
    db.prepare('UPDATE job SET queue_pinned = 1, queue_position = 2 WHERE id = ?').run(b);
    expect(ids(jobRepo.peekQueued(100, 'largest'))).toEqual([b, a, c]);
  });

  it('moveToFront pins the job', () => {
    queued(10, 100);
    queued(20, 200);
    const big = queued(900, 300);
    expect(jobRepo.moveToFront(big)).toBe(true);
    expect(pinState(big).queue_pinned).toBe(1);
    expect(ids(jobRepo.peekQueued(100, 'smallest'))[0]).toBe(big);
  });

  it('two jobs moved to the front in reverse keep their old order in every mode', () => {
    queued(10, 100);
    const first = queued(900, 200);
    const second = queued(800, 300);
    // The restart path walks the old order backwards.
    jobRepo.moveToFront(second);
    jobRepo.moveToFront(first);
    for (const order of QUEUE_ORDERS) {
      expect(ids(jobRepo.peekQueued(100, order)).slice(0, 2), order).toEqual([first, second]);
    }
  });
});

describe('moveBefore', () => {
  function seedMany(n: number): number[] {
    const out: number[] = [];
    const insert = db.transaction(() => {
      for (let i = 0; i < n; i++) out.push(queued(1000 + i, 1000 + i));
    });
    insert();
    return out;
  }

  it('drop lands where dropped, jobs beyond the first 1000 do not move up', () => {
    const all = seedMany(1500);
    const x = all[1200];
    const y = all[10];
    const result = jobRepo.moveBefore(x, y, 'oldest');
    expect(result).toMatchObject({ ok: true, fromIndex: 1200, toIndex: 10, queueLength: 1500 });
    const after = ids(jobRepo.peekQueued(1000, 'oldest'));
    const expected = [...all.slice(0, 10), x, ...all.slice(10, 1000 - 1)];
    expect(after).toEqual(expected);
    // Full list keeps the relative order of everything behind x.
    const full = queuedIdsOf('oldest');
    expect(full).toEqual([...all.slice(0, 10), x, ...all.slice(10).filter((id) => id !== x)]);
    for (let i = 0; i <= 10; i++) expect(pinState(full[i]).queue_pinned, `index ${i}`).toBe(1);
    expect(pinState(full[11]).queue_pinned).toBe(0);
    expect(result).toMatchObject({ pinnedCount: 11 });
  });

  it('drop lands exactly where dropped in a size order', () => {
    const small = queued(10, 100);
    const mid = queued(500, 200);
    const big = queued(900, 300);
    // largest: big, mid, small. Put small before mid.
    const result = jobRepo.moveBefore(small, mid, 'largest');
    expect(result).toMatchObject({ ok: true, toIndex: 1, pinnedCount: 2 });
    expect(ids(jobRepo.peekQueued(100, 'largest'))).toEqual([big, small, mid]);
  });

  it('null moves to the end', () => {
    const [a, b, c] = seedMany(3);
    const result = jobRepo.moveBefore(a, null, 'oldest');
    expect(result).toMatchObject({ ok: true, toIndex: 2, pinnedCount: 3 });
    expect(ids(jobRepo.peekQueued(100, 'oldest'))).toEqual([b, c, a]);
  });

  it('a pinned job dragged behind unpinned jobs lands at the drop point and pins the jobs before it', () => {
    const [a, b, c, d] = seedMany(4);
    jobRepo.moveToFront(d); // d pinned: d, a, b, c
    const result = jobRepo.moveBefore(d, c, 'oldest');
    expect(result).toMatchObject({ ok: true, toIndex: 2, pinnedCount: 3 });
    expect(ids(jobRepo.peekQueued(100, 'oldest'))).toEqual([a, b, d, c]);
    expect([a, b, d].map((id) => pinState(id).queue_pinned)).toEqual([1, 1, 1]);
    expect(pinState(c).queue_pinned).toBe(0);
  });

  it('keeps every earlier pin inside the rewritten prefix', () => {
    const [a, b, c, d] = seedMany(4);
    jobRepo.moveBefore(d, null, 'oldest'); // all pinned: a, b, c, d
    const result = jobRepo.moveBefore(c, a, 'oldest');
    expect(result).toMatchObject({ ok: true, toIndex: 0, pinnedCount: 4 });
    expect(ids(jobRepo.peekQueued(100, 'oldest'))).toEqual([c, a, b, d]);
    expect([c, a, b, d].map((id) => pinState(id).queue_position)).toEqual([0, 1, 2, 3]);
  });

  it('reports unknown ids and status conflicts without writing', () => {
    const [a, b] = seedMany(2);
    expect(jobRepo.moveBefore(a, 999_999, 'oldest')).toEqual({ unknown: [999_999] });
    expect(jobRepo.moveBefore(999_998, a, 'oldest')).toEqual({ unknown: [999_998] });
    db.prepare("UPDATE job SET status = 'encoding' WHERE id = ?").run(b);
    expect(jobRepo.moveBefore(a, b, 'oldest')).toEqual({ conflict: [b] });
    expect(pinState(a).queue_pinned).toBe(0);
  });
});

describe('clearManualOrder', () => {
  it('unpins queued jobs only', () => {
    const a = queued(10, 100);
    const b = queued(20, 200);
    const c = queued(30, 300);
    const running = queued(40, 400);
    db.prepare('UPDATE job SET queue_pinned = 1').run();
    db.prepare("UPDATE job SET status = 'encoding' WHERE id = ?").run(running);
    expect(jobRepo.countPinnedQueued()).toBe(3);
    expect(jobRepo.clearManualOrder()).toBe(3);
    expect([a, b, c].map((id) => pinState(id).queue_pinned)).toEqual([0, 0, 0]);
    expect(pinState(running).queue_pinned).toBe(1);
    expect(jobRepo.clearManualOrder()).toBe(0);
  });
});
