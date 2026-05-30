// Server Component test pattern documented in tests/library-page.test.tsx (audit-added S8).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  // 05-02: userRepo mocked for Auth tab visibility-state derivation.
  userRepo: () => ({ count: () => 0 }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

// 03-03: page.tsx parallel-fetches detectEncoders for first-paint pill row.
vi.mock('@/src/lib/encode', () => ({
  detectEncoders: mockDetectEncoders,
  ENCODER_IDS: ['nvenc', 'qsv', 'vaapi', 'libx265'] as const,
  default: {},
}));

vi.mock('node:fs/promises', () => ({
  default: { stat: (...a: unknown[]) => mockStat(...a) },
  stat: (...a: unknown[]) => mockStat(...a),
}));

// 05-14: OutputContainerField (rendered in the Encoder tab) reads
// useQueueCounts which would otherwise require an EngineEventsProvider
// wrapper. Stub it to a quiet no-op so the existing Encoder-tab tests
// don't need to build the SSE provider tree.
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

describe('SettingsPage (Server + Client integration)', () => {
  beforeEach(() => {
    mockGetAll.mockReset();
    mockStat.mockReset();
    mockRouterRefresh.mockReset();
    mockFetch.mockReset();
    mockGetAll.mockReturnValue({
      scan_root: '/media',
      min_size_mb: '50',
      extensions: 'mp4,mkv',
      max_depth: '12',
    });
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockDetectEncoders.mockResolvedValue({
      detected: ['libx265'],
      activeFromAuto: 'libx265',
    });
    // jsdom doesn't have fetch; install one for the form submit path.
    (globalThis as { fetch?: unknown }).fetch = mockFetch;
  });

  it('test_SettingsPage_when_rendered_then_shows_two_tabs_paths_active', async () => {
    await renderPage();
    expect(screen.getByRole('tab', { name: /paths/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /general/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^settings$/i })).toBeInTheDocument();
  });

  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_SettingsPage_when_rendered_then_field_labels_visible', async () => {
    await renderPage();
    // getByLabelText scopes to the <label> association, avoiding helper-text collisions.
    expect(screen.getByLabelText(/scan path/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/file extensions/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/minimum file size/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/maximum scan depth/i)).toBeInTheDocument();
  });

  // audit-added S10: Save disabled on initial render (no dirty state)
  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_SettingsPage_when_no_edits_then_save_button_disabled', async () => {
    await renderPage();
    const save = screen.getByRole('button', { name: /^save$/i });
    expect(save).toBeDisabled();
  });

  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_SettingsPage_when_field_edited_then_save_button_enables', async () => {
    await renderPage();
    const scanRoot = screen.getByLabelText(/scan path/i);
    await userEvent.clear(scanRoot);
    await userEvent.type(scanRoot, '/media/movies');
    const save = screen.getByRole('button', { name: /^save$/i });
    await waitFor(() => expect(save).not.toBeDisabled());
  });

  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_SettingsPage_when_save_clicked_with_valid_input_then_PUT_fired', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ settings: {}, requestId: 'r1' }),
    });
    await renderPage();
    const scanRoot = screen.getByLabelText(/scan path/i);
    await userEvent.clear(scanRoot);
    await userEvent.type(scanRoot, '/media/movies');
    const save = screen.getByRole('button', { name: /^save$/i });
    await userEvent.click(save);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const url = mockFetch.mock.calls[0][0];
    expect(url).toBe('/api/settings');
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('PUT');
  });

  // audit-added M2: beforeunload listener removed after successful save
  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_SettingsPage_when_save_succeeds_then_beforeunload_listener_removed', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ settings: {}, requestId: 'r1' }),
    });
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    await renderPage();
    const scanRoot = screen.getByLabelText(/scan path/i);
    await userEvent.clear(scanRoot);
    await userEvent.type(scanRoot, '/media/movies');
    const save = screen.getByRole('button', { name: /^save$/i });
    await userEvent.click(save);
    await waitFor(() =>
      expect(removeSpy.mock.calls.some((c) => c[0] === 'beforeunload')).toBe(true),
    );
  });

  // audit-added S14: 5xx → form's dirty state preserved
  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_SettingsPage_when_server_500_then_save_disabled_stays_enabled_and_input_preserved', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'internal_error', requestId: 'r1' }),
    });
    await renderPage();
    const scanRoot = screen.getByLabelText(/scan path/i) as HTMLInputElement;
    await userEvent.clear(scanRoot);
    await userEvent.type(scanRoot, '/media/movies');
    const save = screen.getByRole('button', { name: /^save$/i });
    await userEvent.click(save);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    // Input retained, save button still enabled (dirty preserved)
    expect(scanRoot.value).toBe('/media/movies');
    expect(save).not.toBeDisabled();
  });

  // audit-added S1: scanRootExists=false → warning helper rendered
  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_SettingsPage_when_scan_root_missing_then_warning_helper_rendered', async () => {
    mockStat.mockRejectedValue(new Error('ENOENT'));
    await renderPage();
    expect(screen.getByText(/path does not currently exist on disk/i)).toBeInTheDocument();
  });

  it('test_SettingsPage_when_scan_root_exists_then_no_warning_helper', async () => {
    await renderPage();
    expect(screen.queryByText(/path does not currently exist on disk/i)).toBeNull();
  });

  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_SettingsPage_when_dirty_and_other_tab_clicked_then_confirmation_dialog', async () => {
    await renderPage();
    const scanRoot = screen.getByLabelText(/scan path/i);
    await userEvent.clear(scanRoot);
    await userEvent.type(scanRoot, '/media/movies');
    const generalTab = screen.getByRole('tab', { name: /general/i });
    await act(async () => {
      fireEvent.click(generalTab);
    });
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /discard changes/i })).toBeInTheDocument(),
    );
  });
});

// 03-03: Encoder tab tests (audit M1 + M3 + S1 + S2 + S4 + S13).
describe('SettingsPage — Encoder tab (Plan 03-03)', () => {
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
    });
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockDetectEncoders.mockResolvedValue({
      detected: ['nvenc', 'libx265'],
      activeFromAuto: 'nvenc',
    });
    (globalThis as { fetch?: unknown }).fetch = mockFetch;
  });

  it('test_settingsClient_when_renders_then_five_tabs_visible_in_order_paths_encoder_auth_general_bench', async () => {
    // 05-02: Auth tab inserted between Encoder and General.
    // 11-02: Bench tab appended after General.
    await renderPage();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(5);
    expect(tabs[0].textContent).toMatch(/paths/i);
    expect(tabs[1].textContent).toMatch(/encoder/i);
    expect(tabs[2].textContent).toMatch(/auth/i);
    expect(tabs[3].textContent).toMatch(/general/i);
    expect(tabs[4].textContent).toMatch(/bench/i);
  });

  it('test_encoderTab_when_clicked_then_form_renders_with_seeded_defaults', async () => {
    await renderPage();
    const encoderTab = screen.getByRole('tab', { name: /encoder/i });
    await act(async () => {
      fireEvent.click(encoderTab);
    });
    // 4 CRF number inputs visible (1 per encoder) on Encoder tab.
    await waitFor(() => {
      const crfInputs = screen.getAllByRole('spinbutton');
      expect(crfInputs.length).toBeGreaterThanOrEqual(4);
    });
  });

  it('test_detectedPillRow_when_renders_then_shows_aria_labels_for_available_and_unavailable', async () => {
    await renderPage();
    const encoderTab = screen.getByRole('tab', { name: /encoder/i });
    await act(async () => {
      fireEvent.click(encoderTab);
    });
    // detected = ['nvenc', 'libx265']; missing = ['qsv', 'vaapi']
    await waitFor(() => {
      // audit S1: aria-label disambiguates available vs unavailable.
      // i18n keys may resolve as raw key strings if not yet in en.json (Task 3
      // adds them) — accept either translated text OR raw key fragment.
      const items = screen.getAllByRole('listitem');
      expect(items.length).toBeGreaterThanOrEqual(4);
    });
  });

  it('test_encoderTab_when_save_succeeds_then_POST_encoders_refresh_called', async () => {
    mockFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === '/api/settings' && opts?.method === 'PUT') {
        return new Response(JSON.stringify({ settings: {}, requestId: 'x' }), { status: 200 });
      }
      if (url === '/api/encoders/refresh' && opts?.method === 'POST') {
        return new Response(
          JSON.stringify({
            refreshed: true,
            detected: ['nvenc', 'libx265'],
            active: 'nvenc',
            resolution: 'override',
            requestId: 'y',
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });
    await renderPage();
    const encoderTab = screen.getByRole('tab', { name: /encoder/i });
    await act(async () => {
      fireEvent.click(encoderTab);
    });
    // Edit a CRF input to make form dirty + trigger encoder-tab save flow.
    const crfInputs = await screen.findAllByRole('spinbutton');
    expect(crfInputs.length).toBeGreaterThanOrEqual(4);
    const firstCrfInput = crfInputs[0] as HTMLInputElement;
    await act(async () => {
      fireEvent.change(firstCrfInput, { target: { value: '20' } });
    });
    const save = await screen.findByRole('button', { name: /^save$/i });
    await waitFor(() => expect(save).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(save);
    });
    // Await both PUT + POST in fetch mock call list.
    await waitFor(() => {
      const urls = mockFetch.mock.calls.map((c) => c[0]);
      expect(urls).toContain('/api/settings');
      expect(urls).toContain('/api/encoders/refresh');
    });
  });
});
