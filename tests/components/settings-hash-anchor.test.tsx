/*
 * Plan 20-01 Task 1a-bis (AC-12 / audit S10) — Settings #paths hash-anchor handler.
 *
 * Verifies the additive `#paths` branch alongside the existing 18-01 Task 6
 * `#encoder-config` branch. Defensive against future default-tab reorder.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { ThemeProvider } from '@/components/app-shell/theme-provider';
import en from '@/messages/en.json';

const { mockGetAll, mockDetectEncoders, mockToastSuccess, mockToastError, mockLoggerInfo } =
  vi.hoisted(() => ({
    mockGetAll: vi.fn<() => Record<string, string>>(),
    mockDetectEncoders: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
    mockLoggerInfo: vi.fn(),
  }));

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({ getAll: mockGetAll, get: (k: string) => mockGetAll()?.[k] }),
  userRepo: () => ({ count: () => 0 }),
  shareRepo: () => ({ listAll: () => [] }),
  default: {},
}));

vi.mock('@/src/lib/encode', () => ({
  detectEncoders: mockDetectEncoders,
  ENCODER_IDS: ['nvenc', 'qsv', 'vaapi', 'libx265'] as const,
  default: {},
}));

vi.mock('@/src/lib/api/engine-events-client', () => ({
  useQueueCounts: () => ({ activeJobs: 0, pendingJobs: 0 }),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/en/settings',
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    info: mockLoggerInfo,
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import SettingsPage from '@/app/[locale]/settings/page';

function wrapWithIntl(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
        {ui}
      </ThemeProvider>
    </NextIntlClientProvider>
  );
}

async function renderPageWithHash(hash: string) {
  // Stub the hash BEFORE render so the useEffect on mount sees it.
  Object.defineProperty(window, 'location', {
    value: { ...window.location, hash, pathname: '/en/settings' },
    writable: true,
  });
  // jsdom does not implement Element.scrollIntoView; the 18-01 #encoder-config
  // branch invokes it via rAF. Polyfill to a no-op so the encoder-branch test
  // does not surface a jsdom UnhandledException.
  if (typeof Element.prototype.scrollIntoView !== 'function') {
    Element.prototype.scrollIntoView = function () {};
  }
  mockGetAll.mockReturnValue({});
  mockDetectEncoders.mockResolvedValue({
    detected: ['libx265'],
    activeFromAuto: 'libx265',
    vaapiDevice: undefined,
  });
  const ui = await SettingsPage();
  return render(wrapWithIntl(ui));
}

describe('Settings hash-anchor handler — 20-01 (AC-12 / S10)', () => {
  beforeEach(() => {
    mockGetAll.mockReset();
    mockDetectEncoders.mockReset();
    mockToastSuccess.mockReset();
    mockToastError.mockReset();
    mockLoggerInfo.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('test_settings_when_hash_paths_then_paths_tab_aria_selected_true', async () => {
    await act(async () => {
      await renderPageWithHash('#paths');
    });
    await waitFor(() => {
      const pathsTab = screen.getByRole('tab', { name: /paths/i });
      expect(pathsTab).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('test_settings_when_hash_encoder_config_then_encoder_tab_aria_selected_legacy_preserved', async () => {
    await act(async () => {
      await renderPageWithHash('#encoder-config');
    });
    await waitFor(() => {
      const encoderTab = screen.getByRole('tab', { name: /encoder/i });
      expect(encoderTab).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('test_settings_when_no_hash_then_paths_tab_aria_selected_via_initial_default', async () => {
    await act(async () => {
      await renderPageWithHash('');
    });
    await waitFor(() => {
      const pathsTab = screen.getByRole('tab', { name: /paths/i });
      expect(pathsTab).toHaveAttribute('aria-selected', 'true');
    });
  });

  // 20-02 AC-2 — new #auto-scan-advanced branch
  it('test_settings_when_hash_auto_scan_advanced_then_general_tab_aria_selected_true', async () => {
    await act(async () => {
      await renderPageWithHash('#auto-scan-advanced');
    });
    await waitFor(() => {
      const generalTab = screen.getByRole('tab', { name: /general/i });
      expect(generalTab).toHaveAttribute('aria-selected', 'true');
    });
  });

  // 20-02 AC-2 — requestAnimationFrame scheduled (proxy for scrollIntoView).
  // jsdom can't reliably observe the deferred document.getElementById('auto-scan-advanced')?.scrollIntoView
  // call because TabsContent for 'general' lazy-mounts AFTER setTab + the rAF callback
  // races the React reconciliation. Asserting rAF is scheduled proves the branch
  // fires its scroll-deferral pattern; the inner-callback's scrollIntoView is
  // visually verified via T3g UI checklist + manual UAT.
  it('test_settings_when_hash_auto_scan_advanced_then_request_animation_frame_scheduled', async () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    await act(async () => {
      await renderPageWithHash('#auto-scan-advanced');
    });
    await waitFor(() => {
      expect(rafSpy).toHaveBeenCalled();
    });
    rafSpy.mockRestore();
  });

  // 20-02 audit-SR5 — logger.info audit-trail line emitted on deeplink-engagement
  it('test_settings_when_hash_auto_scan_advanced_then_logger_audit_trail_engaged_event_emitted', async () => {
    await act(async () => {
      await renderPageWithHash('#auto-scan-advanced');
    });
    await waitFor(() => {
      expect(mockLoggerInfo).toHaveBeenCalled();
    });
    const engagedCall = mockLoggerInfo.mock.calls.find((c) => {
      const ctx = c[0] as { event?: string; source?: string } | undefined;
      return ctx?.event === 'onboarding.autoScanHint.engaged' && ctx.source === 'deeplink';
    });
    expect(engagedCall).toBeDefined();
  });
});
