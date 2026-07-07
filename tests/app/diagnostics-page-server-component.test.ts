// @vitest-environment node
// Phase 21 Plan 21-02 T3 Step 8b — Server-Component auth-mirror gate (AC-16, audit-M2).
//
// Assert: redirect('/login?next=/diagnostics') BEFORE assembleDiagnostics()
// AND BEFORE logger.info — otherwise gitHash + image-digest + mount-paths +
// recentErrors leak to unauthenticated browsers.

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

const { mockAssemble, mockLogger, mockEnsureServerInit, mockRedirect, mockCookies, authMode } =
  vi.hoisted(() => ({
    mockAssemble: vi.fn<() => Promise<DiagnosticsPayload>>(),
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockEnsureServerInit: vi.fn(),
    mockRedirect: vi.fn((url: string) => {
      throw new Error(`REDIRECT:${url}`);
    }),
    mockCookies: vi.fn(async () => ({
      getAll: () => [] as Array<{ name: string; value: string }>,
    })),
    authMode: { value: 'disabled' as 'disabled' | 'authenticated' | 'denied' },
  }));

vi.mock('@/src/lib/diagnostics/aggregator', () => ({
  assembleDiagnostics: mockAssemble,
}));
vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
}));
vi.mock('@/src/lib/logger', () => ({
  logger: mockLogger,
}));
vi.mock('next/headers', () => ({
  cookies: mockCookies,
}));
vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
}));
vi.mock('next-intl/server', () => ({
  setRequestLocale: vi.fn(),
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock('@/components/diagnostics/diagnostics-client', () => ({
  DiagnosticsClient: () => null,
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
    return new Response(JSON.stringify(decision.body), { status: decision.status });
  },
  withRenewCookie: (res: Response) => res,
}));

import DiagnosticsPage from '@/app/[locale]/diagnostics/page';

function fixture(): DiagnosticsPayload {
  return {
    app: { version: '2.17.3', gitHash: 'abc', committedAt: null, committedAtCET: null },
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
    pollingShares: [],
    webVitals: EMPTY_WEB_VITALS_BLOCK_22_01,
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('Server-Component /[locale]/diagnostics auth-mirror gate (audit-M2)', () => {
  beforeEach(() => {
    mockAssemble.mockReset();
    mockLogger.info.mockReset();
    mockEnsureServerInit.mockReset();
    mockRedirect.mockClear();
    authMode.value = 'disabled';
    mockAssemble.mockResolvedValue(fixture());
  });

  it('auth_enabled=true + no session → redirect to /login BEFORE assembleDiagnostics + BEFORE logger.info', async () => {
    authMode.value = 'denied';
    await expect(DiagnosticsPage({ params: Promise.resolve({ locale: 'en' }) })).rejects.toThrow(
      /REDIRECT:\/en\/login\?next=\/en\/diagnostics/,
    );
    expect(mockRedirect).toHaveBeenCalledWith('/en/login?next=/en/diagnostics');
    expect(mockAssemble).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('auth_enabled=false → assembleDiagnostics runs + logger.info emits with source=page-server-component', async () => {
    authMode.value = 'disabled';
    await DiagnosticsPage({ params: Promise.resolve({ locale: 'en' }) });
    expect(mockAssemble).toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.event).toBe('diagnosticsPageOpened');
    expect(call.source).toBe('page-server-component');
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('auth_enabled=true + valid session → assembleDiagnostics runs + no redirect', async () => {
    authMode.value = 'authenticated';
    await DiagnosticsPage({ params: Promise.resolve({ locale: 'en' }) });
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockAssemble).toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
  });
});
