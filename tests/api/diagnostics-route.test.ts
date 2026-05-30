// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DiagnosticsPayload } from '@/src/lib/diagnostics/types';
import {
  EMPTY_BLOCKLIST_BLOCK_22_00,
  EMPTY_SLOW_REQUESTS_BLOCK_22_01,
  EMPTY_SLOW_QUERIES_BLOCK_22_01,
  EMPTY_WEB_VITALS_BLOCK_22_01,
  NULL_CONTAINER_IMAGE_BLOCK_22_00,
  NULL_CPU_BLOCK_23_05,
} from '@/tests/diagnostics/fixtures/empty-blocks-22-00';

const { mockAssemble, mockEnsureServerInit, authMode } = vi.hoisted(() => ({
  mockAssemble: vi.fn<() => Promise<DiagnosticsPayload>>(),
  mockEnsureServerInit: vi.fn(),
  authMode: { value: 'disabled' as 'disabled' | 'authenticated' | 'denied' },
}));

vi.mock('@/src/lib/diagnostics/aggregator', () => ({
  assembleDiagnostics: mockAssemble,
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

import { GET, runtime } from '@/app/api/diagnostics/route';

function fixture(): DiagnosticsPayload {
  return {
    app: { version: '2.17.2', gitHash: 'dev', committedAt: null, committedAtCET: null },
    runtime: { nodeVersion: 'v20', platform: 'linux', arch: 'x64', uptimeSec: 1, pid: 1 },
    mounts: [],
    devices: { dri: [], nvidia: [], renderDevices: [] },
    encoders: { detected: ['libx265'], warnings: [], outcome: [] },
    warnings: [],
    recentErrors: [],
    onboarding: { completed: true, hasShare: true },
    cpu: NULL_CPU_BLOCK_23_05,
    blocklist: EMPTY_BLOCKLIST_BLOCK_22_00,
    containerImage: NULL_CONTAINER_IMAGE_BLOCK_22_00,
    slowRequests: EMPTY_SLOW_REQUESTS_BLOCK_22_01,
    slowQueries: EMPTY_SLOW_QUERIES_BLOCK_22_01,
    webVitals: EMPTY_WEB_VITALS_BLOCK_22_01,
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('GET /api/diagnostics', () => {
  beforeEach(() => {
    mockAssemble.mockReset();
    mockEnsureServerInit.mockReset();
    authMode.value = 'disabled';
    mockAssemble.mockResolvedValue(fixture());
  });

  it('runtime export is nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('auth_enabled=false + no cookie → 200 + valid JSON with all top-level keys', async () => {
    const res = await GET(new Request('http://test/api/diagnostics'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    for (const key of [
      'app',
      'runtime',
      'mounts',
      'devices',
      'encoders',
      'warnings',
      'recentErrors',
      'onboarding',
      'generatedAt',
    ]) {
      expect(body).toHaveProperty(key);
    }
    expect(mockEnsureServerInit).toHaveBeenCalled();
  });

  it('auth_enabled=true + no cookie → 401', async () => {
    authMode.value = 'denied';
    const res = await GET(new Request('http://test/api/diagnostics'));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error_code).toBe('auth_required');
    expect(mockAssemble).not.toHaveBeenCalled();
  });

  it('auth_enabled=true + valid session-cookie → 200', async () => {
    authMode.value = 'authenticated';
    const res = await GET(new Request('http://test/api/diagnostics'));
    expect(res.status).toBe(200);
  });

  it('assembler throws → 500 with error_code: diagnostics_unavailable', async () => {
    mockAssemble.mockRejectedValue(new Error('boom'));
    const res = await GET(new Request('http://test/api/diagnostics'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error_code).toBe('diagnostics_unavailable');
  });
});
