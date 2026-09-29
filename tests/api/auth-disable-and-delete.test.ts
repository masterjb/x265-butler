// 05-02 T2: POST /api/auth/disable-and-delete tests.
// Phase 5 Plan 05-02 — AC-8 + audit M3 + M4.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSetting = {
  store: new Map<string, string>(),
  get(k: string): string | undefined {
    return this.store.get(k);
  },
  set(k: string, v: string): void {
    this.store.set(k, v);
  },
  getAll(): Record<string, string> {
    return Object.fromEntries(this.store);
  },
};

const mocks = vi.hoisted(() => ({
  userCountMock: vi.fn(() => 0),
  userDeleteAllMock: vi.fn(() => 0),
  loggerWarnMock: vi.fn(),
  invalidateMock: vi.fn(),
  clearAllMock: vi.fn(() => 0),
  ensureServerInitMock: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => mockSetting,
  userRepo: () => ({
    count: () => mocks.userCountMock(),
    deleteAll: () => mocks.userDeleteAllMock(),
  }),
  getDb: () => ({
    transaction: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  }),
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: mocks.loggerWarnMock,
      error: vi.fn(),
    }),
  },
}));

vi.mock('@/src/lib/auth/settings-cache', () => ({
  invalidateAuthSettingsCache: mocks.invalidateMock,
  getCachedAuthSetting: (k: string) => mockSetting.get(k) ?? '',
}));

vi.mock('@/src/lib/auth/rate-limit', () => ({
  hashIp: () => 'h',
  extractIp: () => '127.0.0.1',
  clearAll: mocks.clearAllMock,
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mocks.ensureServerInitMock,
}));

vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async (req: Request) => {
    const cookie = req.headers.get('cookie') ?? '';
    if (cookie.includes('x265b_session=valid')) {
      return { ok: true, mode: 'authenticated', username: 'admin' };
    }
    if (mockSetting.get('auth_enabled') !== 'true') {
      return { ok: true, mode: 'disabled', username: null };
    }
    return { ok: false, status: 401, body: { error_code: 'auth_required' } };
  }),
  authGuard: (decision: { ok: boolean; status?: number; body?: unknown }) => {
    if (decision.ok) return null;
    return new Response(JSON.stringify(decision.body), { status: decision.status });
  },
}));

vi.mock('@/src/lib/auth/session', () => ({
  buildClearCookieHeader: () => 'x265b_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
}));

import { POST } from '@/app/api/auth/disable-and-delete/route';

function makeRequest(opts: { contentType?: string; cookie?: string; body?: string } = {}): Request {
  const headers = new Headers();
  if (opts.contentType) headers.set('content-type', opts.contentType);
  if (opts.cookie) headers.set('cookie', opts.cookie);
  return new Request('http://localhost/api/auth/disable-and-delete', {
    method: 'POST',
    headers,
    body: opts.body,
  });
}

describe('POST /api/auth/disable-and-delete', () => {
  beforeEach(() => {
    mockSetting.store.clear();
    mocks.userCountMock.mockReset();
    mocks.userDeleteAllMock.mockReset();
    mocks.loggerWarnMock.mockReset();
    mocks.invalidateMock.mockReset();
    mocks.clearAllMock.mockReset();
    mocks.userCountMock.mockReturnValue(0);
    mocks.userDeleteAllMock.mockReturnValue(0);
  });

  it('audit M4: returns 415 when Content-Type is not application/json (CSRF defense)', async () => {
    const res = await POST(
      makeRequest({
        contentType: 'application/x-www-form-urlencoded',
        cookie: 'x265b_session=valid',
      }),
    );
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error_code).toBe('invalid_content_type');
  });

  it('returns 401 without valid session when auth_enabled=true', async () => {
    mockSetting.set('auth_enabled', 'true');
    const res = await POST(makeRequest({ contentType: 'application/json' }));
    expect(res.status).toBe(401);
  });

  it('audit M3: idempotent userCount=0 path heals inconsistent settings', async () => {
    mocks.userCountMock.mockReturnValue(0);
    mockSetting.set('auth_enabled', 'true');
    mockSetting.set('auth_setup_completed', 'true');
    mockSetting.set('session_secret', 'leftover');
    const res = await POST(
      makeRequest({ contentType: 'application/json', cookie: 'x265b_session=valid' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.already).toBe(true);
    expect(mockSetting.get('auth_enabled')).toBe('false');
    expect(mockSetting.get('auth_setup_completed')).toBe('false');
    expect(mockSetting.get('session_secret')).toBe('');
    expect(mocks.invalidateMock).toHaveBeenCalled();
    expect(mocks.loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'auth_inconsistent_state_healed' }),
      expect.any(String),
    );
  });

  it('userCount>=1 → 204 + full teardown TX + auth_disabled_with_user_delete event', async () => {
    mocks.userCountMock.mockReturnValue(1);
    mocks.userDeleteAllMock.mockReturnValue(1);
    mockSetting.set('auth_enabled', 'true');
    mockSetting.set('auth_setup_completed', 'true');
    mockSetting.set('session_secret', 'real-secret');
    const res = await POST(
      makeRequest({ contentType: 'application/json', cookie: 'x265b_session=valid' }),
    );
    expect(res.status).toBe(204);
    expect(mockSetting.get('auth_enabled')).toBe('false');
    expect(mockSetting.get('auth_setup_completed')).toBe('false');
    expect(mockSetting.get('session_secret')).toBe('');
    expect(mocks.userDeleteAllMock).toHaveBeenCalled();
    expect(mocks.invalidateMock).toHaveBeenCalled();
    expect(mocks.clearAllMock).toHaveBeenCalled();
    expect(mocks.loggerWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'auth_disabled_with_user_delete' }),
      expect.any(String),
    );
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('rejects non-empty body with 400 unexpected_body', async () => {
    mocks.userCountMock.mockReturnValue(1);
    mockSetting.set('auth_enabled', 'true');
    const res = await POST(
      makeRequest({
        contentType: 'application/json',
        cookie: 'x265b_session=valid',
        body: '{"unexpected":"field"}',
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error_code).toBe('unexpected_body');
  });

  it('accepts empty body', async () => {
    mocks.userCountMock.mockReturnValue(0);
    mockSetting.set('auth_enabled', 'false');
    const res = await POST(makeRequest({ contentType: 'application/json' }));
    expect(res.status).toBe(200);
  });
});
