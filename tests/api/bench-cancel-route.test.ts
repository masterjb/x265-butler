// 47-01 T2 — POST /api/bench/[runId]/cancel.
// Carries the pre-47 DELETE /api/bench/[runId] cancel semantics VERBATIM (AC-5) and adds
// the AC-11 CSRF Content-Type guard the transport move made necessary.
// Harness mirrors tests/api/bench.test.ts (vi.hoisted + vi.mock, no DB fixture).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockCancelRun, mockEnsureServerInit, mockLoggerInfo, mockLoggerWarn, mockLoggerError } =
  vi.hoisted(() => ({
    mockCancelRun: vi.fn<(runId: number) => Promise<void>>(),
    mockEnsureServerInit: vi.fn(),
    mockLoggerInfo: vi.fn(),
    mockLoggerWarn: vi.fn(),
    mockLoggerError: vi.fn(),
  }));

vi.mock('@/src/lib/db', () => ({
  OccConflictError: class OccConflictError extends Error {
    constructor(
      public table: string,
      public id: number,
      public expectedVersion: number,
      public actualVersion: number,
    ) {
      super(`OCC conflict ${table}(id=${id})`);
      this.name = 'OccConflictError';
    }
  },
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/bench/orchestrator', () => ({
  benchOrchestrator: () => ({ cancelRun: mockCancelRun }),
  default: {},
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: mockLoggerInfo,
      warn: mockLoggerWarn,
      error: mockLoggerError,
      debug: vi.fn(),
    }),
  },
  default: {},
}));

vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ authenticated: false, method: 'none' }),
  authGuard: vi.fn().mockReturnValue(null),
  default: {},
}));

import { POST, runtime, dynamic } from '@/app/api/bench/[runId]/cancel/route';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function postReq(runId = '1', headers?: Record<string, string>): Request {
  return new Request(`http://localhost/api/bench/${runId}/cancel`, {
    method: 'POST',
    ...(headers ? { headers } : {}),
  });
}

function call(runId = '1', headers?: Record<string, string>): Promise<Response> {
  return POST(postReq(runId, headers), { params: Promise.resolve({ runId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCancelRun.mockResolvedValue(undefined);
});

describe('POST /api/bench/[runId]/cancel — route exports', () => {
  it('runtime nodejs + dynamic force-dynamic (parity with the parent route)', () => {
    expect(runtime).toBe('nodejs');
    expect(dynamic).toBe('force-dynamic');
  });
});

describe('POST /api/bench/[runId]/cancel — AC-5 (cancel semantics moved verbatim)', () => {
  it('success → 200 { runId, cancelled:true, requestId }', async () => {
    const res = await call('5');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: number; cancelled: boolean; requestId: string };
    expect(body).toMatchObject({ runId: 5, cancelled: true });
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockCancelRun).toHaveBeenCalledWith(5);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      { action: 'bench_cancel', runId: 5 },
      'bench run cancelled',
    );
  });

  it('unknown run → 404 run_not_found', async () => {
    mockCancelRun.mockRejectedValue(new Error('bench_run 99 not found'));
    const res = await call('99');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe('run_not_found');
    expect(body.requestId).toMatch(UUID_V4);
  });

  it('OccConflictError → 409 occ_conflict', async () => {
    const { OccConflictError } = await import('@/src/lib/db');
    mockCancelRun.mockRejectedValue(new OccConflictError('bench_run', 1, 1, 2));
    const res = await call('1');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('occ_conflict');
  });

  it('invalid runId → 400 invalid_run_id, orchestrator untouched', async () => {
    const res = await call('bad');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_run_id');
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it('non-positive runId → 400 invalid_run_id', async () => {
    const res = await call('0');
    expect(res.status).toBe(400);
  });

  it('unmapped throw → 500 internal_error + error log', async () => {
    mockCancelRun.mockRejectedValue(new Error('kaboom'));
    const res = await call('1');
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('internal_error');
    expect(mockLoggerError).toHaveBeenCalled();
  });
});

// AC-11 (audit M4): a body-less POST is form-forgeable — the three form-encodable
// Content-Types must be rejected, while the guard-free fetch(url,{method:'POST'})
// shape (absent header) and application/json must pass.
describe('POST /api/bench/[runId]/cancel — AC-11 CSRF Content-Type matrix', () => {
  it.each([
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=----x',
    'text/plain',
  ])('%s → 415 unsupported_media_type and the run is NOT cancelled', async (contentType) => {
    const res = await call('1', { 'content-type': contentType });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: string; requestId: string };
    expect(body.error).toBe('unsupported_media_type');
    expect(body.requestId).toMatch(UUID_V4);
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it('absent Content-Type header (the fetch(url,{method:POST}) shape) → 200', async () => {
    const res = await call('1');
    expect(res.status).toBe(200);
    expect(mockCancelRun).toHaveBeenCalledWith(1);
  });

  it('application/json → 200', async () => {
    const res = await call('1', { 'content-type': 'application/json' });
    expect(res.status).toBe(200);
    expect(mockCancelRun).toHaveBeenCalledWith(1);
  });

  it('APPLICATION/JSON; charset=utf-8 (case + params) → 200', async () => {
    const res = await call('1', { 'content-type': 'APPLICATION/JSON; charset=utf-8' });
    expect(res.status).toBe(200);
  });
});
