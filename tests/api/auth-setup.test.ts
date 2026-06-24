/*
 * 05-01 Task 2: POST /api/auth/setup.
 * Covers AC-2 + AC-2b + AC-9 (audit M3 setup-race fix).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockSettingGet,
  mockSettingSet,
  mockUserCreate,
  mockUserCount,
  mockEnsureServerInit,
  mockTransactionImpl,
  mockGetDb,
} = vi.hoisted(() => ({
  mockSettingGet: vi.fn(),
  mockSettingSet: vi.fn(),
  mockUserCreate: vi.fn(),
  mockUserCount: vi.fn(),
  mockEnsureServerInit: vi.fn(),
  mockTransactionImpl: vi.fn(),
  mockGetDb: vi.fn(),
}));

// Use a real db.transaction-style wrapper: the inner fn runs synchronously
// and any throw propagates. Tests can override mockTransactionImpl per-case.
mockTransactionImpl.mockImplementation((fn: () => void) => () => fn());

vi.mock('@/src/lib/db', () => ({
  getDb: () => mockGetDb(),
  settingRepo: () => ({ get: mockSettingGet, set: mockSettingSet }),
  userRepo: () => ({ create: mockUserCreate, count: mockUserCount }),
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
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
  default: {},
}));

vi.mock('@/src/lib/auth/settings-cache', () => ({
  invalidateAuthSettingsCache: vi.fn(),
  getCachedAuthSetting: vi.fn(),
}));

import { POST, runtime } from '@/app/api/auth/setup/route';

beforeEach(() => {
  mockSettingGet.mockReset();
  mockSettingSet.mockReset();
  mockUserCreate.mockReset();
  mockUserCount.mockReset();
  mockEnsureServerInit.mockReset();
  mockGetDb.mockReset();
  mockTransactionImpl.mockReset();
  mockTransactionImpl.mockImplementation((fn: () => void) => () => fn());
  mockGetDb.mockReturnValue({ transaction: mockTransactionImpl });
  delete process.env.NEXT_PHASE;
});

function makeReq(body: unknown, contentType = 'application/json'): Request {
  return new Request('http://test/api/auth/setup', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/auth/setup — runtime', () => {
  it('test_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });
});

describe('POST /api/auth/setup — happy path', () => {
  it('test_happy_when_first_setup_then_201_and_no_secret_in_response', async () => {
    mockSettingGet.mockImplementation((key: string) =>
      key === 'auth_setup_completed' ? 'false' : key === 'bcrypt_cost' ? '10' : '',
    );
    mockUserCount.mockReturnValue(0);
    mockUserCreate.mockReturnValue({
      id: 1,
      username: 'admin',
      password_hash: '$2a$10$' + 'x'.repeat(53),
      created_at: 0,
      last_login_at: null,
    });

    const res = await POST(makeReq({ username: 'admin', password: 'p@ssw0rd-12c' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.userId).toBe(1);
    expect(body.username).toBe('admin');
    expect(body.password_hash).toBeUndefined();
    expect(body.session_secret).toBeUndefined();
    expect(body.password_pepper).toBeUndefined();

    // pepper, session_secret, auth_setup_completed all set inside TX.
    const setKeys = mockSettingSet.mock.calls.map((c) => c[0]);
    expect(setKeys).toContain('password_pepper');
    expect(setKeys).toContain('session_secret');
    expect(setKeys).toContain('auth_setup_completed');
  });
});

describe('POST /api/auth/setup — gates', () => {
  it('test_when_wrong_content_type_then_415', async () => {
    const req = new Request('http://test/api/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'whatever',
    });
    const res = await POST(req);
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error_code).toBe('unsupported_media_type');
  });

  it('test_when_body_too_large_then_413', async () => {
    const req = new Request('http://test/api/auth/setup', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(20 * 1024),
      },
      body: '{}',
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect((await res.json()).error_code).toBe('body_too_large');
  });

  it('test_when_invalid_json_then_400', async () => {
    const res = await POST(makeReq('not-json'));
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('invalid_json');
  });

  it('test_when_username_too_short_then_400_username_too_short', async () => {
    const res = await POST(makeReq({ username: 'a', password: 'p@ssw0rd-12c' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('username_too_short');
  });

  it('test_when_username_invalid_chars_then_400_username_invalid_chars', async () => {
    const res = await POST(makeReq({ username: 'admin!', password: 'p@ssw0rd-12c' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('username_invalid_chars');
  });

  it('test_when_password_too_short_then_400_password_too_short', async () => {
    const res = await POST(makeReq({ username: 'admin', password: 'short' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('password_too_short');
  });

  it('test_when_password_all_numeric_then_400_password_too_weak', async () => {
    mockSettingGet.mockReturnValue('false');
    mockUserCount.mockReturnValue(0);
    const res = await POST(makeReq({ username: 'admin', password: '123456789012' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('password_too_weak');
  });

  it('test_when_password_single_class_then_400_password_too_weak', async () => {
    mockSettingGet.mockReturnValue('false');
    mockUserCount.mockReturnValue(0);
    const res = await POST(makeReq({ username: 'admin', password: 'aaaaaaaaaaaa' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('password_too_weak');
  });
});

describe('POST /api/auth/setup — race + idempotency (audit M3)', () => {
  it('test_when_setup_already_completed_setting_then_409', async () => {
    mockSettingGet.mockImplementation((key: string) =>
      key === 'auth_setup_completed' ? 'true' : key === 'bcrypt_cost' ? '10' : '',
    );
    mockUserCount.mockReturnValue(0);
    const res = await POST(makeReq({ username: 'admin', password: 'p@ssw0rd-12c' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error_code).toBe('setup_already_completed');
  });

  it('test_when_user_count_positive_then_409_defense_in_depth', async () => {
    mockSettingGet.mockImplementation((key: string) => (key === 'bcrypt_cost' ? '10' : 'false'));
    mockUserCount.mockReturnValue(1);
    const res = await POST(makeReq({ username: 'admin', password: 'p@ssw0rd-12c' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error_code).toBe('setup_already_completed');
  });

  it('test_when_race_inside_tx_then_409_setup_already_completed', async () => {
    // Setting check passes once optimistically; inside TX the recheck flips to true.
    let calls = 0;
    mockSettingGet.mockImplementation((key: string) => {
      if (key === 'auth_setup_completed') {
        calls++;
        return calls === 1 ? 'false' : 'true';
      }
      if (key === 'bcrypt_cost') return '10';
      return '';
    });
    mockUserCount.mockReturnValue(0);

    const res = await POST(makeReq({ username: 'admin', password: 'p@ssw0rd-12c' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error_code).toBe('setup_already_completed');
  });

  it('test_when_unique_constraint_thrown_then_409', async () => {
    mockSettingGet.mockImplementation((key: string) =>
      key === 'auth_setup_completed' ? 'false' : key === 'bcrypt_cost' ? '10' : '',
    );
    mockUserCount.mockReturnValue(0);
    mockUserCreate.mockImplementation(() => {
      const e = new Error('UNIQUE constraint failed: user.username') as Error & { code: string };
      e.code = 'SQLITE_CONSTRAINT_UNIQUE';
      throw e;
    });

    const res = await POST(makeReq({ username: 'admin', password: 'p@ssw0rd-12c' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error_code).toBe('setup_already_completed');
  });
});
