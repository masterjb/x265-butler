/*
 * Plan 20-01 / Phase 20 — server-component page.tsx flag-computation coverage.
 *
 * Covers:
 *  - Test 9 / AC-2: placeholderShare absent → autoSkipPathsStep=false (5-step fallback)
 *  - Test 10 / AC-2: placeholderShare.path is relative → autoSkipPathsStep=false
 *  - Test 10b / AC-2: placeholderShare.path is empty string → autoSkipPathsStep=false
 *  - Test 16 / S1+S10: enriched wizard_entered log carries autoSkipPathsStep + share_id + placeholderSharePath
 *  - Test 16b / S1: separate wizard_auto_skip_paths_step log line NEVER emitted (rejected per audit)
 *  - Test 18 / S5: path='/' edge case → autoSkipPathsStep=true (intentional permissiveness)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ShareRow } from '@/src/lib/db/schema';

const {
  mockSettingGet,
  mockFileCount,
  mockShareListAll,
  mockEnsureServerInit,
  mockLoggerInfo,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockSettingGet: vi.fn<(key: string) => string | undefined>(),
  mockFileCount: vi.fn<() => number>(),
  mockShareListAll: vi.fn<() => ShareRow[]>(),
  mockEnsureServerInit: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({ get: mockSettingGet }),
  fileRepo: () => ({ count: mockFileCount }),
  shareRepo: () => ({ listAll: mockShareListAll }),
  default: {},
}));

vi.mock('@/src/lib/server-init', () => ({
  ensureServerInit: mockEnsureServerInit,
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    info: mockLoggerInfo,
    error: mockLoggerError,
    warn: vi.fn(),
    debug: vi.fn(),
  },
  default: {},
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT: ${url}`);
  },
}));

vi.mock('next-intl/server', () => ({
  setRequestLocale: vi.fn(),
}));

import OnboardingPage from '@/app/[locale]/onboarding/page';

function sampleShare(overrides: Partial<ShareRow> = {}): ShareRow {
  return {
    id: 1,
    name: 'Library',
    path: '/media',
    min_size_mb: 50,
    extensions_csv: 'mp4,mkv',
    max_depth: 12,
    created_at: 1700000000,
    updated_at: 1700000000,
    ...overrides,
  };
}

async function renderPage(): Promise<{ props: Record<string, unknown> } | null> {
  const element = await OnboardingPage({ params: Promise.resolve({ locale: 'en' }) });
  // element is the <PageContainer><OnboardingClient .../></PageContainer> tree.
  const container = element as { props: { children: { props: Record<string, unknown> } } };
  return { props: container.props.children.props };
}

describe('OnboardingPage server-component — 20-01 autoSkipPathsStep flag', () => {
  beforeEach(() => {
    mockSettingGet.mockReset();
    mockFileCount.mockReset();
    mockShareListAll.mockReset();
    mockEnsureServerInit.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerError.mockReset();
    mockSettingGet.mockReturnValue(undefined); // onboarding_completed=false
    mockFileCount.mockReturnValue(0);
  });

  // Test 9 — AC-2: placeholderShare absent → autoSkipPathsStep=false
  it('test_page_when_no_shares_then_autoSkipPathsStep_false_and_log_carries_nulls', async () => {
    mockShareListAll.mockReturnValue([]);
    const rendered = await renderPage();
    expect(rendered!.props.autoSkipPathsStep).toBe(false);
    expect(rendered!.props.placeholderSharePath).toBeNull();
    // Test 16: enriched wizard_entered log line.
    const entered = mockLoggerInfo.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'wizard_entered') as
      | { autoSkipPathsStep: boolean; share_id: number | null; placeholderSharePath: string | null }
      | undefined;
    expect(entered).toBeDefined();
    expect(entered!.autoSkipPathsStep).toBe(false);
    expect(entered!.share_id).toBeNull();
    expect(entered!.placeholderSharePath).toBeNull();
  });

  // Test 10 — AC-2: relative path → autoSkipPathsStep=false
  it('test_page_when_share_path_relative_then_autoSkipPathsStep_false', async () => {
    mockShareListAll.mockReturnValue([sampleShare({ path: 'media' })]);
    const rendered = await renderPage();
    expect(rendered!.props.autoSkipPathsStep).toBe(false);
    expect(rendered!.props.placeholderSharePath).toBeNull();
  });

  // Test 10b — AC-2: empty string path → autoSkipPathsStep=false
  it('test_page_when_share_path_empty_string_then_autoSkipPathsStep_false', async () => {
    mockShareListAll.mockReturnValue([sampleShare({ path: '' })]);
    const rendered = await renderPage();
    expect(rendered!.props.autoSkipPathsStep).toBe(false);
  });

  // Test 16 — S1+S10: enriched wizard_entered log fields when skip-branch ACTIVE.
  it('test_page_when_absolute_path_share_then_wizard_entered_log_carries_full_skip_fields', async () => {
    mockShareListAll.mockReturnValue([
      sampleShare({ id: 7, path: '/media-array', min_size_mb: 100 }),
    ]);
    const rendered = await renderPage();
    expect(rendered!.props.autoSkipPathsStep).toBe(true);
    expect(rendered!.props.placeholderSharePath).toBe('/media-array');
    const entered = mockLoggerInfo.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'wizard_entered') as
      | { autoSkipPathsStep: boolean; share_id: number; placeholderSharePath: string }
      | undefined;
    expect(entered).toBeDefined();
    expect(entered!.autoSkipPathsStep).toBe(true);
    expect(entered!.share_id).toBe(7);
    expect(entered!.placeholderSharePath).toBe('/media-array');
  });

  // Test 16b — S1: rejected separate-log alternative — must NEVER fire.
  it('test_page_when_skip_branch_active_then_no_separate_wizard_auto_skip_paths_step_log', async () => {
    mockShareListAll.mockReturnValue([sampleShare({ path: '/media' })]);
    await renderPage();
    const separateLog = mockLoggerInfo.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'wizard_auto_skip_paths_step');
    expect(separateLog).toBeUndefined();
  });

  // Test 18 — S5: path='/' edge case is intentionally permissive.
  it('test_page_when_path_is_root_slash_then_autoSkipPathsStep_true_log_carries_slash', async () => {
    mockShareListAll.mockReturnValue([sampleShare({ id: 2, path: '/' })]);
    const rendered = await renderPage();
    expect(rendered!.props.autoSkipPathsStep).toBe(true);
    expect(rendered!.props.placeholderSharePath).toBe('/');
    const entered = mockLoggerInfo.mock.calls
      .map((c) => c[0])
      .find((c) => (c as { action?: string }).action === 'wizard_entered') as
      | { placeholderSharePath: string }
      | undefined;
    expect(entered!.placeholderSharePath).toBe('/');
  });
});
