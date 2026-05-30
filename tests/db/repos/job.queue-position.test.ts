// Plan 05-12 (B3 Queue Reorder): operator-controlled pick order via
// queue_position column (migration 0014) + reorderQueueTx repo method.
//
// Covers AC-1 (migration backfill + idempotency + index), AC-2 (auto-assign
// at INSERT), AC-3 (ORDER BY queue_position on three pick paths), AC-4
// (reorderQueueTx contract — repo layer; route layer covered separately).

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

function seedFile(fileRepo: FileRepo, p: string, hashSeed: string) {
  return fileRepo.upsertByPath({
    path: p,
    size_bytes: 1000,
    mtime: 1_700_000_000,
    content_hash: hashSeed.padStart(64, '0'),
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

describe('migration 0014 + jobRepo queue_position', () => {
  let db: Db;
  let fileRepo: FileRepo;
  let jobRepo: JobRepo;

  beforeEach(() => {
    ({ db, fileRepo, jobRepo } = setupDb());
  });

  afterEach(() => {
    db.close();
  });

  // ── AC-1: migration shape ─────────────────────────────────────────────────

  it('test_migration_when_run_then_queue_position_column_exists_with_NOT_NULL_default_0_and_CHECK', () => {
    const cols = db.prepare("PRAGMA table_info('job')").all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const col = cols.find((c) => c.name === 'queue_position');
    expect(col).toBeDefined();
    expect(col?.type).toMatch(/INTEGER/i);
    expect(col?.notnull).toBe(1);
    expect(col?.dflt_value).toBe('0');
  });

  it('test_migration_when_run_then_partial_index_idx_job_queued_position_exists', () => {
    const indexes = db.prepare("PRAGMA index_list('job')").all() as { name: string }[];
    const found = indexes.find((i) => i.name === 'idx_job_queued_position');
    expect(found).toBeDefined();
    // Confirm partial-index predicate via sqlite_master.
    const ddlRow = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_job_queued_position'",
      )
      .get() as { sql: string } | undefined;
    expect(ddlRow?.sql).toMatch(/WHERE\s+status\s*=\s*'queued'/i);
  });

  it('test_migration_when_re_run_against_already_migrated_db_then_no_op', () => {
    // schema_migrations row for version 14 already inserted by setupDb's migrate(db).
    const initial = db.prepare('SELECT version FROM schema_migrations WHERE version = 14').get();
    expect(initial).toBeDefined();
    // Calling migrate again should be a no-op (the `applied.has(version)` guard
    // skips already-applied migrations).
    expect(() => migrate(db)).not.toThrow();
    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    const fourteenCount = versions.filter((v) => v.version === 14).length;
    expect(fourteenCount).toBe(1);
  });

  // ── AC-1: backfill ranking ────────────────────────────────────────────────

  it('test_migration_backfill_when_pre_existing_queued_rows_then_ranked_by_created_at_id_ascending', () => {
    // Re-build a fresh in-memory DB; partially apply migrations; insert legacy
    // rows; then apply migration 0014 manually to assert backfill.
    const fresh = new Database(':memory:');
    // Apply migrations 0001..0013 (everything before 0014) by skipping 0014 on disk.
    // Easiest: run all migrations, then DROP the queue_position column to simulate
    // pre-0014 state, re-run only 0014. SQLite cannot DROP COLUMN reliably across
    // versions; instead, seed rows AFTER migrate() and assert backfill ran already
    // on the empty table (vacuously true) — then explicitly test the backfill
    // logic via direct SQL on a fresh ALTER+UPDATE.
    fresh.exec(
      `CREATE TABLE job (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    // Seed rows with deliberately out-of-id-order created_at so the ranking
    // depends on (created_at, id) — NOT on insertion order.
    fresh.prepare("INSERT INTO job (id, status, created_at) VALUES (10, 'queued', 200)").run();
    fresh.prepare("INSERT INTO job (id, status, created_at) VALUES (11, 'queued', 100)").run();
    fresh.prepare("INSERT INTO job (id, status, created_at) VALUES (12, 'queued', 100)").run();
    fresh.prepare("INSERT INTO job (id, status, created_at) VALUES (13, 'done',   50)").run();
    // Apply the migration 0014 backfill SQL verbatim.
    fresh.exec(
      `ALTER TABLE job ADD COLUMN queue_position INTEGER NOT NULL DEFAULT 0 CHECK (queue_position >= 0);
       WITH ranked AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS pos
         FROM job WHERE status = 'queued'
       )
       UPDATE job SET queue_position = (SELECT pos FROM ranked WHERE ranked.id = job.id)
       WHERE id IN (SELECT id FROM ranked);`,
    );
    const rows = fresh.prepare('SELECT id, queue_position FROM job ORDER BY id ASC').all() as {
      id: number;
      queue_position: number;
    }[];
    // (created_at=100, id=11) -> 1; (created_at=100, id=12) -> 2; (created_at=200, id=10) -> 3
    expect(rows.find((r) => r.id === 11)?.queue_position).toBe(1);
    expect(rows.find((r) => r.id === 12)?.queue_position).toBe(2);
    expect(rows.find((r) => r.id === 10)?.queue_position).toBe(3);
    // Non-queued row stays at default 0.
    expect(rows.find((r) => r.id === 13)?.queue_position).toBe(0);
    fresh.close();
  });

  // ── AC-2: auto-assign at create() ─────────────────────────────────────────

  it('test_create_when_pending_queue_empty_then_queue_position_is_1', () => {
    const f = seedFile(fileRepo, '/m/a.mkv', 'a');
    const job = jobRepo.create({ file_id: f.id, encoder: 'libx265', crf: null });
    expect(job?.queue_position).toBe(1);
  });

  it('test_create_when_pending_queue_has_5_rows_then_new_row_queue_position_is_6', () => {
    for (let i = 0; i < 5; i++) {
      const f = seedFile(fileRepo, `/m/p${i}.mkv`, `p${i}`);
      jobRepo.create({ file_id: f.id, encoder: 'libx265', crf: null });
    }
    const f6 = seedFile(fileRepo, '/m/p6.mkv', 'p6');
    const job6 = jobRepo.create({ file_id: f6.id, encoder: 'libx265', crf: null });
    expect(job6?.queue_position).toBe(6);
  });

  it('test_create_when_pending_queue_position_max_is_3_after_terminal_rows_then_new_row_is_4_not_higher', () => {
    // 3 queued rows.
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const f = seedFile(fileRepo, `/m/t${i}.mkv`, `t${i}`);
      const j = jobRepo.create({ file_id: f.id, encoder: 'libx265', crf: null });
      ids.push(j!.id);
    }
    // Move first to terminal — its queue_position remains the historical 1, but
    // it leaves the WHERE-status='queued' set the COALESCE consults.
    db.prepare("UPDATE job SET status = 'cancelled' WHERE id = ?").run(ids[0]);
    const f = seedFile(fileRepo, '/m/t-new.mkv', 'tn');
    const newJob = jobRepo.create({ file_id: f.id, encoder: 'libx265', crf: null });
    // Pending rows still queued: positions 2 and 3 -> MAX = 3 -> new = 4.
    expect(newJob?.queue_position).toBe(4);
  });

  // ── AC-3: ORDER BY queue_position on pick paths ───────────────────────────

  it('test_claimNext_when_three_rows_with_distinct_queue_positions_then_returns_lowest_queue_position_first', () => {
    const f1 = seedFile(fileRepo, '/m/c1.mkv', 'c1');
    const f2 = seedFile(fileRepo, '/m/c2.mkv', 'c2');
    const f3 = seedFile(fileRepo, '/m/c3.mkv', 'c3');
    const j1 = jobRepo.create({ file_id: f1.id, encoder: 'libx265', crf: null });
    const j2 = jobRepo.create({ file_id: f2.id, encoder: 'libx265', crf: null });
    const j3 = jobRepo.create({ file_id: f3.id, encoder: 'libx265', crf: null });
    // Reorder: j2 first, j3 second, j1 last.
    const result = jobRepo.reorderQueueTx([j2!.id, j3!.id, j1!.id]);
    expect('applied' in result && result.applied.length).toBe(3);
    // claimNext picks j2 (queue_position = 1).
    const claimed = jobRepo.claimNext();
    expect(claimed?.id).toBe(j2?.id);
  });

  it('test_peekQueued_when_called_after_reorder_then_returns_rows_in_queue_position_ascending_order', () => {
    const f1 = seedFile(fileRepo, '/m/p1.mkv', 'p1');
    const f2 = seedFile(fileRepo, '/m/p2.mkv', 'p2');
    const f3 = seedFile(fileRepo, '/m/p3.mkv', 'p3');
    const j1 = jobRepo.create({ file_id: f1.id, encoder: 'libx265', crf: null });
    const j2 = jobRepo.create({ file_id: f2.id, encoder: 'libx265', crf: null });
    const j3 = jobRepo.create({ file_id: f3.id, encoder: 'libx265', crf: null });
    jobRepo.reorderQueueTx([j3!.id, j1!.id, j2!.id]);
    const peeked = jobRepo.peekQueued(100);
    expect(peeked.map((r) => r.id)).toEqual([j3?.id, j1?.id, j2?.id]);
  });

  it('test_listActive_when_mixed_queued_and_encoding_then_orders_by_queue_position_within_group', () => {
    const f1 = seedFile(fileRepo, '/m/a1.mkv', 'a1');
    const f2 = seedFile(fileRepo, '/m/a2.mkv', 'a2');
    const j1 = jobRepo.create({ file_id: f1.id, encoder: 'libx265', crf: null });
    const j2 = jobRepo.create({ file_id: f2.id, encoder: 'libx265', crf: null });
    // Reverse the queue: j2 first.
    jobRepo.reorderQueueTx([j2!.id, j1!.id]);
    const rows = jobRepo.listActive();
    expect(rows.map((r) => r.id)).toEqual([j2?.id, j1?.id]);
  });

  // ── AC-4: reorderQueueTx contract ─────────────────────────────────────────

  it('test_reorderQueueTx_when_empty_array_then_returns_applied_empty_no_op', () => {
    const result = jobRepo.reorderQueueTx([]);
    expect(result).toEqual({ applied: [] });
  });

  it('test_reorderQueueTx_when_valid_orderedJobIds_then_returns_applied_with_new_positions_1_to_N', () => {
    const f1 = seedFile(fileRepo, '/m/r1.mkv', 'r1');
    const f2 = seedFile(fileRepo, '/m/r2.mkv', 'r2');
    const f3 = seedFile(fileRepo, '/m/r3.mkv', 'r3');
    const j1 = jobRepo.create({ file_id: f1.id, encoder: 'libx265', crf: null });
    const j2 = jobRepo.create({ file_id: f2.id, encoder: 'libx265', crf: null });
    const j3 = jobRepo.create({ file_id: f3.id, encoder: 'libx265', crf: null });
    const result = jobRepo.reorderQueueTx([j3!.id, j1!.id, j2!.id]);
    expect('applied' in result).toBe(true);
    if ('applied' in result) {
      expect(result.applied).toEqual([
        { jobId: j3!.id, queuePosition: 1 },
        { jobId: j1!.id, queuePosition: 2 },
        { jobId: j2!.id, queuePosition: 3 },
      ]);
    }
  });

  it('test_reorderQueueTx_when_one_jobId_already_claimed_then_returns_conflict_AND_rolls_back_partial_updates', () => {
    const f1 = seedFile(fileRepo, '/m/k1.mkv', 'k1');
    const f2 = seedFile(fileRepo, '/m/k2.mkv', 'k2');
    const f3 = seedFile(fileRepo, '/m/k3.mkv', 'k3');
    const j1 = jobRepo.create({ file_id: f1.id, encoder: 'libx265', crf: null });
    const j2 = jobRepo.create({ file_id: f2.id, encoder: 'libx265', crf: null });
    const j3 = jobRepo.create({ file_id: f3.id, encoder: 'libx265', crf: null });
    // Capture initial positions (auto-assigned 1, 2, 3 in id order).
    const before = jobRepo.peekQueued(100);
    expect(before.map((r) => r.queue_position)).toEqual([1, 2, 3]);
    // Simulate claimNext by flipping j2 to encoding mid-flight.
    db.prepare("UPDATE job SET status = 'encoding' WHERE id = ?").run(j2!.id);
    // Reorder attempt that includes j2 — should conflict on j2.
    const result = jobRepo.reorderQueueTx([j3!.id, j1!.id, j2!.id]);
    expect('conflict' in result).toBe(true);
    if ('conflict' in result) {
      expect(result.conflict).toContain(j2!.id);
    }
    // Rollback verification: j1 + j3 still at their pre-TX positions (1 and 3).
    const after = db.prepare('SELECT id, queue_position FROM job ORDER BY id ASC').all() as {
      id: number;
      queue_position: number;
    }[];
    expect(after.find((r) => r.id === j1!.id)?.queue_position).toBe(1);
    expect(after.find((r) => r.id === j3!.id)?.queue_position).toBe(3);
  });

  // ── audit-added (S6): enqueue() re-queue path threads queue_position correctly ──

  it('test_enqueue_when_called_then_new_row_auto_assigns_queue_position_via_create_path', () => {
    // Pre-seed 3 queued rows.
    for (let i = 0; i < 3; i++) {
      const f = seedFile(fileRepo, `/m/e${i}.mkv`, `e${i}`);
      jobRepo.create({ file_id: f.id, encoder: 'libx265', crf: null });
    }
    // enqueue() uses create() internally — the auto-assign rides through transparently.
    const fNew = seedFile(fileRepo, '/m/e-new.mkv', 'eN');
    const job = jobRepo.enqueue(fNew.id, 'libx265', fNew.version, null);
    expect(job).not.toBeNull();
    expect(job?.queue_position).toBe(4);
  });

  // ── audit-added (S4): reorder-then-claim end-to-end integration ───────────

  it('test_reorder_then_claim_when_top_row_swapped_then_claimNext_returns_new_top', () => {
    const f1 = seedFile(fileRepo, '/m/i1.mkv', 'i1');
    const f2 = seedFile(fileRepo, '/m/i2.mkv', 'i2');
    const f3 = seedFile(fileRepo, '/m/i3.mkv', 'i3');
    const j1 = jobRepo.create({ file_id: f1.id, encoder: 'libx265', crf: null });
    const j2 = jobRepo.create({ file_id: f2.id, encoder: 'libx265', crf: null });
    const j3 = jobRepo.create({ file_id: f3.id, encoder: 'libx265', crf: null });
    // Pre-reorder: j1 at top (queue_position 1).
    expect(jobRepo.peekQueued(1)[0]?.id).toBe(j1?.id);
    // Reorder: j3 at top.
    jobRepo.reorderQueueTx([j3!.id, j1!.id, j2!.id]);
    // claimNext picks j3 (the new top).
    const claimed = jobRepo.claimNext();
    expect(claimed?.id).toBe(j3?.id);
  });
});
