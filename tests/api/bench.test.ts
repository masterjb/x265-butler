import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BenchRunRow, BenchComboRow, AggregatedComboView } from '@/src/lib/db/schema';

const {
  mockEnqueueRun,
  mockExecuteNextPending,
  mockCancelRun,
  mockPurgeRun,
  mockBenchRunFindById,
  mockBenchRunListRecent,
  mockBenchComboListByRun,
  mockBenchComboSummarizeRun,
  mockEnsureServerInit,
  mockLoggerInfo,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockEnqueueRun: vi.fn<(input: unknown) => Promise<{ runId: number }>>(),
  mockExecuteNextPending: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  mockCancelRun: vi.fn<(runId: number) => Promise<void>>(),
  // 47-01: purgeRun is SYNCHRONOUS by contract (TOCTOU + SAVEPOINT composition).
  mockPurgeRun: vi.fn<(runId: number) => { combosDeleted: number }>(),
  mockBenchRunFindById: vi.fn<(id: number) => BenchRunRow | undefined>(),
  mockBenchRunListRecent: vi.fn<(limit: number, offset: number) => BenchRunRow[]>(),
  mockBenchComboListByRun: vi.fn<(runId: number) => BenchComboRow[]>(),
  mockBenchComboSummarizeRun: vi.fn<(runId: number) => AggregatedComboView[]>(),
  mockEnsureServerInit: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  benchRunRepo: () => ({
    findById: mockBenchRunFindById,
    listRecent: mockBenchRunListRecent,
  }),
  benchComboRepo: () => ({
    listByRun: mockBenchComboListByRun,
    summarizeRun: mockBenchComboSummarizeRun,
  }),
  // 11-02-FIX-V2 UAT-003: fileRepo for fileSizeMap projection in /api/bench/[runId] GET.
  fileRepo: () => ({
    listByIds: vi.fn().mockReturnValue([]),
  }),
  OccConflictError: class OccConflictError extends Error {
    constructor(
      public runId: number,
      public expectedVersion: number,
      public actualVersion: number,
    ) {
      super(`OCC conflict run_id=${runId}`);
      this.name = 'OccConflictError';
    }
  },
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/bench/orchestrator', () => ({
  benchOrchestrator: () => ({
    enqueueRun: mockEnqueueRun,
    executeNextPending: mockExecuteNextPending,
    cancelRun: mockCancelRun,
    purgeRun: mockPurgeRun,
  }),
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: mockLoggerInfo,
      warn: vi.fn(),
      error: mockLoggerError,
      debug: vi.fn(),
    }),
    info: mockLoggerInfo,
    warn: vi.fn(),
    error: mockLoggerError,
    debug: vi.fn(),
  },
  default: {},
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ authenticated: false, method: 'none' }),
  authGuard: vi.fn().mockReturnValue(null),
  default: {},
}));

import { POST, GET } from '@/app/api/bench/route';
import { GET as GETRunId, DELETE } from '@/app/api/bench/[runId]/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function jsonPostReq(body: unknown, url = 'http://localhost/api/bench'): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getReq(url: string): Request {
  return new Request(url, { method: 'GET' });
}

function deleteReq(url: string): Request {
  return new Request(url, { method: 'DELETE' });
}

function makeRunRow(overrides: Partial<BenchRunRow> = {}): BenchRunRow {
  return {
    id: 1,
    status: 'complete',
    mode: 'native-sweep',
    matrix: { encoders: ['libx265'], presets: ['medium'], nativeValues: [28] },
    fileIds: [10],
    sample_count: 3,
    sample_duration_seconds: 20,
    vmaf_buckets_json: null,
    vmaf_model: 'vmaf_v0.6.1',
    actor_id: null,
    version: 1,
    created_at: 1000,
    started_at: 1001,
    completed_at: 1002,
    error_reason: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnqueueRun.mockResolvedValue({ runId: 7 });
  mockCancelRun.mockResolvedValue(undefined);
  mockPurgeRun.mockReturnValue({ combosDeleted: 12 });
  mockBenchRunFindById.mockReturnValue(makeRunRow());
  mockBenchRunListRecent.mockReturnValue([makeRunRow()]);
  mockBenchComboListByRun.mockReturnValue([]);
  mockBenchComboSummarizeRun.mockReturnValue([]);
});

describe('POST /api/bench', () => {
  it('valid native-sweep body → 201 + runId', async () => {
    const res = await POST(
      jsonPostReq({
        mode: 'native-sweep',
        fileIds: [1, 2],
        matrix: { encoders: ['libx265'], presets: ['medium'], nativeValues: [28, 32] },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: number; requestId: string };
    expect(body.runId).toBe(7);
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('valid vmaf-anchored body → 201', async () => {
    const res = await POST(
      jsonPostReq({
        mode: 'vmaf-anchored',
        fileIds: [10],
        matrix: { encoders: ['libx265'], presets: ['medium'], vmafTargets: [90, 95] },
        sampleCount: 2,
      }),
    );
    expect(res.status).toBe(201);
  });

  it('missing mode → 400 invalid_body', async () => {
    const res = await POST(jsonPostReq({ fileIds: [1], matrix: {} }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_body');
  });

  it('empty fileIds array → 400', async () => {
    const res = await POST(jsonPostReq({ mode: 'native-sweep', fileIds: [], matrix: {} }));
    expect(res.status).toBe(400);
  });

  it('wrong content-type → 415', async () => {
    const res = await POST(
      new Request('http://localhost/api/bench', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{}',
      }),
    );
    expect(res.status).toBe(415);
  });

  it('malformed JSON → 400', async () => {
    const res = await POST(
      new Request('http://localhost/api/bench', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{bad json',
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/bench', () => {
  it('returns runs list + requestId', async () => {
    const res = await GET(getReq('http://localhost/api/bench'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: BenchRunRow[]; requestId: string };
    expect(body.runs).toHaveLength(1);
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('invalid limit param → 400', async () => {
    const res = await GET(getReq('http://localhost/api/bench?limit=-5'));
    expect(res.status).toBe(400);
  });

  // 12-04 AC-14: ?status filter (audit M1)
  it('?status=complete → listRecent invoked 3-arg with status', async () => {
    mockBenchRunListRecent.mockReturnValue([makeRunRow({ status: 'complete' })]);
    const res = await GET(getReq('http://localhost/api/bench?status=complete&limit=10'));
    expect(res.status).toBe(200);
    expect(mockBenchRunListRecent).toHaveBeenCalledWith(10, 0, 'complete');
  });

  it('?status omitted → listRecent invoked 3-arg with undefined status (back-compat)', async () => {
    mockBenchRunListRecent.mockReturnValue([makeRunRow()]);
    const res = await GET(getReq('http://localhost/api/bench?limit=20'));
    expect(res.status).toBe(200);
    expect(mockBenchRunListRecent).toHaveBeenCalledWith(20, 0, undefined);
  });

  it('?status=invalid → 400 invalid_query with details', async () => {
    const res = await GET(getReq('http://localhost/api/bench?status=invalid'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: unknown };
    expect(body.error).toBe('invalid_query');
    expect(body.details).toBeDefined();
  });
});

describe('GET /api/bench/[runId]', () => {
  it('found run → 200 with run + combos + summary', async () => {
    const res = await GETRunId(getReq('http://localhost/api/bench/1'), {
      params: Promise.resolve({ runId: '1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: BenchRunRow;
      combos: BenchComboRow[];
      summary: AggregatedComboView[];
    };
    expect(body.run.id).toBe(1);
    expect(body.combos).toEqual([]);
    expect(body.summary).toEqual([]);
  });

  it('run not found → 404', async () => {
    mockBenchRunFindById.mockReturnValue(undefined);
    const res = await GETRunId(getReq('http://localhost/api/bench/99'), {
      params: Promise.resolve({ runId: '99' }),
    });
    expect(res.status).toBe(404);
  });

  it('invalid runId (non-numeric) → 400', async () => {
    const res = await GETRunId(getReq('http://localhost/api/bench/abc'), {
      params: Promise.resolve({ runId: 'abc' }),
    });
    expect(res.status).toBe(400);
  });
});

// 47-01: DELETE is PURGE now (row-delete + CASCADE), no longer cancel.
// Cancel lives in tests/api/bench-cancel-route.test.ts.
function codedError(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(code), { code, ...extra });
}

describe('DELETE /api/bench/[runId] — purge', () => {
  it('AC-1: success → 200 { runId, deleted:true, combosDeleted } + requestId', async () => {
    const res = await DELETE(deleteReq('http://localhost/api/bench/1'), {
      params: Promise.resolve({ runId: '1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runId: number;
      deleted: boolean;
      combosDeleted: number;
      requestId: string;
    };
    expect(body).toMatchObject({ runId: 1, deleted: true, combosDeleted: 12 });
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockPurgeRun).toHaveBeenCalledWith(1);
  });

  // AC-9 (audit M5): route-side actorId alongside the orchestrator's audit line.
  it('AC-9: logs action bench_purge with combosDeleted + actorId', async () => {
    await DELETE(deleteReq('http://localhost/api/bench/1'), {
      params: Promise.resolve({ runId: '1' }),
    });
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      { action: 'bench_purge', runId: 1, combosDeleted: 12, actorId: null },
      'bench run purged',
    );
  });

  it('AC-4: unknown run → 404 run_not_found', async () => {
    mockPurgeRun.mockImplementation(() => {
      throw codedError('run_not_found');
    });
    const res = await DELETE(deleteReq('http://localhost/api/bench/99'), {
      params: Promise.resolve({ runId: '99' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe('run_not_found');
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('AC-2: active run → 409 delete_rejected_active_run + currentStatus', async () => {
    mockPurgeRun.mockImplementation(() => {
      throw codedError('active_run', { currentStatus: 'running' });
    });
    const res = await DELETE(deleteReq('http://localhost/api/bench/1'), {
      params: Promise.resolve({ runId: '1' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; currentStatus: string; requestId: string };
    expect(body.error).toBe('delete_rejected_active_run');
    expect(body.currentStatus).toBe('running');
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('AC-3: pass-2 busy → 409 delete_rejected_active_pass2', async () => {
    mockPurgeRun.mockImplementation(() => {
      throw codedError('active_pass2');
    });
    const res = await DELETE(deleteReq('http://localhost/api/bench/1'), {
      params: Promise.resolve({ runId: '1' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('delete_rejected_active_pass2');
  });

  it('unmapped throw → 500 internal_error + error log', async () => {
    mockPurgeRun.mockImplementation(() => {
      throw new Error('db exploded');
    });
    const res = await DELETE(deleteReq('http://localhost/api/bench/1'), {
      params: Promise.resolve({ runId: '1' }),
    });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('internal_error');
    expect(mockLoggerError).toHaveBeenCalled();
  });

  it('AC-4: invalid runId → 400 invalid_run_id, orchestrator untouched', async () => {
    const res = await DELETE(deleteReq('http://localhost/api/bench/bad'), {
      params: Promise.resolve({ runId: 'bad' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_run_id');
    expect(mockPurgeRun).not.toHaveBeenCalled();
  });

  it('AC-4: non-positive runId → 400 invalid_run_id', async () => {
    const res = await DELETE(deleteReq('http://localhost/api/bench/0'), {
      params: Promise.resolve({ runId: '0' }),
    });
    expect(res.status).toBe(400);
  });

  // AC-5: DELETE has NO cancel side-effect left.
  it('AC-5: DELETE on a running run does NOT cancel it (409, cancelRun never called)', async () => {
    mockPurgeRun.mockImplementation(() => {
      throw codedError('active_run', { currentStatus: 'running' });
    });
    const res = await DELETE(deleteReq('http://localhost/api/bench/1'), {
      params: Promise.resolve({ runId: '1' }),
    });
    expect(res.status).toBe(409);
    expect(mockCancelRun).not.toHaveBeenCalled();
  });
});
