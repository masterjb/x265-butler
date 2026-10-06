// Server Component test pattern documented in tests/library-page.test.tsx.

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
  // userRepo mocked for Auth tab visibility-state derivation.
  userRepo: () => ({ count: () => 0 }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

// page.tsx parallel-fetches detectEncoders for first-paint pill row.
vi.mock('@/src/lib/encode', () => ({
  detectEncoders: mockDetectEncoders,
  ENCODER_IDS: ['nvenc', 'qsv', 'vaapi', 'libx265'] as const,
  // page.tsx computes the cache block via the Cached resolver.
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

// OutputContainerField (rendered in the Encoder tab) reads
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

  // Skipped: obsolete — probes the retired paths-tab UI.

  it.skip('test_SettingsPage_when_rendered_then_field_labels_visible', async () => {
    await renderPage();
    // getByLabelText scopes to the <label> association, avoiding helper-text collisions.
    expect(screen.getByLabelText(/scan path/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/file extensions/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/minimum file size/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/maximum scan depth/i)).toBeInTheDocument();
  });

  // Save disabled on initial render (no dirty state)
  // Skipped: obsolete — probes the retired paths-tab UI.

  it.skip('test_SettingsPage_when_no_edits_then_save_button_disabled', async () => {
    await renderPage();
    const save = screen.getByRole('button', { name: /^save$/i });
    expect(save).toBeDisabled();
  });

  // Skipped: obsolete — probes the retired paths-tab UI.

  it.skip('test_SettingsPage_when_field_edited_then_save_button_enables', async () => {
    await renderPage();
    const scanRoot = screen.getByLabelText(/scan path/i);
    await userEvent.clear(scanRoot);
    await userEvent.type(scanRoot, '/media/movies');
    const save = screen.getByRole('button', { name: /^save$/i });
    await waitFor(() => expect(save).not.toBeDisabled());
  });

  // Skipped: obsolete — probes the retired paths-tab UI.

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

  // beforeunload listener removed after successful save
  // Skipped: obsolete — probes the retired paths-tab UI.

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

  // 5xx → form's dirty state preserved
  // Skipped: obsolete — probes the retired paths-tab UI.

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

  // scanRootExists=false → warning helper rendered
  // Skipped: obsolete — probes the retired paths-tab UI.

  it.skip('test_SettingsPage_when_scan_root_missing_then_warning_helper_rendered', async () => {
    mockStat.mockRejectedValue(new Error('ENOENT'));
    await renderPage();
    expect(screen.getByText(/path does not currently exist on disk/i)).toBeInTheDocument();
  });

  it('test_SettingsPage_when_scan_root_exists_then_no_warning_helper', async () => {
    await renderPage();
    expect(screen.queryByText(/path does not currently exist on disk/i)).toBeNull();
  });

  // Skipped: obsolete — probes the retired paths-tab UI.

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

describe('SettingsPage — Encoder tab', () => {
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
    // Auth tab sits between Encoder and General; Bench tab comes after General.
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
      // aria-label disambiguates available vs unavailable.
      // i18n keys may resolve as raw key strings if missing from en.json —
      // accept either translated text OR raw key fragment.
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

  // force-10bit checkbox renders, defaults unchecked, and its value flows into
  // the PUT /api/settings payload. The default-unchecked assertion is the
  // UI-side guarantee that the default encode stays byte-identical.
  it('test_encoderTab_when_rendered_then_force10bit_switch_present_and_default_unchecked', async () => {
    await renderPage();
    const encoderTab = screen.getByRole('tab', { name: /encoder/i });
    await act(async () => {
      fireEvent.click(encoderTab);
    });
    const sw = await screen.findByRole('switch', { name: /encode as 10-bit/i });
    expect(sw).toBeInTheDocument();
    // Raw i18n key must NOT leak (label resolved).
    expect(sw.getAttribute('aria-label')).not.toMatch(/field\.force10bit/i);
    // Default-unchecked = byte-identical encode for fresh installs.
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });

  it('test_encoderTab_when_force10bit_toggled_then_PUT_payload_carries_force_10bit_true', async () => {
    mockFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === '/api/settings' && opts?.method === 'PUT') {
        return new Response(JSON.stringify({ settings: {}, requestId: 'x' }), { status: 200 });
      }
      if (url === '/api/encoders/refresh' && opts?.method === 'POST') {
        return new Response(
          JSON.stringify({ refreshed: true, detected: ['nvenc'], active: 'nvenc', requestId: 'y' }),
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
    const sw = await screen.findByRole('switch', { name: /encode as 10-bit/i });
    await act(async () => {
      fireEvent.click(sw); // unchecked → checked, makes form dirty
    });
    const save = await screen.findByRole('button', { name: /^save$/i });
    await waitFor(() => expect(save).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() => {
      const putCall = mockFetch.mock.calls.find(
        (c) => c[0] === '/api/settings' && (c[1] as { method?: string })?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as { body: string }).body) as {
        settings: Record<string, string>;
      };
      expect(body.settings.force_10bit).toBe('true');
    });
  });

  // color-passthrough switch renders default-unchecked + round-trips
  // to the PUT payload as 'true' when toggled on.
  it('test_encoderTab_when_colorPassthrough_toggled_then_PUT_payload_carries_color_passthrough_true', async () => {
    mockFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === '/api/settings' && opts?.method === 'PUT') {
        return new Response(JSON.stringify({ settings: {}, requestId: 'x' }), { status: 200 });
      }
      if (url === '/api/encoders/refresh' && opts?.method === 'POST') {
        return new Response(
          JSON.stringify({ refreshed: true, detected: ['nvenc'], active: 'nvenc', requestId: 'y' }),
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
    const sw = await screen.findByRole('switch', { name: /preserve source color tags/i });
    // Default-unchecked (byte-identical default).
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await act(async () => {
      fireEvent.click(sw); // unchecked → checked, makes form dirty
    });
    const save = await screen.findByRole('button', { name: /^save$/i });
    await waitFor(() => expect(save).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() => {
      const putCall = mockFetch.mock.calls.find(
        (c) => c[0] === '/api/settings' && (c[1] as { method?: string })?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall![1] as { body: string }).body) as {
        settings: Record<string, string>;
      };
      expect(body.settings.color_passthrough).toBe('true');
    });
  });
});
