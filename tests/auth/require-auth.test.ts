/*
 * 05-01 Task 3: src/lib/auth/require-auth.ts.
 * Covers AC-1 (zero-regression off-by-default), AC-7 (tampered cookie),
 * AC-8 (rolling renewal).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockGetCachedAuthSetting } = vi.hoisted(() => ({
  mockGetCachedAuthSetting: vi.fn(),
}));

vi.mock('@/src/lib/auth/settings-cache', () => ({
  getCachedAuthSetting: mockGetCachedAuthSetting,
  invalidateAuthSettingsCache: vi.fn(),
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  default: {},
}));

import { authGuard, requireAuth, withRenewCookie } from '@/src/lib/auth/require-auth';
import { signSession } from '@/src/lib/auth/session';

const SECRET = 'a'.repeat(64);
const TTL = 604_800;

beforeEach(() => {
  mockGetCachedAuthSetting.mockReset();
});

describe('requireAuth — AC-1 zero-regression off-by-default', () => {
  it('test_when_auth_disabled_then_passes_with_mode_disabled', async () => {
    mockGetCachedAuthSetting.mockReturnValue('false');
    const req = new Request('http://test/api/library');
    const decision = await requireAuth(req);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.mode).toBe('disabled');
      expect(decision.username).toBeNull();
    }
  });

  it('test_when_auth_disabled_then_authGuard_returns_null', async () => {
    mockGetCachedAuthSetting.mockReturnValue('false');
    const decision = await requireAuth(new Request('http://test/api/library'));
    expect(authGuard(decision)).toBeNull();
  });
});

describe('requireAuth — auth_enabled=true paths', () => {
  it('test_when_no_cookie_then_401_auth_required', async () => {
    mockGetCachedAuthSetting.mockImplementation((key: string) => {
      if (key === 'auth_enabled') return 'true';
      if (key === 'session_secret') return SECRET;
      return '';
    });
    const decision = await requireAuth(new Request('http://test/api/library'));
    expect(decision.ok).toBe(false);
    const denied = authGuard(decision);
    expect(denied).not.toBeNull();
    expect(denied!.status).toBe(401);
    expect(await denied!.json()).toEqual({ error_code: 'auth_required' });
  });

  it('test_when_session_secret_empty_then_401_auth_required', async () => {
    mockGetCachedAuthSetting.mockImplementation((key: string) => {
      if (key === 'auth_enabled') return 'true';
      if (key === 'session_secret') return '';
      return '';
    });
    const token = signSession(
      { userId: 1, username: 'admin', expiresAt: Math.floor(Date.now() / 1000) + 3600 },
      SECRET,
    );
    const decision = await requireAuth(
      new Request('http://test/api/library', {
        headers: { cookie: `x265b_session=${token}` },
      }),
    );
    expect(decision.ok).toBe(false);
  });

  it('test_when_bad_format_cookie_then_401_auth_required', async () => {
    mockGetCachedAuthSetting.mockImplementation((key: string) => {
      if (key === 'auth_enabled') return 'true';
      if (key === 'session_secret') return SECRET;
      return '';
    });
    const decision = await requireAuth(
      new Request('http://test/api/library', {
        headers: { cookie: 'x265b_session=garbage' },
      }),
    );
    expect(decision.ok).toBe(false);
  });

  it('test_when_tampered_signature_then_401_auth_required', async () => {
    mockGetCachedAuthSetting.mockImplementation((key: string) => {
      if (key === 'auth_enabled') return 'true';
      if (key === 'session_secret') return SECRET;
      return '';
    });
    const token = signSession(
      { userId: 1, username: 'admin', expiresAt: Math.floor(Date.now() / 1000) + 3600 },
      SECRET,
    );
    const [p, sig] = token.split('.');
    // Tamper at position 0 — base64url's *last* char only carries 4
    // meaningful bits (SHA-256 = 32 bytes = 43 base64url chars, with 2 spare
    // bits in the trailing char). A↔B flip in those spare bits decodes to
    // an identical Buffer, so timingSafeEqual still returns true. Position 0
    // is always semantically meaningful.
    const firstChar = sig[0];
    const tampered = `${p}.${firstChar === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
    const decision = await requireAuth(
      new Request('http://test/api/library', {
        headers: { cookie: `x265b_session=${tampered}` },
      }),
    );
    expect(decision.ok).toBe(false);
  });

  it('test_when_expired_cookie_then_401_auth_required', async () => {
    mockGetCachedAuthSetting.mockImplementation((key: string) => {
      if (key === 'auth_enabled') return 'true';
      if (key === 'session_secret') return SECRET;
      return '';
    });
    const token = signSession({ userId: 1, username: 'admin', expiresAt: 1 }, SECRET);
    const decision = await requireAuth(
      new Request('http://test/api/library', {
        headers: { cookie: `x265b_session=${token}` },
      }),
    );
    expect(decision.ok).toBe(false);
  });

  it('test_when_valid_cookie_then_passes_with_username', async () => {
    mockGetCachedAuthSetting.mockImplementation((key: string) => {
      if (key === 'auth_enabled') return 'true';
      if (key === 'session_secret') return SECRET;
      if (key === 'session_ttl_seconds') return String(TTL);
      return '';
    });
    const future = Math.floor(Date.now() / 1000) + TTL;
    const token = signSession({ userId: 1, username: 'admin', expiresAt: future }, SECRET);
    const decision = await requireAuth(
      new Request('http://test/api/library', {
        headers: { cookie: `x265b_session=${token}` },
      }),
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.mode).toBe('authenticated');
      expect(decision.username).toBe('admin');
      // Just-issued cookie has full TTL — no renewal.
      expect(decision.renewCookie).toBeUndefined();
    }
  });
});

describe('requireAuth — AC-8 rolling renewal', () => {
  it('test_when_remaining_ttl_under_half_then_renewCookie_attached', async () => {
    mockGetCachedAuthSetting.mockImplementation((key: string) => {
      if (key === 'auth_enabled') return 'true';
      if (key === 'session_secret') return SECRET;
      if (key === 'session_ttl_seconds') return String(TTL);
      return '';
    });
    // Remaining TTL = 25% of full → triggers renewal.
    const expiresAt = Math.floor(Date.now() / 1000) + Math.floor(TTL * 0.25);
    const token = signSession({ userId: 1, username: 'admin', expiresAt }, SECRET);
    const decision = await requireAuth(
      new Request('http://test/api/library', {
        headers: { cookie: `x265b_session=${token}` },
      }),
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.renewCookie).toBeTruthy();
      expect(decision.renewCookie).toContain('x265b_session=');
      expect(decision.renewCookie).toContain('HttpOnly');
    }
  });
});

describe('withRenewCookie', () => {
  it('test_when_renew_present_then_set_cookie_appended', () => {
    const res = new Response(null, { status: 200 });
    const decision = {
      ok: true as const,
      mode: 'authenticated' as const,
      username: 'admin',
      renewCookie: 'x265b_session=new.token; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800',
    };
    const out = withRenewCookie(res, decision);
    expect(out.headers.get('set-cookie')).toContain('x265b_session=new.token');
  });

  it('test_when_disabled_mode_then_no_set_cookie', () => {
    const res = new Response(null, { status: 200 });
    const decision = { ok: true as const, mode: 'disabled' as const, username: null };
    expect(withRenewCookie(res, decision).headers.get('set-cookie')).toBeNull();
  });
});
