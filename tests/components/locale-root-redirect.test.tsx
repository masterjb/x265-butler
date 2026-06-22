/*
 * 03-05 Plan Task 1 — empty-DB gate Server Component tests.
 * Pattern mirrors tests/library-page.test.tsx Server Component invocation:
 * call the async page function directly with `{ params: Promise.resolve(...) }`
 * and assert the `redirect()` mock is called with the expected URL.
 *
 * audit M3: DB-error fallback
 * audit M7: explicit nodejs runtime
 * audit S6: early-return idiom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockFileCount, mockSettingGet, mockEnsureServerInit, mockLoggerError, mockRedirect } =
  vi.hoisted(() => ({
    mockFileCount: vi.fn<() => number>(),
    mockSettingGet: vi.fn<(key: string) => string | undefined>(),
    mockEnsureServerInit: vi.fn(),
    mockLoggerError: vi.fn(),
    mockRedirect: vi.fn((url: string) => {
      throw new Error(`__REDIRECT__${url}`);
    }),
  }));

vi.mock('@/src/lib/db', () => ({
  fileRepo: () => ({ count: mockFileCount }),
  settingRepo: () => ({ get: mockSettingGet }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    error: mockLoggerError,
    info: vi.fn(),
    warn: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: mockLoggerError }),
  },
  default: {},
}));

vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
}));

import LocaleRoot, { runtime } from '@/app/[locale]/page';

async function invoke(locale = 'en'): Promise<string> {
  try {
    await LocaleRoot({ params: Promise.resolve({ locale }) });
    throw new Error('LocaleRoot did not call redirect()');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const m = msg.match(/^__REDIRECT__(.+)$/);
    if (!m) throw err;
    return m[1];
  }
}

describe('LocaleRoot — empty-DB gate', () => {
  beforeEach(() => {
    mockFileCount.mockReset();
    mockSettingGet.mockReset();
    mockEnsureServerInit.mockReset();
    mockLoggerError.mockReset();
    mockRedirect.mockClear();
  });

  // audit M7: explicit nodejs runtime export.
  it('test_localeRoot_runtime_export_is_nodejs', () => {
    expect(runtime).toBe('nodejs');
  });

  it('test_localeRoot_when_fileCount_zero_and_onboarding_not_done_then_redirects_to_onboarding', async () => {
    mockFileCount.mockReturnValue(0);
    mockSettingGet.mockReturnValue('false');
    const url = await invoke('en');
    expect(url).toBe('/en/onboarding');
  });

  // 05-10 B6: populated-DB happy path lands on /dashboard (was /library).
  it('test_localeRoot_when_fileCount_gt_zero_then_redirects_to_dashboard_NOT_onboarding', async () => {
    mockFileCount.mockReturnValue(42);
    mockSettingGet.mockReturnValue('false');
    const url = await invoke('en');
    expect(url).toBe('/en/dashboard');
  });

  // 05-10 B6: onboarding-done branch goes to /dashboard since DB is healthy.
  it('test_localeRoot_when_onboarding_done_then_redirects_to_dashboard_even_if_fileCount_zero', async () => {
    mockFileCount.mockReturnValue(0);
    mockSettingGet.mockReturnValue('true');
    const url = await invoke('en');
    expect(url).toBe('/en/dashboard');
  });

  it('test_localeRoot_when_de_locale_and_empty_DB_then_redirects_to_de_onboarding', async () => {
    mockFileCount.mockReturnValue(0);
    mockSettingGet.mockReturnValue('false');
    const url = await invoke('de');
    expect(url).toBe('/de/onboarding');
  });

  // audit M3: DB-error safe fallback — fileRepo throws.
  it('test_localeRoot_when_fileRepo_count_throws_then_logs_db_error_and_redirects_to_library', async () => {
    mockFileCount.mockImplementation(() => {
      throw new Error('database is locked');
    });
    mockSettingGet.mockReturnValue('false');
    const url = await invoke('en');
    expect(url).toBe('/en/library');
    const errLog = mockLoggerError.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'onboarding_gate_db_error');
    expect(errLog).toBeDefined();
  });

  // audit M3: DB-error safe fallback — settingRepo throws.
  it('test_localeRoot_when_settingRepo_get_throws_then_logs_db_error_and_redirects_to_library', async () => {
    mockFileCount.mockReturnValue(0);
    mockSettingGet.mockImplementation(() => {
      throw new Error('schema mismatch');
    });
    const url = await invoke('en');
    expect(url).toBe('/en/library');
    const errLog = mockLoggerError.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'onboarding_gate_db_error');
    expect(errLog).toBeDefined();
  });

  // 05-10 audit M2: explicit dbError flag — verify the branch order is
  // (isEmpty → onboarding) > (dbError → library) > (else → dashboard). On a
  // catch path the dashboard branch must NEVER be taken even though isEmpty
  // remains false (the pre-M2 single-flag bug).
  it('test_localeRoot_when_db_error_then_NEVER_redirects_to_dashboard', async () => {
    mockFileCount.mockImplementation(() => {
      throw new Error('database is locked');
    });
    mockSettingGet.mockReturnValue('false');
    const url = await invoke('en');
    expect(url).toBe('/en/library');
    expect(url).not.toBe('/en/dashboard');
    expect(url).not.toBe('/en/onboarding');
  });
});
