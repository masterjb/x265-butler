/*
 * 05-01 Task 2: GET /api/auth/status.
 * Covers AC-5 — always 200; never Set-Cookie; never DB write.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockEnsureServerInit, mockGetCachedAuthSetting } = vi.hoisted(() => ({
  mockEnsureServerInit: vi.fn(),
  mockGetCachedAuthSetting: vi.fn(),
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
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
}));

import { GET, runtime } from '@/app/api/auth/status/route';
import { signSession } from '@/src/lib/auth/session';

const SECRET = 'a'.repeat(64);
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

beforeEach(() => {
  mockEnsureServerInit.mockReset();
  mockGetCachedAuthSetting.mockReset();
  delete process.env.NEXT_PHASE;
});

describe('GET /api/auth/status', () => {
  it('test_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_when_auth_disabled_then_authenticated_false', async () => {
    mockGetCachedAuthSetting.mockImplementation((key: string) => {
      if (key === 'auth_enabled') return 'false';
      if (key === 'auth_setup_completed') return 'false';
      return '';
    });
    const res = await GET(new Request('http://test/api/auth/status'));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    const body = await res.json();
    expect(body.authEnabled).toBe(false);
    expect(body.setupCompleted).toBe(false);
    expect(body.authenticated).toBe(false);
    expect(body.username).toBeNull();
  });

  it('test_when_auth_enabled_no_cookie_then_authenticated_false', async () => {
    mockGetCachedAuthSetting.mockImplementation((key: string) => {
      if (key === 'auth_enabled') return 'true';
      if (key === 'auth_setup_completed') return 'true';
      if (key === 'session_secret') return SECRET;
      return '';
    });
    const res = await GET(new Request('http://test/api/auth/status'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authEnabled).toBe(true);
    expect(body.setupCompleted).toBe(true);
    expect(body.authenticated).toBe(false);
  });

  it('test_when_valid_cookie_then_authenticated_true_with_username', async () => {
    mockGetCachedAuthSetting.mockImplementation((key: string) => {
      if (key === 'auth_enabled') return 'true';
      if (key === 'auth_setup_completed') return 'true';
      if (key === 'session_secret') return SECRET;
      return '';
    });
    const token = signSession({ userId: 1, username: 'admin', expiresAt: FUTURE }, SECRET);
    const res = await GET(
      new Request('http://test/api/auth/status', {
        headers: { cookie: `x265b_session=${token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.username).toBe('admin');
  });

  it('test_when_tampered_cookie_then_authenticated_false_no_4xx', async () => {
    mockGetCachedAuthSetting.mockImplementation((key: string) => {
      if (key === 'auth_enabled') return 'true';
      if (key === 'auth_setup_completed') return 'true';
      if (key === 'session_secret') return SECRET;
      return '';
    });
    const res = await GET(
      new Request('http://test/api/auth/status', {
        headers: { cookie: 'x265b_session=tampered.invalid' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(false);
    expect(body.username).toBeNull();
  });
});
