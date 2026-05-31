/*
 * 05-01 Task 3: SSE auth-gate ordering — audit S3 + AC-10.
 *
 * Verifies app/api/events/route.ts rejects with 401 BEFORE constructing
 * the ReadableStream when auth_enabled='true' and no valid cookie is
 * present. Three behavioral paths covered:
 *   - auth_enabled='false' → stream opens (zero-regression)
 *   - auth_enabled='true' + no cookie → 401, no stream allocation
 *   - auth_enabled='true' + valid cookie → stream opens
 *
 * Plus a static-analysis grep gate that asserts in source code,
 * `requireAuth(...)` appears textually BEFORE the first `new ReadableStream`
 * AND `engineEvents.subscribe` line — preventing future refactors from
 * inverting the ordering.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockEnsureServerInit,
  mockGetCachedAuthSetting,
  mockJobListActive,
  mockJobCountByStatus,
  mockEngineEventsSubscribe,
  mockEngineEventsLastProgress,
} = vi.hoisted(() => ({
  mockEnsureServerInit: vi.fn(),
  mockGetCachedAuthSetting: vi.fn(),
  mockJobListActive: vi.fn(),
  mockJobCountByStatus: vi.fn(),
  mockEngineEventsSubscribe: vi.fn(),
  mockEngineEventsLastProgress: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  jobRepo: () => ({
    listActive: mockJobListActive,
    countByStatus: mockJobCountByStatus,
  }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/encode/events', () => ({
  engineEvents: {
    subscribe: mockEngineEventsSubscribe,
    getLastProgress: mockEngineEventsLastProgress,
  },
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
  default: {},
}));

vi.mock('@/src/lib/auth/settings-cache', () => ({
  getCachedAuthSetting: mockGetCachedAuthSetting,
  invalidateAuthSettingsCache: vi.fn(),
}));

import { GET } from '@/app/api/events/route';
import { signSession } from '@/src/lib/auth/session';

const SECRET = 'a'.repeat(64);
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

beforeEach(() => {
  mockEnsureServerInit.mockReset();
  mockGetCachedAuthSetting.mockReset();
  mockJobListActive.mockReset().mockReturnValue([]);
  mockJobCountByStatus.mockReset().mockReturnValue(0);
  mockEngineEventsSubscribe.mockReset().mockReturnValue(() => {});
  mockEngineEventsLastProgress.mockReset().mockReturnValue(undefined);
});

describe('GET /api/events — SSE auth-gate ordering (audit S3 + AC-10)', () => {
  it('test_when_auth_disabled_then_stream_opens_zero_regression', async () => {
    mockGetCachedAuthSetting.mockImplementation((key: string) => {
      if (key === 'auth_enabled') return 'false';
      return '';
    });
    const res = await GET(new Request('http://test/api/events'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(mockEngineEventsSubscribe).toHaveBeenCalled();
  });

  it('test_when_auth_enabled_and_no_cookie_then_401_no_stream_subscribed', async () => {
    mockGetCachedAuthSetting.mockImplementation((key: string) => {
      if (key === 'auth_enabled') return 'true';
      if (key === 'session_secret') return SECRET;
      return '';
    });
    const res = await GET(new Request('http://test/api/events'));
    expect(res.status).toBe(401);
    expect((await res.json()).error_code).toBe('auth_required');
    expect(mockEngineEventsSubscribe).not.toHaveBeenCalled();
  });

  it('test_when_auth_enabled_and_valid_cookie_then_stream_opens', async () => {
    mockGetCachedAuthSetting.mockImplementation((key: string) => {
      if (key === 'auth_enabled') return 'true';
      if (key === 'session_secret') return SECRET;
      if (key === 'session_ttl_seconds') return '604800';
      return '';
    });
    const token = signSession({ userId: 1, username: 'admin', expiresAt: FUTURE }, SECRET);
    const res = await GET(
      new Request('http://test/api/events', {
        headers: { cookie: `x265b_session=${token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(mockEngineEventsSubscribe).toHaveBeenCalled();
  });

  it('test_when_auth_enabled_and_tampered_cookie_then_401_no_stream', async () => {
    mockGetCachedAuthSetting.mockImplementation((key: string) => {
      if (key === 'auth_enabled') return 'true';
      if (key === 'session_secret') return SECRET;
      return '';
    });
    const res = await GET(
      new Request('http://test/api/events', {
        headers: { cookie: 'x265b_session=tampered.invalid' },
      }),
    );
    expect(res.status).toBe(401);
    expect(mockEngineEventsSubscribe).not.toHaveBeenCalled();
  });
});

describe('GET /api/events — static-analysis grep gate (audit S3)', () => {
  it('test_source_has_requireAuth_before_new_ReadableStream', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'app', 'api', 'events', 'route.ts'),
      'utf8',
    );
    const idxAuth = src.indexOf('requireAuth(');
    const idxStream = src.indexOf('new ReadableStream');
    const idxSubscribe = src.indexOf('engineEvents.subscribe');
    expect(idxAuth).toBeGreaterThanOrEqual(0);
    expect(idxStream).toBeGreaterThanOrEqual(0);
    expect(idxSubscribe).toBeGreaterThanOrEqual(0);
    expect(idxAuth).toBeLessThan(idxStream);
    expect(idxAuth).toBeLessThan(idxSubscribe);
  });
});
