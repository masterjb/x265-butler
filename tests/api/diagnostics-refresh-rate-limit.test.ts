// @vitest-environment node
// 22-00 T3 IMP-11 audit-fix:SR2 — /api/diagnostics?refresh=1 rate-limit (AC-11).
//
// First ?refresh=1 from an IP → 200 + container-image cache cleared.
// Second ?refresh=1 from same IP within 10s → 429 + retryAfter.
// Plain GET (no ?refresh) must NOT be metered.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DiagnosticsPayload } from '@/src/lib/diagnostics/types';
import {
  EMPTY_BLOCKLIST_BLOCK_22_00,
  EMPTY_SLOW_REQUESTS_BLOCK_22_01,
  EMPTY_SLOW_QUERIES_BLOCK_22_01,
  EMPTY_CPU_ATTRIBUTION_BLOCK_40_01,
  EMPTY_WEB_VITALS_BLOCK_22_01,
  NULL_CONTAINER_IMAGE_BLOCK_22_00,
  NULL_CPU_BLOCK_23_05,
  DEFAULT_CACHE_BLOCK_24_03,
} from '@/tests/diagnostics/fixtures/empty-blocks-22-00';

const { mockAssemble, mockClearCache, mockEnsureServerInit } = vi.hoisted(() => ({
  mockAssemble: vi.fn<() => Promise<DiagnosticsPayload>>(),
  mockClearCache: vi.fn(),
  mockEnsureServerInit: vi.fn(),
}));

vi.mock('@/src/lib/diagnostics/aggregator', () => ({
  assembleDiagnostics: mockAssemble,
}));

vi.mock('@/src/lib/diagnostics/container-image-probe', () => ({
  clearContainerImageCache: mockClearCache,
  probeContainerImage: vi.fn(),
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
}));

vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => ({ ok: true, mode: 'disabled', username: null })),
  authGuard: () => null,
  withRenewCookie: (res: Response) => res,
}));

vi.mock('@/src/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { GET, _resetRefreshRateLimitForTesting } from '@/app/api/diagnostics/route';

function fixture(): DiagnosticsPayload {
  return {
    app: { version: '2.18.0', gitHash: 'dev', committedAt: null, committedAtCET: null },
    runtime: { nodeVersion: 'v20', platform: 'linux', arch: 'x64', uptimeSec: 1, pid: 1 },
    mounts: [],
    devices: { dri: [], nvidia: [], renderDevices: [] },
    encoders: { detected: ['libx265'], warnings: [], outcome: [] },
    warnings: [],
    recentErrors: [],
    onboarding: { completed: true, hasShare: true },
    cache: DEFAULT_CACHE_BLOCK_24_03,
    cpu: NULL_CPU_BLOCK_23_05,
    blocklist: EMPTY_BLOCKLIST_BLOCK_22_00,
    containerImage: NULL_CONTAINER_IMAGE_BLOCK_22_00,
    slowRequests: EMPTY_SLOW_REQUESTS_BLOCK_22_01,
    slowQueries: EMPTY_SLOW_QUERIES_BLOCK_22_01,
    cpuAttribution: EMPTY_CPU_ATTRIBUTION_BLOCK_40_01,
    webVitals: EMPTY_WEB_VITALS_BLOCK_22_01,
    generatedAt: '2026-05-23T00:00:00.000Z',
  };
}

function reqWithIp(ip: string, query = ''): Request {
  return new Request(`http://test/api/diagnostics${query}`, {
    headers: { 'x-forwarded-for': ip },
  });
}

describe('22-00 T3 AC-11: /api/diagnostics?refresh=1 rate-limit', () => {
  beforeEach(() => {
    mockAssemble.mockReset();
    mockClearCache.mockReset();
    mockEnsureServerInit.mockReset();
    mockAssemble.mockResolvedValue(fixture());
    _resetRefreshRateLimitForTesting();
  });

  it('first ?refresh=1 from an IP within window → 200 + cache cleared', async () => {
    const res = await GET(reqWithIp('1.2.3.4', '?refresh=1'));
    expect(res.status).toBe(200);
    expect(mockClearCache).toHaveBeenCalledTimes(1);
  });

  it('second ?refresh=1 from same IP within 10s → 429 + retryAfter present + cache NOT cleared again', async () => {
    const res1 = await GET(reqWithIp('1.2.3.4', '?refresh=1'));
    expect(res1.status).toBe(200);

    const res2 = await GET(reqWithIp('1.2.3.4', '?refresh=1'));
    expect(res2.status).toBe(429);
    const body = (await res2.json()) as { error: string; retryAfter: number };
    expect(body.error).toBe('rate_limited');
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(body.retryAfter).toBeLessThanOrEqual(10);
    expect(res2.headers.get('Retry-After')).toMatch(/^\d+$/);
    // cache cleared exactly once (the first call); the rate-limited call must NOT re-clear.
    expect(mockClearCache).toHaveBeenCalledTimes(1);
  });

  it('plain GET (no ?refresh) MUST NOT be rate-limited', async () => {
    await GET(reqWithIp('1.2.3.4'));
    await GET(reqWithIp('1.2.3.4'));
    const res3 = await GET(reqWithIp('1.2.3.4'));
    expect(res3.status).toBe(200);
    expect(mockClearCache).not.toHaveBeenCalled();
  });

  it('different IPs are tracked separately', async () => {
    const a = await GET(reqWithIp('1.1.1.1', '?refresh=1'));
    const b = await GET(reqWithIp('2.2.2.2', '?refresh=1'));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(mockClearCache).toHaveBeenCalledTimes(2);
  });
});
