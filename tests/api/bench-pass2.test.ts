// 11-03 AC-4 + AC-4b: POST + DELETE /api/bench/[runId]/pass2

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BenchRunRow, BenchComboRow } from '@/src/lib/db/schema';

const {
  mockRunFindById,
  mockComboFindById,
  mockRunFullFileVerify,
  mockCancelPass2,
  mockEnsureServerInit,
  mockRequireAuth,
  mockAuthGuard,
} = vi.hoisted(() => ({
  mockRunFindById: vi.fn<(id: number) => BenchRunRow | undefined>(),
  mockComboFindById: vi.fn<(id: number) => BenchComboRow | undefined>(),
  mockRunFullFileVerify: vi.fn<(runId: number, comboId: number) => Promise<void>>(),
  mockCancelPass2: vi.fn<(runId: number, comboId: number) => void>(),
  mockEnsureServerInit: vi.fn(),
  mockRequireAuth: vi
    .fn()
    .mockResolvedValue({ ok: true, mode: 'disabled', username: null } as never),
  mockAuthGuard: vi.fn().mockReturnValue(null),
}));

vi.mock('@/src/lib/db', () => ({
  benchRunRepo: () => ({ findById: mockRunFindById }),
  benchComboRepo: () => ({ findById: mockComboFindById }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/bench/orchestrator', () => ({
  benchOrchestrator: () => ({
    runFullFileVerify: mockRunFullFileVerify,
    cancelPass2: mockCancelPass2,
  }),
  default: {},
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: mockRequireAuth,
  authGuard: mockAuthGuard,
  default: {},
}));

import { POST, DELETE } from '@/app/api/bench/[runId]/pass2/route';

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
    created_at: 1,
    started_at: 1,
    completed_at: 2,
    error_reason: null,
    ...overrides,
  };
}

function makeComboRow(overrides: Partial<BenchComboRow> = {}): BenchComboRow {
  return {
    id: 42,
    run_id: 1,
    file_id: 10,
    encoder: 'libx265',
    preset: 'medium',
    native_quality_param: '-crf',
    native_quality_value: 23,
    vmaf_target: null,
    sample_idx: 0,
    vmaf: 90,
    size_bytes: 1,
    encode_seconds: 1,
    source_sample_bytes: 1,
    pass2_vmaf: null,
    pass2_size_bytes: null,
    pass2_encode_seconds: null,
    pass2_completed_at: null,
    status: 'complete',
    error_reason: null,
    is_pareto: 1,
    top3_role: 'balanced',
    created_at: 1,
    completed_at: 2,
    ...overrides,
  };
}

function postReq(body: unknown, runId = 1): Request {
  return new Request(`http://localhost/api/bench/${runId}/pass2`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function deleteReq(body: unknown, runId = 1): Request {
  return new Request(`http://localhost/api/bench/${runId}/pass2`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function callPOST(req: Request, runId = '1'): Promise<Response> {
  return POST(req, { params: Promise.resolve({ runId }) });
}
async function callDELETE(req: Request, runId = '1'): Promise<Response> {
  return DELETE(req, { params: Promise.resolve({ runId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunFindById.mockReturnValue(makeRunRow());
  mockComboFindById.mockReturnValue(makeComboRow());
  mockRunFullFileVerify.mockResolvedValue(undefined);
  mockRequireAuth.mockResolvedValue({ ok: true, mode: 'disabled', username: null } as never);
  mockAuthGuard.mockReturnValue(null);
});

describe('POST /api/bench/[runId]/pass2', () => {
  it('happy path → 202 + comboId + startedAt', async () => {
    const res = await callPOST(postReq({ comboId: 42 }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { comboId: number; startedAt: number };
    expect(body.comboId).toBe(42);
    expect(body.startedAt).toBeGreaterThan(0);
    expect(mockRunFullFileVerify).toHaveBeenCalledWith(1, 42);
  });

  it('M1 audit: 401 when requireAuth denies (auth enforced)', async () => {
    mockAuthGuard.mockReturnValueOnce(
      new Response(JSON.stringify({ error_code: 'auth_required' }), { status: 401 }),
    );
    const res = await callPOST(postReq({ comboId: 42 }));
    expect(res.status).toBe(401);
    expect(mockRunFullFileVerify).not.toHaveBeenCalled();
  });

  it('run not found → 404', async () => {
    mockRunFindById.mockReturnValueOnce(undefined);
    const res = await callPOST(postReq({ comboId: 42 }));
    expect(res.status).toBe(404);
  });

  it('run.status !== complete → 409 run_not_completed', async () => {
    mockRunFindById.mockReturnValueOnce(makeRunRow({ status: 'running' }));
    const res = await callPOST(postReq({ comboId: 42 }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('run_not_completed');
  });

  it('combo belongs to another run → 404', async () => {
    mockComboFindById.mockReturnValueOnce(makeComboRow({ run_id: 999 }));
    const res = await callPOST(postReq({ comboId: 42 }));
    expect(res.status).toBe(404);
  });

  it('already verified → 409 already_verified', async () => {
    mockComboFindById.mockReturnValueOnce(makeComboRow({ pass2_completed_at: 1700000000 }));
    const res = await callPOST(postReq({ comboId: 42 }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('already_verified');
  });

  it('orchestrator pass2_busy → 409 pass2_busy', async () => {
    mockRunFullFileVerify.mockImplementationOnce(() => {
      const err = new Error('pass2_busy');
      (err as Error & { code?: string }).code = 'pass2_busy';
      throw err;
    });
    const res = await callPOST(postReq({ comboId: 42 }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('pass2_busy');
  });

  it('invalid comboId (zero) → 400 invalid_body', async () => {
    const res = await callPOST(postReq({ comboId: 0 }));
    expect(res.status).toBe(400);
  });

  it('invalid runId in URL → 400 invalid_run_id', async () => {
    const res = await callPOST(postReq({ comboId: 42 }, 0), 'abc');
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/bench/[runId]/pass2 (cancel — SR2)', () => {
  it('happy path → 202 + cancelledAt', async () => {
    const res = await callDELETE(deleteReq({ comboId: 42 }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { comboId: number; cancelledAt: number };
    expect(body.comboId).toBe(42);
    expect(body.cancelledAt).toBeGreaterThan(0);
    expect(mockCancelPass2).toHaveBeenCalledWith(1, 42);
  });

  it('M1 audit: 401 when auth denied', async () => {
    mockAuthGuard.mockReturnValueOnce(
      new Response(JSON.stringify({ error_code: 'auth_required' }), { status: 401 }),
    );
    const res = await callDELETE(deleteReq({ comboId: 42 }));
    expect(res.status).toBe(401);
    expect(mockCancelPass2).not.toHaveBeenCalled();
  });

  it('not running → 409 not_running', async () => {
    mockCancelPass2.mockImplementationOnce(() => {
      const err = new Error('not_running');
      (err as Error & { code?: string }).code = 'not_running';
      throw err;
    });
    const res = await callDELETE(deleteReq({ comboId: 42 }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_running');
  });

  it('combo belongs to another run → 404', async () => {
    mockComboFindById.mockReturnValueOnce(makeComboRow({ run_id: 999 }));
    const res = await callDELETE(deleteReq({ comboId: 42 }));
    expect(res.status).toBe(404);
  });
});
