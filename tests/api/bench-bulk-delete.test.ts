// 47-01 T3 tests — POST /api/bench/bulk-delete (bulk bench-run purge).
// Envelope coverage mirrors tests/api/library-bulk-delete.test.ts; the SEMANTICS are the
// bench ones (AC-7) plus the AC-8 recommendation empty-state regression.
//
// Harness note: unlike the library sibling this file runs the route against a REAL
// in-memory better-sqlite3 DB and the REAL BenchOrchestrator singleton (built from the
// mocked '@/src/lib/db' accessors, reset per test). A repo mock cannot prove the things
// that actually matter here: the per-id SAVEPOINT rollback, the bench_combo CASCADE, and
// that purging the last complete run degrades the recommendation route to its EXISTING
// 404 envelope instead of throwing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

type Db = InstanceType<typeof Database>;

const authMode = { value: 'disabled' as 'disabled' | 'authenticated' | 'denied' };

const h = vi.hoisted(() => ({
  state: {
    db: null as unknown,
    runRepo: null as unknown,
    comboRepo: null as unknown,
    fileRepo: null as unknown,
  },
  mockEnsureServerInit: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLoggerDebug: vi.fn(),
}));

// Keep the orchestrator's heavy leaf-imports inert; purge touches none of them.
vi.mock('@/src/lib/bench/vmaf', () => ({ encodeForBench: vi.fn(), computeVmaf: vi.fn() }));
vi.mock('@/src/lib/bench/sample-extractor', () => ({
  extractSamples: vi.fn(),
  SampleExtractorError: class SampleExtractorError extends Error {},
}));
vi.mock('@/src/lib/encode/ffmpeg', () => ({ runEncode: vi.fn(), buildArgs: vi.fn(() => []) }));

// The route's getDb() and the orchestrator singleton's repos MUST be the same
// connection — that is the AC-10 invariant the SAVEPOINT rollback rests on.
vi.mock('@/src/lib/db', () => ({
  getDb: () => h.state.db,
  benchRunRepo: () => h.state.runRepo,
  benchComboRepo: () => h.state.comboRepo,
  fileRepo: () => h.state.fileRepo,
  // Only the GET branch of app/api/library/[id]/route.ts reads jobs; the DELETE
  // branch exercised by the S6 end-to-end test below never touches it.
  jobRepo: () => ({ findLatestByFileId: () => null }),
  OccConflictError: class OccConflictError extends Error {},
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: h.mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: h.mockLoggerInfo,
      warn: h.mockLoggerWarn,
      error: h.mockLoggerError,
      debug: h.mockLoggerDebug,
    }),
    info: h.mockLoggerInfo,
    warn: h.mockLoggerWarn,
    error: h.mockLoggerError,
    debug: h.mockLoggerDebug,
  },
  default: {},
}));

vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => {
    if (authMode.value === 'denied') {
      return { ok: false, status: 401, body: { error_code: 'auth_required' } };
    }
    if (authMode.value === 'authenticated') {
      return { ok: true, mode: 'authenticated', username: 'admin' };
    }
    return { ok: true, mode: 'disabled', username: null };
  }),
  authGuard: (decision: { ok: boolean; status?: number; body?: unknown }) => {
    if (decision.ok) return null;
    return new Response(JSON.stringify(decision.body), {
      status: decision.status,
      headers: { 'Content-Type': 'application/json' },
    });
  },
  withRenewCookie: (res: Response) => res,
  default: {},
}));

import { migrate } from '@/src/lib/db/migrate';
import { makeBenchRunRepo, type BenchRunRepo } from '@/src/lib/db/repos/bench-run';
import { makeBenchComboRepo, type BenchComboRepo } from '@/src/lib/db/repos/bench-combo';
import { makeFileRepo, type FileRepo } from '@/src/lib/db/repos/file';
import {
  benchOrchestrator,
  __forTests_resetBenchOrchestrator,
  type BenchOrchestrator,
} from '@/src/lib/bench/orchestrator';
import { POST, runtime } from '@/app/api/bench/bulk-delete/route';
import { GET as GET_RECOMMENDATION } from '@/app/api/bench/recommendation/route';
// Read-only consumer (47-01 boundary: this route is NOT modified) — it is the
// surface the reported operator bug actually manifests on.
import { DELETE as DELETE_LIBRARY_ENTRY } from '@/app/api/library/[id]/route';

const ROUTE_URL = 'http://test/api/bench/bulk-delete';
const MATRIX = { encoders: ['libx265'], presets: ['medium'], nativeValues: [23] };

let db: Db;
let runRepo: BenchRunRepo;
let comboRepo: BenchComboRepo;
let files: FileRepo;

function makeRequest(body?: unknown, headers?: Record<string, string>): Request {
  return new Request(ROUTE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function seedFile(path: string, hash: string): number {
  const r = db
    .prepare(
      'INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at) VALUES (?, 1000, 1, ?, 1)',
    )
    .run(path, hash);
  return r.lastInsertRowid as number;
}

function makeRun(
  fileIds: number[],
  status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled' = 'complete',
): number {
  const id = runRepo.create({ mode: 'native-sweep', fileIds, matrix: MATRIX });
  if (status === 'pending') return id;
  runRepo.markRunning(id, 1);
  if (status === 'running') return id;
  if (status === 'complete') runRepo.markComplete(id, 2);
  if (status === 'failed') runRepo.markFailed(id, 'boom', 2);
  if (status === 'cancelled') runRepo.markCancelled(id, 2);
  return id;
}

function seedCombos(runId: number, fileId: number, n: number, complete = false): void {
  const insert = db.prepare(
    `INSERT INTO bench_combo
       (run_id, file_id, encoder, preset, native_quality_param, native_quality_value,
        vmaf_target, sample_idx, vmaf, size_bytes, encode_seconds, status, is_pareto,
        top3_role, created_at)
     VALUES (?, ?, 'libx265', 'medium', '-crf', 23, NULL, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  for (let i = 0; i < n; i++) {
    insert.run(
      runId,
      fileId,
      i,
      complete ? 95.5 : null,
      complete ? 500_000 : null,
      complete ? 12.5 : null,
      complete ? 'complete' : 'pending',
      complete ? 1 : 0,
      complete ? 'quality' : null,
    );
  }
}

function comboCount(runId: number): number {
  return (
    db.prepare('SELECT COUNT(*) AS c FROM bench_combo WHERE run_id=?').get(runId) as {
      c: number;
    }
  ).c;
}

function priv(orch: BenchOrchestrator): {
  isPass2Running: boolean;
  pass2InFlight: { runId: number; comboId: number } | null;
} {
  return orch as unknown as {
    isPass2Running: boolean;
    pass2InFlight: { runId: number; comboId: number } | null;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMode.value = 'disabled';
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const fkOn = db.pragma('foreign_keys', { simple: true });
  if (fkOn !== 1) throw new Error(`expected foreign_keys=1, got ${String(fkOn)}`);
  migrate(db);
  runRepo = makeBenchRunRepo(db);
  comboRepo = makeBenchComboRepo(db);
  files = makeFileRepo(db);
  h.state.db = db;
  h.state.runRepo = runRepo;
  h.state.comboRepo = comboRepo;
  h.state.fileRepo = files;
  // Rebuild the singleton so it captures THIS test's repos/connection.
  __forTests_resetBenchOrchestrator();
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe('POST /api/bench/bulk-delete — route exports', () => {
  it('runtime is nodejs', () => {
    expect(runtime).toBe('nodejs');
  });
});

describe('POST /api/bench/bulk-delete — AC-7 partial success', () => {
  it('mixed batch [complete, running, unknown] → 200 successCount 1 + reasons active_run/not_found', async () => {
    const fileId = seedFile('/media/a.mkv', 'a'.repeat(64));
    const completeRun = makeRun([fileId], 'complete');
    const runningRun = makeRun([fileId], 'running');
    seedCombos(completeRun, fileId, 3);
    seedCombos(runningRun, fileId, 2);
    const unknownId = 999_999;

    const res = await POST(makeRequest({ ids: [completeRun, runningRun, unknownId] }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      successCount: number;
      failed: Array<{ id: number; reason: string }>;
      requestId: string;
    };
    expect(body.successCount).toBe(1);
    expect(body.failed).toEqual([
      { id: runningRun, reason: 'active_run' },
      // The exact string the audit-M2 mapping bug would have swallowed
      // (purgeRun throws code 'run_not_found', the envelope says 'not_found').
      { id: unknownId, reason: 'not_found' },
    ]);
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);

    // Only the complete run (and its combos) is gone; the running run is fully intact.
    expect(runRepo.findById(completeRun)).toBeNull();
    expect(comboCount(completeRun)).toBe(0);
    expect(runRepo.findById(runningRun)).not.toBeNull();
    expect(comboCount(runningRun)).toBe(2);
    // AC-1: `file` rows are never collateral.
    expect(files.getById(fileId)).not.toBeUndefined();
  });

  it('active_pass2 — a complete run mid pass-2 verify is rejected, not purged', async () => {
    const fileId = seedFile('/media/p2.mkv', 'p'.repeat(64));
    const busyRun = makeRun([fileId], 'complete');
    const freeRun = makeRun([fileId], 'complete');
    seedCombos(busyRun, fileId, 2);
    priv(benchOrchestrator()).isPass2Running = true;
    priv(benchOrchestrator()).pass2InFlight = { runId: busyRun, comboId: 1 };

    const res = await POST(makeRequest({ ids: [busyRun, freeRun] }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      successCount: number;
      failed: Array<{ id: number; reason: string }>;
    };
    expect(body.successCount).toBe(1);
    expect(body.failed).toEqual([{ id: busyRun, reason: 'active_pass2' }]);
    expect(runRepo.findById(busyRun)).not.toBeNull();
    expect(comboCount(busyRun)).toBe(2);
    expect(runRepo.findById(freeRun)).toBeNull();
  });

  it('SAVEPOINT isolation — an unmapped per-id throw becomes internal_error and does not roll back siblings', async () => {
    const fileId = seedFile('/media/iso.mkv', 'i'.repeat(64));
    const a = makeRun([fileId], 'complete');
    const boom = makeRun([fileId], 'complete');
    const c = makeRun([fileId], 'complete');
    seedCombos(a, fileId, 1);
    const orch = benchOrchestrator();
    const real = orch.purgeRun.bind(orch);
    vi.spyOn(orch, 'purgeRun').mockImplementation((id: number) => {
      if (id === boom) throw new Error('unexpected sqlite failure');
      return real(id);
    });

    const res = await POST(makeRequest({ ids: [a, boom, c] }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      successCount: number;
      failed: Array<{ id: number; reason: string }>;
    };
    expect(body.successCount).toBe(2);
    expect(body.failed).toEqual([{ id: boom, reason: 'internal_error' }]);
    expect(runRepo.findById(a)).toBeNull();
    expect(runRepo.findById(c)).toBeNull();
    expect(runRepo.findById(boom)).not.toBeNull();
    // An unmapped code is a contract-drift signal — it must be logged, not silently bucketed.
    expect(h.mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ id: boom }),
      'bench bulk-delete per-id internal_error',
    );
  });

  it('all-failed-known-reasons still returns 200 (partial-success envelope)', async () => {
    const res = await POST(makeRequest({ ids: [1, 2, 3] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      successCount: number;
      failed: Array<{ reason: string }>;
    };
    expect(body.successCount).toBe(0);
    expect(body.failed.every((f) => f.reason === 'not_found')).toBe(true);
  });

  // audit S2: the exclusive-write-lock hold must be measurable, not invisible.
  it('logs bench_bulk_purge with idsRequested / successCount / failedCount / durationMs / actorId', async () => {
    authMode.value = 'authenticated';
    const fileId = seedFile('/media/log.mkv', 'l'.repeat(64));
    const run = makeRun([fileId], 'complete');

    await POST(makeRequest({ ids: [run, 999_999] }));

    expect(h.mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'bench_bulk_purge',
        actorId: 'admin',
        idsRequested: 2,
        successCount: 1,
        failedCount: 1,
        durationMs: expect.any(Number),
      }),
      'bench_bulk_purge',
    );
  });
});

describe('POST /api/bench/bulk-delete — AC-7 envelope guards', () => {
  it('415 on wrong Content-Type', async () => {
    const req = new Request(ROUTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ ids: [1] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toBe('unsupported_media_type');
  });

  it('400 invalid_json on malformed body', async () => {
    const req = new Request(ROUTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_json');
  });

  it.each([
    ['empty ids array', { ids: [] }],
    ['over 500 ids', { ids: Array.from({ length: 501 }, (_, i) => i + 1) }],
    ['duplicate ids', { ids: [1, 2, 1] }],
    ['non-positive id', { ids: [1, 0] }],
    ['non-integer id', { ids: [1.5] }],
    ['missing ids key', {}],
  ])('400 invalid_body — %s', async (_label, body) => {
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error: string; details: unknown };
    expect(parsed.error).toBe('invalid_body');
    expect(parsed.details).toBeDefined();
  });

  it('exactly 500 ids is accepted (MAX_BULK boundary)', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => i + 1);
    const res = await POST(makeRequest({ ids }));
    expect(res.status).toBe(200);
  });

  it('auth-denial → 401, no purge attempted', async () => {
    authMode.value = 'denied';
    const fileId = seedFile('/media/auth.mkv', 'u'.repeat(64));
    const run = makeRun([fileId], 'complete');
    const res = await POST(makeRequest({ ids: [run] }));
    expect(res.status).toBe(401);
    expect(runRepo.findById(run)).not.toBeNull();
  });

  // audit S3: an outer tx-throw voids every per-id bench_run_purged audit line —
  // the rollback log must NAME the ids so reconstruction does not read phantom deletions.
  it('tx-throw → 500 internal_error + bench_bulk_purge_rolled_back naming the ids', async () => {
    vi.spyOn(db, 'transaction').mockImplementation((() => () => {
      throw new Error('db-corruption');
    }) as unknown as Db['transaction']);
    const res = await POST(makeRequest({ ids: [7, 8] }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('internal_error');
    expect(h.mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'bench_bulk_purge_rolled_back',
        ids: [7, 8],
        idsRequested: 2,
      }),
      expect.stringContaining('tx-throw'),
    );
  });
});

// AC-1 (audit S6) — the REPORTED operator bug, end-to-end on the surface it manifests on:
// a library entry referenced by a bench run is undeletable. Purging the referencing run
// must unblock it. 47-01 is the FIRST way out (purge the run, keep the file); 47-03 added
// the SECOND (delete the file, keep the run) by narrowing the guard to ACTIVE runs.
//
// 47-03 rewrite: the blocker is now established with a 'running' run, because a terminal
// one no longer blocks anything (that is the point of 47-03 and is asserted separately
// below). The purge path from 47-01 stays exercised end-to-end — the run is cancelled
// first, which is exactly the recovery the new error toast points the operator at.
// DO NOT delete this case: it is the only end-to-end cover of the 47-01 purge path
// against the library route.
describe('POST /api/bench/bulk-delete — S6 library-unblock end-to-end', () => {
  function libraryDeleteReq(fileId: number): Request {
    return new Request(`http://test/api/library/${fileId}`, { method: 'DELETE' });
  }

  it('active-bench-referenced file: 409 before purge → 200 after purge', async () => {
    const fileId = seedFile('/media/undeletable.mkv', 'd'.repeat(64));
    const runningRun = makeRun([fileId], 'running');
    seedCombos(runningRun, fileId, 4);

    // BEFORE: an ACTIVE run blocks the delete — the reported symptom.
    const before = await DELETE_LIBRARY_ENTRY(libraryDeleteReq(fileId), {
      params: Promise.resolve({ id: String(fileId) }),
    });
    expect(before.status).toBe(409);
    expect(((await before.json()) as { error: string }).error).toBe('delete_blocked_active_bench');

    // Cancel the run (the recovery the toast names), then purge it via 47-01.
    // An active run is deliberately NOT purgeable (reason 'active_run').
    runRepo.markCancelled(runningRun, 2);
    const purge = await POST(makeRequest({ ids: [runningRun] }));
    expect(purge.status).toBe(200);
    expect((await purge.json()).successCount).toBe(1);
    expect(comboCount(runningRun)).toBe(0);
    expect(files.isReferencedByActiveBench(fileId)).toBe(false);

    // AFTER: the very same request now succeeds.
    const after = await DELETE_LIBRARY_ENTRY(libraryDeleteReq(fileId), {
      params: Promise.resolve({ id: String(fileId) }),
    });
    expect(after.status).toBe(200);
    const body = (await after.json()) as { deleted: boolean; fileId: number };
    expect(body).toMatchObject({ deleted: true, fileId });
    expect(files.getById(fileId)).toBeUndefined();
  });

  // 47-03 AC-11: the second way out — a TERMINAL run no longer blocks at all,
  // so no purge is needed and the bench results survive with file_id IS NULL.
  it('failed-bench-referenced file: deletable WITHOUT purging, results survive', async () => {
    const fileId = seedFile('/media/terminal-ref.mkv', 'e'.repeat(64));
    const failedRun = makeRun([fileId], 'failed');
    seedCombos(failedRun, fileId, 4, true);

    expect(files.isReferencedByActiveBench(fileId)).toBe(false);

    const res = await DELETE_LIBRARY_ENTRY(libraryDeleteReq(fileId), {
      params: Promise.resolve({ id: String(fileId) }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deleted: boolean }).deleted).toBe(true);
    expect(files.getById(fileId)).toBeUndefined();

    // The run and its measurements survive; only the file mapping is severed.
    expect(comboCount(failedRun)).toBe(4);
    const combos = db
      .prepare('SELECT file_id, vmaf, size_bytes, encode_seconds FROM bench_combo WHERE run_id=?')
      .all(failedRun) as Array<{
      file_id: number | null;
      vmaf: number | null;
      size_bytes: number | null;
      encode_seconds: number | null;
    }>;
    for (const c of combos) {
      expect(c.file_id).toBeNull();
      expect(c.vmaf).toBe(95.5);
      expect(c.size_bytes).toBe(500_000);
      expect(c.encode_seconds).toBe(12.5);
    }
  });
});

// AC-8 (audit M1 correction): purging the newest complete run degrades to the EXISTING
// 404 no_completed_bench_run envelope. NOT 200-empty (that contract does not exist),
// NOT 500, NOT a throw. app/api/bench/recommendation/route.ts stays byte-identical.
describe('POST /api/bench/bulk-delete — AC-8 recommendation empty-state regression', () => {
  function recommendationReq(): Request {
    return new Request('http://test/api/bench/recommendation', { method: 'GET' });
  }

  it('purging the only complete run → recommendation answers 404 no_completed_bench_run', async () => {
    const fileId = seedFile('/media/rec.mkv', 'r'.repeat(64));
    const run = makeRun([fileId], 'complete');
    seedCombos(run, fileId, 1, true);

    const before = await GET_RECOMMENDATION(recommendationReq());
    expect(before.status).toBe(200);

    const purge = await POST(makeRequest({ ids: [run] }));
    expect(purge.status).toBe(200);
    expect((await purge.json()).successCount).toBe(1);

    const after = await GET_RECOMMENDATION(recommendationReq());
    expect(after.status).toBe(404);
    const body = (await after.json()) as { error: string; requestId: string };
    expect(body.error).toBe('no_completed_bench_run');
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    // no 500 / no throw — the route's own error branch was never reached
    expect(h.mockLoggerError).not.toHaveBeenCalled();
  });

  it('the ETA path degrades silently — findLatestComplete() is null post-purge', async () => {
    const fileId = seedFile('/media/eta.mkv', 'e'.repeat(64));
    const run = makeRun([fileId], 'complete');
    seedCombos(run, fileId, 1, true);
    expect(runRepo.findLatestComplete()).not.toBeNull();

    await POST(makeRequest({ ids: [run] }));

    // This is exactly the input estimate-engine.ts:291-292 keys on
    // (`const latestRun = ...findLatestComplete(); if (!latestRun) return null;`),
    // so resolveBenchData() returns null instead of throwing. The guard is asserted,
    // not changed (the file is a 47-01 boundary).
    expect(runRepo.findLatestComplete()).toBeNull();
  });

  it('an older complete run still serves the recommendation after the newest is purged', async () => {
    const fileId = seedFile('/media/older.mkv', 'o'.repeat(64));
    const older = makeRun([fileId], 'complete');
    seedCombos(older, fileId, 1, true);
    const newer = makeRun([fileId], 'complete');
    seedCombos(newer, fileId, 1, true);

    await POST(makeRequest({ ids: [newer] }));

    const after = await GET_RECOMMENDATION(recommendationReq());
    expect(after.status).toBe(200);
    expect((await after.json()).runId).toBe(older);
  });
});
