/*
 * 24-04 F6 T1: DELETE /api/library/[id] — row-only "forget" delete.
 * Real in-memory better-sqlite3 DB (mirror tests/api/trash.test.ts harness) so
 * FK CASCADE (job, blocklist_entry) + SET NULL (trash_entry) + bench NO-ACTION
 * are exercised against actual SQLite semantics — not mocked away.
 * Covers AC-1, AC-2, AC-3, AC-3b, AC-4, AC-4b, AC-5.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';
import { makeTrashRepo, type TrashRepo } from '@/src/lib/db/repos/trash';
import { makeBenchRunRepo } from '@/src/lib/db/repos/bench-run';
import { makeBenchComboRepo } from '@/src/lib/db/repos/bench-combo';
import type { FileStatus } from '@/src/lib/db/schema';

type Db = InstanceType<typeof Database>;

const {
  dbRef,
  fileRepoRef,
  getByIdOverride,
  activeBenchOverride,
  mockEnsureServerInit,
  mockLoggerInfo,
  mockLoggerError,
} = vi.hoisted(() => ({
  dbRef: { current: null as Db | null },
  fileRepoRef: { current: null as FileRepo | null },
  getByIdOverride: { current: null as ((id: number) => unknown) | null },
  // 47-03 AC-8: lets a single test flip the bench guard between the pre-check
  // and the in-transaction re-check. Defaults to the real repo.
  activeBenchOverride: { current: null as ((id: number) => boolean) | null },
  mockEnsureServerInit: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  getDb: () => dbRef.current,
  fileRepo: () => ({
    // getByIdOverride lets a single test simulate a status flip between the
    // outer guard and the in-txn re-check (AC-3b). Defaults to the real repo.
    getById: (id: number) =>
      getByIdOverride.current ? getByIdOverride.current(id) : fileRepoRef.current!.getById(id),
    deleteById: (id: number) => fileRepoRef.current!.deleteById(id),
    isReferencedByActiveBench: (id: number) =>
      activeBenchOverride.current
        ? activeBenchOverride.current(id)
        : fileRepoRef.current!.isReferencedByActiveBench(id),
    countBenchRefs: (id: number) => fileRepoRef.current!.countBenchRefs(id),
  }),
  jobRepo: () => ({}),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: mockLoggerInfo,
      warn: vi.fn(),
      error: mockLoggerError,
    }),
  },
  default: {},
}));

import { DELETE } from '@/app/api/library/[id]/route';

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function delReq(id: string): Request {
  return new Request(`http://test/api/library/${id}`, { method: 'DELETE' });
}

function seedFile(repo: FileRepo, path: string, status: FileStatus, hash: string): number {
  const row = repo.upsertByPath({
    path,
    size_bytes: 1000,
    mtime: 1_700_000_000,
    content_hash: hash,
    codec: 'hevc',
    bitrate: 1000,
    duration_seconds: 10,
    width: 1920,
    height: 1080,
    container: 'matroska',
    last_scanned_at: 1_700_000_000,
    share_id: null,
  });
  // upsertByPath always inserts as 'pending'; flip to the desired status.
  if (status !== 'pending') repo.setStatus(row.id, status, row.version);
  return row.id;
}

// 47-03: one bench_run (created as 'pending') plus N combos on `fileId`.
// Callers flip bench_run.status to whatever the case needs.
function seedBenchCombo(db: Db, fileId: number, comboCount = 1): { runId: number } {
  const runRepo = makeBenchRunRepo(db);
  const comboRepo = makeBenchComboRepo(db);
  const runId = runRepo.create({
    mode: 'native-sweep',
    fileIds: [fileId],
    matrix: { encoders: ['libx265'], presets: ['medium'], nativeValues: [23] },
  });
  comboRepo.createBatch(
    runId,
    Array.from({ length: comboCount }, (_, i) => ({
      file_id: fileId,
      encoder: 'libx265',
      preset: 'medium',
      native_quality_param: '-crf',
      native_quality_value: 23,
      vmaf_target: null,
      sample_idx: i,
    })),
  );
  return { runId };
}

let db: Db;
let fileRepo: FileRepo;
let trashRepo: TrashRepo;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  db.pragma('foreign_keys = ON');
  fileRepo = makeFileRepo(db);
  trashRepo = makeTrashRepo(db);
  dbRef.current = db;
  fileRepoRef.current = fileRepo;
  getByIdOverride.current = null;
  activeBenchOverride.current = null;
  mockEnsureServerInit.mockReset();
  mockLoggerInfo.mockReset();
  mockLoggerError.mockReset();
  delete process.env.NEXT_PHASE;
});

afterEach(() => {
  db.close();
  dbRef.current = null;
  fileRepoRef.current = null;
  getByIdOverride.current = null;
  activeBenchOverride.current = null;
});

describe('DELETE /api/library/[id] — F6 row-only forget', () => {
  // AC-1 + AC-2: eligible row removed, cascade job + blocklist, trash survives.
  it('test_DELETE_when_vanished_then_row_gone_cascade_job_blocklist_trash_survives_200', async () => {
    const id = seedFile(fileRepo, '/m/vanished.mkv', 'vanished', 'h1'.padEnd(64, '0'));
    db.prepare("INSERT INTO job (file_id, status) VALUES (?, 'done')").run(id);
    db.prepare('INSERT INTO blocklist_entry (file_id) VALUES (?)').run(id);
    trashRepo.create({
      file_id: id,
      original_path: '/m/vanished.mkv',
      trash_path: '/cache/trash/1/vanished.mkv',
      size_bytes: 1000,
      retention_days: 30,
    });

    const res = await DELETE(delReq(String(id)), ctx(String(id)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    expect(body.fileId).toBe(id);
    expect(body.previousStatus).toBe('vanished');
    expect(body.requestId).toBeTypeOf('string');

    // Row gone.
    expect(fileRepo.getById(id)).toBeUndefined();
    // CASCADE: job + blocklist gone.
    expect(db.prepare('SELECT COUNT(*) AS c FROM job WHERE file_id = ?').get(id)).toMatchObject({
      c: 0,
    });
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM blocklist_entry WHERE file_id = ?').get(id),
    ).toMatchObject({ c: 0 });
    // SET NULL: trash survives with file_id NULL.
    const trashRows = db.prepare('SELECT file_id FROM trash_entry').all() as Array<{
      file_id: number | null;
    }>;
    expect(trashRows).toHaveLength(1);
    expect(trashRows[0].file_id).toBeNull();
    // audit-SR2: success audit log emitted.
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'library_entry_deleted', fileId: id }),
      expect.any(String),
    );
  });

  // AC-4b: trash read path tolerates the orphaned NULL-file_id row.
  it('test_DELETE_when_trash_orphaned_then_trashRepo_read_does_not_throw', async () => {
    const id = seedFile(fileRepo, '/m/t.mkv', 'failed', 'h2'.padEnd(64, '0'));
    trashRepo.create({
      file_id: id,
      original_path: '/m/t.mkv',
      trash_path: '/cache/trash/2/t.mkv',
      size_bytes: 1000,
      retention_days: 30,
    });
    await DELETE(delReq(String(id)), ctx(String(id)));
    expect(() => trashRepo.list({ page: 1, size: 50 })).not.toThrow();
    const listed = trashRepo.list({ page: 1, size: 50 });
    expect(listed.total).toBe(1);
    expect(listed.rows[0].file_id).toBeNull();
  });

  // AC-3: active-job statuses rejected, row NOT deleted.
  it('test_DELETE_when_queued_then_409_active_job_AND_row_kept', async () => {
    const id = seedFile(fileRepo, '/m/q.mkv', 'queued', 'h3'.padEnd(64, '0'));
    const res = await DELETE(delReq(String(id)), ctx(String(id)));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('delete_rejected_active_job');
    expect(body.currentStatus).toBe('queued');
    expect(fileRepo.getById(id)).toBeDefined();
  });

  it('test_DELETE_when_encoding_then_409_active_job', async () => {
    const id = seedFile(fileRepo, '/m/e.mkv', 'encoding', 'h4'.padEnd(64, '0'));
    const res = await DELETE(delReq(String(id)), ctx(String(id)));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('delete_rejected_active_job');
  });

  // AC-3b: status flips to 'queued' between outer guard and in-txn re-check →
  // rejected inside the transaction, no partial delete.
  it('test_DELETE_when_status_flips_to_queued_in_txn_then_409_AND_row_kept', async () => {
    const id = seedFile(fileRepo, '/m/race.mkv', 'pending', 'h5'.padEnd(64, '0'));
    let calls = 0;
    getByIdOverride.current = (qid: number) => {
      calls += 1;
      const real = fileRepo.getById(qid);
      // First call (outer guard) → real 'pending'. Second call (in-txn
      // re-check) → simulate a scheduler tick that promoted it to 'queued'.
      if (calls >= 2 && real) return { ...real, status: 'queued' };
      return real;
    };
    const res = await DELETE(delReq(String(id)), ctx(String(id)));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('delete_rejected_active_job');
    // Real row still present — txn rolled back / never deleted.
    expect(fileRepo.getById(id)).toBeDefined();
  });

  // 47-03 AC-6 (was 24-04 AC-4): only an ACTIVE run blocks. runRepo.create()
  // yields status 'pending', which is active.
  it('test_DELETE_when_pending_bench_run_then_409_active_bench_AND_row_kept', async () => {
    const id = seedFile(fileRepo, '/m/b.mkv', 'done-larger', 'h6'.padEnd(64, '0'));
    seedBenchCombo(db, id);
    const res = await DELETE(delReq(String(id)), ctx(String(id)));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('delete_blocked_active_bench');
    expect(fileRepo.getById(id)).toBeDefined();
  });

  it('test_DELETE_when_running_bench_run_then_409_active_bench', async () => {
    const id = seedFile(fileRepo, '/m/b-run.mkv', 'done-larger', 'h6b'.padEnd(64, '0'));
    const { runId } = seedBenchCombo(db, id);
    db.prepare("UPDATE bench_run SET status='running' WHERE id=?").run(runId);
    const res = await DELETE(delReq(String(id)), ctx(String(id)));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('delete_blocked_active_bench');
    expect(fileRepo.getById(id)).toBeDefined();
  });

  // 47-03 AC-5: a TERMINAL run no longer blocks — the combos survive with
  // file_id IS NULL and keep their measurements.
  for (const terminal of ['complete', 'failed', 'cancelled'] as const) {
    it(`test_DELETE_when_${terminal}_bench_run_then_200_AND_combo_file_id_null`, async () => {
      const id = seedFile(
        fileRepo,
        `/m/term-${terminal}.mkv`,
        'done-larger',
        `t${terminal}`.padEnd(64, '0'),
      );
      const { runId } = seedBenchCombo(db, id);
      db.prepare('UPDATE bench_run SET status=? WHERE id=?').run(terminal, runId);
      db.prepare(
        'UPDATE bench_combo SET vmaf=95.5, size_bytes=4242, encode_seconds=7.5 WHERE run_id=?',
      ).run(runId);

      const res = await DELETE(delReq(String(id)), ctx(String(id)));
      expect(res.status).toBe(200);
      expect((await res.json()).deleted).toBe(true);
      expect(fileRepo.getById(id)).toBeUndefined();

      const combos = db.prepare('SELECT * FROM bench_combo WHERE run_id=?').all(runId) as Array<{
        file_id: number | null;
        vmaf: number | null;
        size_bytes: number | null;
        encode_seconds: number | null;
      }>;
      expect(combos).toHaveLength(1);
      expect(combos[0].file_id).toBeNull();
      expect(combos[0].vmaf).toBe(95.5);
      expect(combos[0].size_bytes).toBe(4242);
      expect(combos[0].encode_seconds).toBe(7.5);
    });
  }

  // 47-03 AC-8: a run turning active BETWEEN pre-check and DELETE is caught by
  // the in-transaction re-check. Spy: first call (pre-check) false, second
  // (in-txn re-check) true — the only deterministic way to hit the window in a
  // synchronous better-sqlite3 transaction, and proof the second call happens.
  it('test_DELETE_when_bench_turns_active_between_precheck_and_delete_then_409_AND_row_kept', async () => {
    const id = seedFile(fileRepo, '/m/bench-race.mkv', 'done-larger', 'h9'.padEnd(64, '0'));
    let calls = 0;
    activeBenchOverride.current = () => {
      calls += 1;
      return calls >= 2;
    };
    const res = await DELETE(delReq(String(id)), ctx(String(id)));
    expect(calls).toBe(2);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('delete_blocked_active_bench');
    expect(fileRepo.getById(id)).toBeDefined();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  // 47-03 AC-14: the audit line carries how many bench references were severed.
  it('test_DELETE_when_terminal_bench_refs_then_audit_reports_benchRefsSevered', async () => {
    const id = seedFile(fileRepo, '/m/audit-sev.mkv', 'done-larger', 'ha'.padEnd(64, '0'));
    const { runId } = seedBenchCombo(db, id, 3);
    db.prepare("UPDATE bench_run SET status='failed' WHERE id=?").run(runId);

    const res = await DELETE(delReq(String(id)), ctx(String(id)));
    expect(res.status).toBe(200);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'library_entry_deleted', benchRefsSevered: 3 }),
      expect.any(String),
    );
  });

  it('test_DELETE_when_no_bench_refs_then_audit_reports_benchRefsSevered_zero', async () => {
    const id = seedFile(fileRepo, '/m/audit-zero.mkv', 'failed', 'hb'.padEnd(64, '0'));
    const res = await DELETE(delReq(String(id)), ctx(String(id)));
    expect(res.status).toBe(200);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'library_entry_deleted', benchRefsSevered: 0 }),
      expect.any(String),
    );
  });

  // AC-5: idempotent 404 / invalid 400.
  it('test_DELETE_when_id_not_found_then_404_idempotent', async () => {
    const res = await DELETE(delReq('99999'), ctx('99999'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('file_not_found');
    expect(body.idempotent).toBe(true);
  });

  it('test_DELETE_when_invalid_id_then_400', async () => {
    const res = await DELETE(delReq('abc'), ctx('abc'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_file_id');
  });

  it('test_DELETE_when_zero_id_then_400', async () => {
    const res = await DELETE(delReq('0'), ctx('0'));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_file_id');
  });

  it('test_DELETE_when_called_then_cache_control_no_store', async () => {
    const id = seedFile(fileRepo, '/m/c.mkv', 'failed', 'h7'.padEnd(64, '0'));
    const res = await DELETE(delReq(String(id)), ctx(String(id)));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('test_DELETE_when_NEXT_PHASE_build_then_short_circuits', async () => {
    process.env.NEXT_PHASE = 'phase-production-build';
    const res = await DELETE(delReq('1'), ctx('1'));
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe(true);
  });
});
