/*
 * 05-01 Task 2: POST /api/auth/logout. Idempotent — always 204 + clear cookie.
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

import { POST, runtime } from '@/app/api/auth/logout/route';

beforeEach(() => {
  mockEnsureServerInit.mockReset();
  mockGetCachedAuthSetting.mockReset();
  mockGetCachedAuthSetting.mockReturnValue('');
  delete process.env.NEXT_PHASE;
});

describe('POST /api/auth/logout', () => {
  it('test_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_when_no_cookie_then_204_with_clear_cookie_header', async () => {
    const res = await POST(new Request('http://test/api/auth/logout', { method: 'POST' }));
    expect(res.status).toBe(204);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('x265b_session=');
    expect(setCookie).toContain('Max-Age=0');
  });

  it('test_when_invalid_cookie_then_204_idempotent', async () => {
    const res = await POST(
      new Request('http://test/api/auth/logout', {
        method: 'POST',
        headers: { cookie: 'x265b_session=invalid.token' },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('test_when_body_too_large_then_413', async () => {
    const res = await POST(
      new Request('http://test/api/auth/logout', {
        method: 'POST',
        headers: { 'content-length': String(20 * 1024) },
      }),
    );
    expect(res.status).toBe(413);
  });
});
