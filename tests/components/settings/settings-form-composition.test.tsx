// 28-10 (AC-7): structural composition pin for the settings-form.tsx L2 split.
//
// The split moved 4 inline Cards + 4 field-components into their own sibling
// files, re-threading ~10+ closure locals DOWN as props per card. tsc catches a
// MISSING prop but NOT a semantically-wrong one (e.g. pickerMode vs
// pickerModeSource — same type). The existing render-parity sentinel
// (tests/settings-page.test.tsx) only exercises the ENCODER tab's CRF
// spinbuttons + detected pills — min-savings, the composed
// output-container/sidecar/output-mode wrappers, and the whole general-tab
// Preferences card got ZERO behavioral assertion. This test pins ONE signature
// interactive node per extracted card across BOTH tabs, so a card that drops or
// mis-threads a prop (renders empty/broken) fails RED, not merely "present".
//
// Coverage map (card → who asserts its signature node):
//   EncoderConfigCard  → settings-page.test (detected pills) + HERE (#encoder-config + Encoder label)
//   CrfCard            → settings-page.test (≥4 spinbuttons)   + HERE
//   OutputContainerField (composed) → UNCOVERED before → HERE (#output_container)
//   SidecarModeField    (composed) → UNCOVERED before → HERE (#sidecar_mode)
//   OutputModeField     (composed) → UNCOVERED before → HERE (#output_mode)
//   MinSavingsCard                 → UNCOVERED before → HERE (role=slider)
//   PreferencesCard (general tab)  → UNCOVERED before → HERE (Language/Theme/Output-suffix labels)
//
// NOTE: AC-7 text named "sidecar radiogroup / output-mode radiogroup", but the
// real implementation renders each as a shadcn <Select> (an id'd SelectTrigger),
// NOT a radiogroup — so the signature node pinned here is the id'd trigger
// (#sidecar_mode / #output_mode), the actual DOM. Presence-based, NO snapshot.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { ThemeProvider } from '@/components/app-shell/theme-provider';
import en from '@/messages/en.json';

const { mockGetAll, mockStat, mockRouterRefresh, mockFetch, mockDetectEncoders } = vi.hoisted(
  () => ({
    mockGetAll: vi.fn<() => Record<string, string>>(),
    mockStat: vi.fn(),
    mockRouterRefresh: vi.fn(),
    mockFetch: vi.fn(),
    mockDetectEncoders: vi.fn(),
  }),
);

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({ getAll: mockGetAll, get: (k: string) => mockGetAll()?.[k] }),
  userRepo: () => ({ count: () => 0 }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/encode', () => ({
  detectEncoders: mockDetectEncoders,
  ENCODER_IDS: ['nvenc', 'qsv', 'vaapi', 'libx265'] as const,
  resolveEffectiveCachePathCached: () => ({
    effectivePath: '/config/cache',
    resolution: 'config-fallback',
  }),
  default: {},
}));

vi.mock('node:fs/promises', () => ({
  default: { stat: (...a: unknown[]) => mockStat(...a) },
  stat: (...a: unknown[]) => mockStat(...a),
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
    refresh: mockRouterRefresh,
  }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
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

async function renderPage() {
  const ui = await SettingsPage();
  return render(wrapWithIntl(ui));
}

describe('SettingsForm composition pin (28-10 L2 split, AC-7)', () => {
  beforeEach(() => {
    mockGetAll.mockReset();
    mockStat.mockReset();
    mockRouterRefresh.mockReset();
    mockFetch.mockReset();
    mockDetectEncoders.mockReset();
    mockGetAll.mockReturnValue({
      scan_root: '/media',
      cache_pool_path: '/mnt/cache/x265-butler',
      min_size_mb: '50',
      extensions: 'mp4,mkv',
      max_depth: '12',
      encoder: 'auto',
      concurrency: 'auto',
      crf_libx265: '23',
      crf_nvenc: '23',
      crf_qsv: '22',
      crf_vaapi: '22',
      min_savings_percent: '5',
      output_container: 'mkv',
      output_mode: 'suffix',
      sidecar_mode: 'beside',
      output_suffix: '-x265',
    });
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockDetectEncoders.mockResolvedValue({
      detected: ['nvenc', 'libx265'],
      activeFromAuto: 'nvenc',
    });
    (globalThis as { fetch?: unknown }).fetch = mockFetch;
  });

  it('test_settingsForm_when_split_then_every_card_threads_its_signature_node', async () => {
    const { container } = await renderPage();

    // ── Encoder tab: 6 cards (encoder-config, CRF, output-container, sidecar,
    //    output-mode, min-savings) ───────────────────────────────────────────
    const encoderTab = screen.getByRole('tab', { name: /encoder/i });
    await act(async () => {
      fireEvent.click(encoderTab);
    });

    // EncoderConfigCard — deeplink anchor Card + its Encoder Select label +
    // the Detected pill row (detection prop threaded down).
    const encoderCard = container.querySelector('#encoder-config');
    expect(encoderCard).not.toBeNull();
    expect(within(encoderCard as HTMLElement).getByText('Encoder')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(4);

    // CrfCard — ≥4 CRF spinbuttons (form/control threaded).
    expect(screen.getAllByRole('spinbutton').length).toBeGreaterThanOrEqual(4);

    // OutputContainerField (composed via the orchestrator wrapper Card).
    expect(container.querySelector('#output_container')).not.toBeNull();

    // SidecarModeField (composed).
    expect(container.querySelector('#sidecar_mode')).not.toBeNull();

    // OutputModeField (composed).
    expect(container.querySelector('#output_mode')).not.toBeNull();

    // MinSavingsCard — the Slider (min_savings_percent threaded).
    expect(screen.getAllByRole('slider').length).toBeGreaterThanOrEqual(1);

    // ── General tab: PreferencesCard (language + theme selects + the
    //    composed OutputSuffixField) ─────────────────────────────────────────
    const generalTab = screen.getByRole('tab', { name: /general/i });
    await act(async () => {
      fireEvent.click(generalTab);
    });

    expect(screen.getByText('Language')).toBeInTheDocument();
    expect(screen.getByText('Theme')).toBeInTheDocument();
    expect(screen.getByText('Output filename suffix')).toBeInTheDocument();
  });
});
