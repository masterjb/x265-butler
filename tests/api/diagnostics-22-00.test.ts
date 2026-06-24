// @vitest-environment node
// 22-00 T4 IMP-14: cross-cutting integration tests across /api/diagnostics +
// /api/diagnostics-report. Validates the typed shape end-to-end.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DiagnosticsPayload } from '@/src/lib/diagnostics/types';
import {
  EMPTY_SLOW_QUERIES_BLOCK_22_01,
  EMPTY_CPU_ATTRIBUTION_BLOCK_40_01,
  EMPTY_WEB_VITALS_BLOCK_22_01,
  EMPTY_SLOW_REQUESTS_BLOCK_22_01,
  NULL_CONTAINER_IMAGE_BLOCK_22_00,
  NULL_CPU_BLOCK_23_05,
  DEFAULT_CACHE_BLOCK_24_03,
} from '@/tests/diagnostics/fixtures/empty-blocks-22-00';

const { mockAssemble, mockClearCache, mockEnsureServerInit, mockProbe } = vi.hoisted(() => ({
  mockAssemble: vi.fn<() => Promise<DiagnosticsPayload>>(),
  mockClearCache: vi.fn(),
  mockProbe: vi.fn(),
  mockEnsureServerInit: vi.fn(),
}));

vi.mock('@/src/lib/diagnostics/aggregator', () => ({
  assembleDiagnostics: mockAssemble,
}));

vi.mock('@/src/lib/diagnostics/container-image-probe', () => ({
  clearContainerImageCache: mockClearCache,
  probeContainerImage: mockProbe,
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

import {
  GET as getDiagnostics,
  _resetRefreshRateLimitForTesting,
} from '@/app/api/diagnostics/route';
import { GET as getReport } from '@/app/api/diagnostics-report/route';

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
    blocklist: {
      totalEntries: 4,
      patternCachedAt: '2026-05-23T11:00:00.000Z',
      recentEvaluations: [
        {
          path: '/m/foo.srt',
          matchedEntry: { id: 1, kind: 'path_pattern', pattern: '*.srt' },
          matchedAt: '2026-05-23T10:00:00.000Z',
        },
      ],
    },
    containerImage: {
      ...NULL_CONTAINER_IMAGE_BLOCK_22_00,
      os: { id: 'debian', version: '12', prettyName: 'Debian GNU/Linux 12 (bookworm)' },
      glibc: { version: '2.36' },
    },
    slowRequests: EMPTY_SLOW_REQUESTS_BLOCK_22_01,
    slowQueries: EMPTY_SLOW_QUERIES_BLOCK_22_01,
    cpuAttribution: EMPTY_CPU_ATTRIBUTION_BLOCK_40_01,
    webVitals: EMPTY_WEB_VITALS_BLOCK_22_01,
    generatedAt: '2026-05-23T00:00:00.000Z',
  };
}

describe('22-00 T4: cross-cutting integration', () => {
  beforeEach(() => {
    mockAssemble.mockReset();
    mockClearCache.mockReset();
    mockProbe.mockReset();
    mockEnsureServerInit.mockReset();
    mockAssemble.mockResolvedValue(fixture());
    _resetRefreshRateLimitForTesting();
  });

  it('GET /api/diagnostics returns payload.containerImage + payload.blocklist with typed shape', async () => {
    const res = await getDiagnostics(new Request('http://test/api/diagnostics'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as DiagnosticsPayload;
    expect(body).toHaveProperty('blocklist');
    expect(body).toHaveProperty('containerImage');
    expect(body.blocklist.totalEntries).toBe(4);
    expect(body.blocklist.recentEvaluations[0].path).toBe('/m/foo.srt');
    expect(body.containerImage.os.prettyName).toBe('Debian GNU/Linux 12 (bookworm)');
    expect(body.containerImage.glibc.version).toBe('2.36');
    // 23-00: additive oneVPL block present in the typed payload boundary.
    expect(body.containerImage.drivers.oneVpl).toEqual({
      libmfxGen1: { version: null },
      libvpl: { version: null },
      libigfxcmrt: { version: null },
    });
  });

  it('GET /api/diagnostics-report Markdown body contains both new sections', async () => {
    const res = await getReport(new Request('http://test/api/diagnostics-report'));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/^## Container Image$/m);
    expect(body).toMatch(/^## Blocklist Evaluation$/m);
    // EMPTY_BLOCKLIST_BLOCK fixture has empty containerImage / single match — but here
    // we use a populated fixture, so a Markdown table row for /m/foo.srt should appear.
    expect(body).toContain('/m/foo.srt');
    expect(body).toContain('Debian GNU/Linux 12 (bookworm)');
  });

  it('GET /api/diagnostics?refresh=1 clears containerImage cache (clearContainerImageCache spy fires)', async () => {
    const res = await getDiagnostics(
      new Request('http://test/api/diagnostics?refresh=1', {
        headers: { 'x-forwarded-for': '9.9.9.9' },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockClearCache).toHaveBeenCalledTimes(1);
  });
});
