// @vitest-environment node
// Phase 21 Plan 21-03 T3 — /[locale]/not-found Server Component tests.
// AC-1, AC-2, AC-3, AC-4, AC-9.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockHeaders, mockLogger, mockSettingsGet, settingState } = vi.hoisted(() => ({
  mockHeaders: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockSettingsGet: vi.fn(),
  settingState: { onboarding: 'true' as 'true' | 'false' | undefined, throwOnRead: false },
}));

vi.mock('next/headers', () => ({
  headers: mockHeaders,
}));

vi.mock('@/src/lib/logger', () => ({
  logger: mockLogger,
}));

vi.mock('next-intl/server', () => ({
  getLocale: vi.fn(async () => 'en'),
  getTranslations: vi.fn(async () => (key: string, params?: Record<string, unknown>) => {
    if (params) {
      return Object.entries(params).reduce(
        (acc, [k, v]) => acc.replace(`{${k}}`, String(v)),
        `t:${key}`,
      );
    }
    return `t:${key}`;
  }),
}));

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({
    get: mockSettingsGet,
    set: vi.fn(),
    delete: vi.fn(),
    getAll: vi.fn(() => ({})),
  }),
}));

import NotFound from '@/app/[locale]/not-found';

function setHeaders(pathname: string) {
  mockHeaders.mockResolvedValue({
    get: (name: string) => (name === 'x-pathname' ? pathname : null),
  } as unknown as Headers);
}

describe('NotFound Server Component', () => {
  beforeEach(() => {
    mockLogger.info.mockReset();
    mockSettingsGet.mockReset();
    settingState.onboarding = 'true';
    settingState.throwOnRead = false;
    mockSettingsGet.mockImplementation((key: string) => {
      if (settingState.throwOnRead) throw new Error('db unavailable');
      if (key === 'onboarding_completed') return settingState.onboarding;
      return undefined;
    });
  });

  it('emits notFoundEncountered with source + kind + locale + onboarding flag', async () => {
    setHeaders('/en/foo');
    await NotFound();
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.event).toBe('notFoundEncountered');
    expect(call.source).toBe('not-found-server-component');
    expect(call.kind).toBe('route-unknown');
    expect(call.locale).toBe('en');
    expect(call.pathname).toBe('/en/foo');
    expect(call.onboardingIncomplete).toBe(false);
  });

  it('locale-unknown when /fr/library is hit', async () => {
    setHeaders('/fr/library');
    await NotFound();
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.kind).toBe('locale-unknown');
  });

  it('locale-missing when /library is hit (no locale prefix)', async () => {
    setHeaders('/library');
    await NotFound();
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.kind).toBe('locale-missing');
  });

  it('onboardingIncomplete=true when setting=false', async () => {
    settingState.onboarding = 'false';
    setHeaders('/en/foo');
    await NotFound();
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.onboardingIncomplete).toBe(true);
  });

  it('silent fallback when settingRepo throws (onboardingIncomplete=false)', async () => {
    settingState.throwOnRead = true;
    setHeaders('/en/foo');
    await NotFound();
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.onboardingIncomplete).toBe(false);
  });

  it('classifies fallback when locale + route are both known', async () => {
    setHeaders('/en/library');
    await NotFound();
    const call = mockLogger.info.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.kind).toBe('fallback');
  });
});
