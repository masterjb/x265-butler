// @vitest-environment node
// 23-05 T3 (audit S2) — GET /api/diagnostics/cpu-capability route coverage.
// Sibling-route parity with bench-recommendation / diagnostics-route tests.
// Asserts: 401 unauthenticated, 200 authed envelope { cpu, requestId } + no-store.
// getCpuCapability injected (mocked) so NO real /proc read.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CpuCapability } from '@/src/lib/diagnostics/cpu-capability';

const { mockGetCpu, mockEnsureServerInit, authMode } = vi.hoisted(() => ({
  mockGetCpu: vi.fn<() => Promise<CpuCapability>>(),
  mockEnsureServerInit: vi.fn(),
  authMode: { value: 'disabled' as 'disabled' | 'authenticated' | 'denied' },
}));

vi.mock('@/src/lib/diagnostics/cpu-capability', () => ({
  getCpuCapability: mockGetCpu,
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
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
}));

vi.mock('@/src/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { GET, runtime } from '@/app/api/diagnostics/cpu-capability/route';

const BROADWELL: CpuCapability = {
  isIntel: true,
  vendorId: 'GenuineIntel',
  modelName: 'Intel(R) Core(TM) i5-5200U CPU @ 2.20GHz',
  family: 6,
  model: 61,
  microarch: 'Broadwell',
  graphicsGen: 5,
  hevcQsv: 'none',
};

describe('GET /api/diagnostics/cpu-capability', () => {
  beforeEach(() => {
    mockGetCpu.mockReset();
    mockEnsureServerInit.mockReset();
    authMode.value = 'disabled';
    mockGetCpu.mockResolvedValue(BROADWELL);
  });

  it('runtime export is nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('auth_enabled=true + no cookie → 401, getCpuCapability NOT called', async () => {
    authMode.value = 'denied';
    const res = await GET(new Request('http://test/api/diagnostics/cpu-capability'));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error_code).toBe('auth_required');
    expect(mockGetCpu).not.toHaveBeenCalled();
  });

  it('authed → 200 with cpu object + requestId envelope + no-store header', async () => {
    const res = await GET(new Request('http://test/api/diagnostics/cpu-capability'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toHaveProperty('cpu');
    expect(body).toHaveProperty('requestId');
    expect(typeof body.requestId).toBe('string');
    expect(body.cpu.microarch).toBe('Broadwell');
    expect(body.cpu.hevcQsv).toBe('none');
    expect(mockEnsureServerInit).toHaveBeenCalled();
  });

  it('auth disabled (no auth) → 200', async () => {
    authMode.value = 'disabled';
    const res = await GET(new Request('http://test/api/diagnostics/cpu-capability'));
    expect(res.status).toBe(200);
  });

  it('getCpuCapability throws → 500 internal_error', async () => {
    mockGetCpu.mockRejectedValue(new Error('boom'));
    const res = await GET(new Request('http://test/api/diagnostics/cpu-capability'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
    expect(body).toHaveProperty('requestId');
  });
});
