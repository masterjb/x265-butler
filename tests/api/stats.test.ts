// 10-01: GET /api/stats contract tests.
// Verifies: 200 with all fields (cumulativeSavingsBytes, perEncoder,
// dailyTrend, topSavers, savingsBuckets, efficiencyRate) + string serialization
// of cumulativeSavingsBytes.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockGetKpis: vi.fn(),
  mockGetTrend30dFull: vi.fn(),
  mockGetTopSavers: vi.fn(),
  mockGetSavingsBuckets: vi.fn(),
  mockGetEncodeEfficiencyRate: vi.fn(),
  mockEnsureServerInit: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  statsRepo: () => ({
    getKpis: mocks.mockGetKpis,
    getTrend30dFull: mocks.mockGetTrend30dFull,
    getTopSavers: mocks.mockGetTopSavers,
    getSavingsBuckets: mocks.mockGetSavingsBuckets,
    getEncodeEfficiencyRate: mocks.mockGetEncodeEfficiencyRate,
  }),
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mocks.mockEnsureServerInit,
}));

vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => ({ ok: true, mode: 'disabled', username: null })),
  authGuard: (decision: { ok: boolean }) =>
    decision.ok ? null : new Response('', { status: 401 }),
}));

import { GET, runtime } from '@/app/api/stats/route';

function getReq(): Request {
  return new Request('http://localhost/api/stats', { method: 'GET' });
}

describe('GET /api/stats', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.mockGetKpis.mockReturnValue({
      totalSaved: 1234567,
      filesProcessed: 10,
      avgSavingsPercent: 25.5,
      cumulativeThroughputPerDay: 500000,
      byEncoder: { libx265: { count: 5, saved: 1000000 } },
    });
    mocks.mockGetTrend30dFull.mockReturnValue([]);
    mocks.mockGetTopSavers.mockReturnValue([]);
    mocks.mockGetSavingsBuckets.mockReturnValue({
      realized: 200,
      lost: 5000,
      rejected: 100,
      realizedCount: 1,
      totalCount: 3,
    });
    mocks.mockGetEncodeEfficiencyRate.mockReturnValue({ rate: 0.333, sampleSize: 3 });
  });

  it('test_route_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_GET_stats_returns_200_with_all_required_fields', async () => {
    const response = await GET(getReq());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    // cumulativeSavingsBytes serialized as string (bigint-safety)
    expect(typeof body.cumulativeSavingsBytes).toBe('string');
    expect(body.cumulativeSavingsBytes).toBe('1234567');
    expect(body.perEncoder).toEqual({ libx265: { count: 5, saved: 1000000 } });
    expect(Array.isArray(body.dailyTrend)).toBe(true);
    expect(Array.isArray(body.topSavers)).toBe(true);
    // 10-01 new fields
    expect(body.savingsBuckets).toEqual({
      realized: 200,
      lost: 5000,
      rejected: 100,
      realizedCount: 1,
      totalCount: 3,
    });
    expect(body.efficiencyRate).toMatchObject({ rate: expect.any(Number), sampleSize: 3 });
    expect(mocks.mockEnsureServerInit).toHaveBeenCalledOnce();
  });
});
