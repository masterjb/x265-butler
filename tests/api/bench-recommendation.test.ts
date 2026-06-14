// 12-01: Integration tests for GET /api/bench/recommendation.
// Harness pattern: vi.hoisted + vi.mock (audit M3 — mirrors tests/api/bench.test.ts;
// NO in-memory better-sqlite3 fixture).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BenchRunRow, BenchComboRow } from '@/src/lib/db/schema';

const {
  mockBenchRunFindLatestComplete,
  mockBenchRunFindById,
  mockBenchComboListByRun,
  mockEnsureServerInit,
  mockRequireAuth,
  mockAuthGuard,
  mockLoggerInfo,
  mockLoggerWarn,
  mockLoggerError,
  mockLoggerDebug,
} = vi.hoisted(() => ({
  mockBenchRunFindLatestComplete: vi.fn<() => BenchRunRow | null>(),
  mockBenchRunFindById: vi.fn<(id: number) => BenchRunRow | null>(),
  mockBenchComboListByRun: vi.fn<(runId: number) => BenchComboRow[]>(),
  mockEnsureServerInit: vi.fn(),
  mockRequireAuth: vi.fn(),
  mockAuthGuard: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLoggerDebug: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  benchRunRepo: () => ({
    findLatestComplete: mockBenchRunFindLatestComplete,
    findById: mockBenchRunFindById,
  }),
  benchComboRepo: () => ({
    listByRun: mockBenchComboListByRun,
  }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: mockRequireAuth,
  authGuard: mockAuthGuard,
  withRenewCookie: (res: Response) => res,
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: mockLoggerInfo,
      warn: mockLoggerWarn,
      error: mockLoggerError,
      debug: mockLoggerDebug,
    }),
  },
  default: {},
}));

import { GET } from '@/app/api/bench/recommendation/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ROUTE_URL = 'http://test/api/bench/recommendation';

function getReq(): Request {
  return new Request(ROUTE_URL, { method: 'GET' });
}

function makeRunRow(overrides: Partial<BenchRunRow> = {}): BenchRunRow {
  return {
    id: 42,
    status: 'complete',
    mode: 'native-sweep',
    matrix: { encoders: ['libx265'], presets: ['medium'], nativeValues: [22] },
    fileIds: [1],
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

function makeCombo(overrides: Partial<BenchComboRow> = {}): BenchComboRow {
  return {
    id: 1,
    run_id: 42,
    file_id: 1,
    encoder: 'libx265',
    preset: 'medium',
    native_quality_param: '-crf',
    native_quality_value: 22,
    vmaf_target: null,
    sample_idx: 0,
    vmaf: 92,
    size_bytes: 1000,
    encode_seconds: 1,
    source_sample_bytes: 2000,
    pass2_vmaf: null,
    pass2_size_bytes: null,
    pass2_encode_seconds: null,
    pass2_completed_at: null,
    status: 'complete',
    error_reason: null,
    is_pareto: 1,
    top3_role: 'quality',
    created_at: 1000,
    completed_at: 1001,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ ok: true, mode: 'disabled', username: null });
  mockAuthGuard.mockReturnValue(null);
});

describe('GET /api/bench/recommendation — 404 path (no completed run)', () => {
  it('findLatestComplete returns null → 404 with no_completed_bench_run + requestId UUID', async () => {
    mockBenchRunFindLatestComplete.mockReturnValue(null);

    const res = await GET(getReq());
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe('no_completed_bench_run');
    expect(body.requestId).toMatch(UUID_V4);

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'recommendation_no_completed_run' }),
    );
  });
});

describe('GET /api/bench/recommendation — 200 happy paths', () => {
  it('4 quality combos one-per-encoder → 200 with all 4 recommendations + requestId + completedAt', async () => {
    mockBenchRunFindLatestComplete.mockReturnValue(makeRunRow({ id: 99, completed_at: 12345 }));
    mockBenchComboListByRun.mockReturnValue([
      makeCombo({ encoder: 'libx265', native_quality_value: 22, preset: 'medium', id: 1 }),
      makeCombo({ encoder: 'nvenc', native_quality_value: 25, preset: 'p5', id: 2 }),
      makeCombo({ encoder: 'qsv', native_quality_value: 24, preset: 'medium', id: 3 }),
      makeCombo({ encoder: 'vaapi', native_quality_value: 23, preset: null, id: 4 }),
    ]);

    const res = await GET(getReq());
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      runId: number;
      completedAt: number;
      recommendations: Record<string, { crf: number; preset: string | null }>;
      requestId: string;
    };
    expect(body.runId).toBe(99);
    expect(body.completedAt).toBe(12345);
    expect(typeof body.completedAt).toBe('number');
    expect(body.requestId).toMatch(UUID_V4);
    expect(body.recommendations).toEqual({
      libx265: { crf: 22, preset: 'medium' },
      nvenc: { crf: 25, preset: 'p5' },
      qsv: { crf: 24, preset: 'medium' },
      vaapi: { crf: 23, preset: null },
    });

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'recommendation_served',
        runId: 99,
        recommendationCount: 4,
      }),
    );
  });

  it('latest run with zero combos → 200 with empty recommendations + requestId + completedAt', async () => {
    mockBenchRunFindLatestComplete.mockReturnValue(makeRunRow({ id: 7, completed_at: 999 }));
    mockBenchComboListByRun.mockReturnValue([]);

    const res = await GET(getReq());
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      runId: number;
      completedAt: number;
      recommendations: Record<string, unknown>;
      requestId: string;
    };
    expect(body.runId).toBe(7);
    expect(body.completedAt).toBe(999);
    expect(body.recommendations).toEqual({});
    expect(body.requestId).toMatch(UUID_V4);
  });
});

describe('GET /api/bench/recommendation — integrity-violation 500 (audit SR3)', () => {
  it('row with status=complete but completed_at=null → 500 + warn-log + requestId', async () => {
    mockBenchRunFindLatestComplete.mockReturnValue(makeRunRow({ id: 11, completed_at: null }));

    const res = await GET(getReq());
    expect(res.status).toBe(500);

    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toMatch(UUID_V4);

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'recommendation_integrity_violation',
        reason: 'status_complete_but_completed_at_null',
        runId: 11,
      }),
    );
    expect(mockBenchComboListByRun).not.toHaveBeenCalled();
  });
});

describe('GET /api/bench/recommendation — try/catch 500 (audit M2 / AC-7)', () => {
  it('findLatestComplete throws → 500 + error-log w/ stack + requestId', async () => {
    mockBenchRunFindLatestComplete.mockImplementation(() => {
      throw new Error('SQLITE_BUSY');
    });

    const res = await GET(getReq());
    expect(res.status).toBe(500);

    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toMatch(UUID_V4);

    expect(mockLoggerError).toHaveBeenCalled();
    const errCall = mockLoggerError.mock.calls[0][0] as { err: string };
    expect(typeof errCall.err).toBe('string');
    expect(errCall.err).toContain('SQLITE_BUSY');
  });

  it('listByRun throws → 500 + error-log + requestId', async () => {
    mockBenchRunFindLatestComplete.mockReturnValue(makeRunRow());
    mockBenchComboListByRun.mockImplementation(() => {
      throw new Error('listByRun-failed');
    });

    const res = await GET(getReq());
    expect(res.status).toBe(500);

    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockLoggerError).toHaveBeenCalled();
  });
});

describe('GET /api/bench/recommendation — divergence sentinel (audit SR2)', () => {
  it('identical quality-combos for same encoder → 200, NO divergence warn-log', async () => {
    mockBenchRunFindLatestComplete.mockReturnValue(makeRunRow());
    mockBenchComboListByRun.mockReturnValue([
      makeCombo({ encoder: 'libx265', native_quality_value: 22, preset: 'medium', id: 1 }),
      makeCombo({ encoder: 'libx265', native_quality_value: 22, preset: 'medium', id: 2 }),
      makeCombo({ encoder: 'libx265', native_quality_value: 22, preset: 'medium', id: 3 }),
      makeCombo({ encoder: 'libx265', native_quality_value: 22, preset: 'medium', id: 4 }),
    ]);

    const res = await GET(getReq());
    expect(res.status).toBe(200);

    const body = (await res.json()) as { recommendations: Record<string, unknown> };
    expect(body.recommendations).toEqual({ libx265: { crf: 22, preset: 'medium' } });

    const divergenceCalls = mockLoggerWarn.mock.calls.filter(
      (c) => (c[0] as { event?: string }).event === 'recommendation_duplicate_divergence',
    );
    expect(divergenceCalls).toHaveLength(0);
  });

  it('differing quality-combos for same encoder → 200, divergence warn-log emitted once', async () => {
    mockBenchRunFindLatestComplete.mockReturnValue(makeRunRow({ id: 50 }));
    mockBenchComboListByRun.mockReturnValue([
      makeCombo({ encoder: 'libx265', native_quality_value: 22, preset: 'medium', id: 1 }),
      makeCombo({ encoder: 'libx265', native_quality_value: 24, preset: 'slow', id: 2 }),
    ]);

    const res = await GET(getReq());
    expect(res.status).toBe(200);

    const divergenceCalls = mockLoggerWarn.mock.calls.filter(
      (c) => (c[0] as { event?: string }).event === 'recommendation_duplicate_divergence',
    );
    expect(divergenceCalls).toHaveLength(1);
    const payload = divergenceCalls[0][0] as {
      divergences: Array<{ encoder: string; picked: unknown; conflict: unknown }>;
      runId: number;
    };
    expect(payload.runId).toBe(50);
    expect(payload.divergences).toHaveLength(1);
    expect(payload.divergences[0]).toEqual({
      encoder: 'libx265',
      picked: { crf: 22, preset: 'medium' },
      conflict: { crf: 24, preset: 'slow' },
    });
  });
});

describe('GET /api/bench/recommendation — unknown encoder forward-compat (audit SR1)', () => {
  it('av1 + libx265 quality combos → 200 with known-only recs + debug-log encoders plural', async () => {
    mockBenchRunFindLatestComplete.mockReturnValue(makeRunRow());
    mockBenchComboListByRun.mockReturnValue([
      makeCombo({ encoder: 'av1', native_quality_value: 30, preset: null, id: 1 }),
      makeCombo({ encoder: 'libx265', native_quality_value: 22, preset: 'medium', id: 2 }),
    ]);

    const res = await GET(getReq());
    expect(res.status).toBe(200);

    const body = (await res.json()) as { recommendations: Record<string, unknown> };
    expect(body.recommendations).toEqual({ libx265: { crf: 22, preset: 'medium' } });

    expect(mockLoggerDebug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'recommendation_unknown_encoder',
        encoders: ['av1'],
        comboCount: 2,
      }),
    );
  });
});

// 12-04: ?runId + ?mode query-param contracts (AC-4 / AC-5 / AC-6 / SR6)
describe('GET /api/bench/recommendation — 12-04 ?runId + ?mode', () => {
  function getReqWith(qs: string): Request {
    return new Request(ROUTE_URL + qs, { method: 'GET' });
  }

  it('?runId=42&mode=balanced → findById(42) used, mode passed to helper', async () => {
    mockBenchRunFindById.mockReturnValue(makeRunRow({ id: 42, completed_at: 50_000 }));
    mockBenchComboListByRun.mockReturnValue([]);
    const res = await GET(getReqWith('?runId=42&mode=balanced'));
    expect(res.status).toBe(200);
    expect(mockBenchRunFindById).toHaveBeenCalledWith(42);
    expect(mockBenchRunFindLatestComplete).not.toHaveBeenCalled();
    const body = (await res.json()) as { runId: number; completedAt: number };
    expect(body.runId).toBe(42);
    expect(body.completedAt).toBe(50_000);
  });

  it('?runId=99 non-existent → 404 run_not_found', async () => {
    mockBenchRunFindById.mockReturnValue(null);
    const res = await GET(getReqWith('?runId=99'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe('run_not_found');
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('?runId=5 status=running → 400 run_not_complete', async () => {
    mockBenchRunFindById.mockReturnValue(makeRunRow({ id: 5, status: 'running' }));
    const res = await GET(getReqWith('?runId=5'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('run_not_complete');
  });

  it('?runId=-1 invalid → 400 invalid_query with details', async () => {
    const res = await GET(getReqWith('?runId=-1'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: unknown };
    expect(body.error).toBe('invalid_query');
    expect(body.details).toBeDefined();
  });

  it('?mode=speed invalid → 400 invalid_query with details (SR6)', async () => {
    const res = await GET(getReqWith('?mode=speed'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: unknown };
    expect(body.error).toBe('invalid_query');
    expect(body.details).toBeDefined();
  });

  it('?mode omitted defaults to quality (12-01 back-compat)', async () => {
    mockBenchRunFindLatestComplete.mockReturnValue(makeRunRow({ id: 99 }));
    mockBenchComboListByRun.mockReturnValue([]);
    const res = await GET(getReqWith(''));
    expect(res.status).toBe(200);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'recommendation_served', mode: 'quality' }),
    );
  });
});

describe('GET /api/bench/recommendation — auth-deny short-circuit (audit M1+M4 / AC-5)', () => {
  it('authGuard returns 401 → 401 + ZERO repo calls + ZERO success/empty log events', async () => {
    const denyResponse = new Response(JSON.stringify({ error_code: 'auth_required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    mockRequireAuth.mockResolvedValue({
      ok: false,
      status: 401,
      body: { error_code: 'auth_required' },
    });
    mockAuthGuard.mockReturnValue(denyResponse);

    const res = await GET(getReq());
    expect(res.status).toBe(401);

    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe('auth_required');

    expect(mockBenchRunFindLatestComplete).not.toHaveBeenCalled();
    expect(mockBenchComboListByRun).not.toHaveBeenCalled();

    const servedCalls = mockLoggerInfo.mock.calls.filter(
      (c) =>
        (c[0] as { event?: string }).event === 'recommendation_served' ||
        (c[0] as { event?: string }).event === 'recommendation_no_completed_run',
    );
    expect(servedCalls).toHaveLength(0);
  });
});
