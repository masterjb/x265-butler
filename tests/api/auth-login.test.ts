/*
 * 05-01 Task 2: POST /api/auth/login.
 * Covers AC-3 happy + AC-4 rate-limit + audit M2 IP + S4 log + S10 timing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockUserFindByUsername,
  mockSetLastLoginAt,
  mockEnsureServerInit,
  mockGetCachedAuthSetting,
  mockLoggerWarn,
  mockLoggerInfo,
} = vi.hoisted(() => ({
  mockUserFindByUsername: vi.fn(),
  mockSetLastLoginAt: vi.fn(),
  mockEnsureServerInit: vi.fn(),
  mockGetCachedAuthSetting: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerInfo: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  userRepo: () => ({
    findByUsername: mockUserFindByUsername,
    setLastLoginAt: mockSetLastLoginAt,
  }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: mockLoggerInfo,
      warn: mockLoggerWarn,
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
  default: {},
}));

vi.mock('@/src/lib/auth/settings-cache', () => ({
  getCachedAuthSetting: mockGetCachedAuthSetting,
}));

import { POST, runtime } from '@/app/api/auth/login/route';
import { hashPassword, BCRYPT_COST_MIN } from '@/src/lib/auth/password';
import { _resetForTesting } from '@/src/lib/auth/rate-limit';

const PEPPER = 'p'.repeat(64);
const SECRET = 'a'.repeat(64);

beforeEach(() => {
  mockUserFindByUsername.mockReset();
  mockSetLastLoginAt.mockReset();
  mockEnsureServerInit.mockReset();
  mockGetCachedAuthSetting.mockReset();
  mockLoggerWarn.mockReset();
  mockLoggerInfo.mockReset();
  _resetForTesting();
  delete process.env.NEXT_PHASE;

  // Default cache values: auth on, default xff false (no XFF parsing).
  mockGetCachedAuthSetting.mockImplementation((key: string) => {
    switch (key) {
      case 'auth_enabled':
        return 'true';
      case 'auth_trust_proxy_xff':
        return 'false';
      case 'password_pepper':
        return PEPPER;
      case 'session_secret':
        return SECRET;
      case 'session_ttl_seconds':
        return '604800';
      default:
        return '';
    }
  });
});

function makeReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://test/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/auth/login — runtime', () => {
  it('test_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });
});

describe('POST /api/auth/login — happy path', () => {
  it('test_when_valid_creds_then_200_with_set_cookie_header', async () => {
    const hash = await hashPassword('p@ssw0rd-12c', PEPPER, BCRYPT_COST_MIN);
    mockUserFindByUsername.mockReturnValue({
      id: 1,
      username: 'admin',
      password_hash: hash,
      created_at: 0,
      last_login_at: null,
    });

    const res = await POST(
      makeReq(
        { username: 'admin', password: 'p@ssw0rd-12c' },
        {
          'x-x265-butler-remote-addr': '127.0.0.1',
        },
      ),
    );
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('x265b_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(mockSetLastLoginAt).toHaveBeenCalledWith(1, expect.any(Number));
  }, 30_000);
});

describe('POST /api/auth/login — failure modes', () => {
  it('test_when_unknown_username_then_401_invalid_credentials', async () => {
    mockUserFindByUsername.mockReturnValue(undefined);
    const res = await POST(
      makeReq(
        { username: 'ghost', password: 'p@ssw0rd-12c' },
        {
          'x-x265-butler-remote-addr': '10.0.0.1',
        },
      ),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error_code).toBe('invalid_credentials');
    // dummy bcrypt branch ran (audit S10) — no Set-Cookie.
    expect(res.headers.get('set-cookie')).toBeNull();
  }, 30_000);

  it('test_when_wrong_password_then_401_invalid_credentials', async () => {
    const hash = await hashPassword('correct-pw-12c', PEPPER, BCRYPT_COST_MIN);
    mockUserFindByUsername.mockReturnValue({
      id: 1,
      username: 'admin',
      password_hash: hash,
      created_at: 0,
      last_login_at: null,
    });

    const res = await POST(
      makeReq(
        { username: 'admin', password: 'wrong-pw-12c' },
        {
          'x-x265-butler-remote-addr': '10.0.0.2',
        },
      ),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error_code).toBe('invalid_credentials');
  }, 30_000);

  it('test_when_wrong_content_type_then_415', async () => {
    const req = new Request('http://test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    const res = await POST(req);
    expect(res.status).toBe(415);
  });

  it('test_when_invalid_json_then_400', async () => {
    const res = await POST(makeReq('not-json', { 'x-x265-butler-remote-addr': '10.0.0.3' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login — rate-limit (audit M1 + S4)', () => {
  it('test_when_6th_attempt_in_window_then_429_with_retry_after', async () => {
    mockUserFindByUsername.mockReturnValue(undefined);

    const ip = '10.0.0.99';
    // Burn 5 failures.
    for (let i = 0; i < 5; i++) {
      const r = await POST(
        makeReq(
          { username: 'admin', password: 'wrong-pw-12c' },
          {
            'x-x265-butler-remote-addr': ip,
          },
        ),
      );
      expect(r.status).toBe(401);
    }
    // 6th attempt → 429.
    const r6 = await POST(
      makeReq(
        { username: 'admin', password: 'wrong-pw-12c' },
        {
          'x-x265-butler-remote-addr': ip,
        },
      ),
    );
    expect(r6.status).toBe(429);
    expect(r6.headers.get('retry-after')).toBeTruthy();
    expect((await r6.json()).error_code).toBe('rate_limit_exceeded');

    // audit S4: rate-limit-hit pino warn fired.
    const rateLimitCalls = mockLoggerWarn.mock.calls.filter((c) => {
      const arg = c[0] as { event?: string } | undefined;
      return arg?.event === 'auth_rate_limit_hit';
    });
    expect(rateLimitCalls.length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe('POST /api/auth/login — IP extraction (audit M2)', () => {
  it('test_when_trustProxyXff_false_then_ignores_xff', async () => {
    mockUserFindByUsername.mockReturnValue(undefined);
    // No remote-addr header → ip='unknown' bucket. After 5 fails → 429 even
    // when XFF rotates — proves XFF NOT used as bucket key.
    for (let i = 0; i < 5; i++) {
      await POST(
        makeReq(
          { username: 'a', password: 'p@ssw0rd-12c' },
          {
            'x-forwarded-for': `203.0.113.${i}`,
          },
        ),
      );
    }
    const r6 = await POST(
      makeReq(
        { username: 'a', password: 'p@ssw0rd-12c' },
        {
          'x-forwarded-for': '203.0.113.100',
        },
      ),
    );
    expect(r6.status).toBe(429);
  }, 60_000);

  it('test_when_trustProxyXff_true_then_xff_separates_buckets', async () => {
    mockGetCachedAuthSetting.mockImplementation((key: string) => {
      if (key === 'auth_trust_proxy_xff') return 'true';
      if (key === 'auth_enabled') return 'true';
      if (key === 'password_pepper') return PEPPER;
      if (key === 'session_secret') return SECRET;
      if (key === 'session_ttl_seconds') return '604800';
      return '';
    });
    mockUserFindByUsername.mockReturnValue(undefined);

    // 5 failures from one XFF — sixth attempt with DIFFERENT XFF → still 401, not 429.
    for (let i = 0; i < 5; i++) {
      await POST(
        makeReq(
          { username: 'a', password: 'p@ssw0rd-12c' },
          {
            'x-forwarded-for': '203.0.113.42',
          },
        ),
      );
    }
    const r6 = await POST(
      makeReq(
        { username: 'a', password: 'p@ssw0rd-12c' },
        {
          'x-forwarded-for': '203.0.113.43',
        },
      ),
    );
    expect(r6.status).toBe(401);
  }, 60_000);
});
