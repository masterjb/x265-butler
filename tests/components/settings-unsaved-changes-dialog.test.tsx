// 05-19: Settings unsaved-changes AlertDialog 3-button save-and-switch flow.
// Tests cover AC-1..AC-7 of plan 05-19 (Settings AlertDialog upgrade).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { ThemeProvider } from '@/components/app-shell/theme-provider';
import en from '@/messages/en.json';
import de from '@/messages/de.json';

const {
  mockGetAll,
  mockStat,
  mockRouterRefresh,
  mockFetch,
  mockDetectEncoders,
  mockToastError,
  mockToastSuccess,
} = vi.hoisted(() => ({
  mockGetAll: vi.fn<() => Record<string, string>>(),
  mockStat: vi.fn(),
  mockRouterRefresh: vi.fn(),
  mockFetch: vi.fn(),
  mockDetectEncoders: vi.fn(),
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({ getAll: mockGetAll, get: (k: string) => mockGetAll()?.[k] }),
  userRepo: () => ({ count: () => 0 }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/encode', () => ({
  detectEncoders: mockDetectEncoders,
  ENCODER_IDS: ['nvenc', 'qsv', 'vaapi', 'libx265'] as const,
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

vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

// 12-05 T3 AC-12 (cascade): BenchSettingsTab — reachable via the cascading
// import chain from SettingsClient — pulls in @/src/lib/logger, which in
// production wires pino + ring-buffer. Mock the surface so jsdom doesn't
// trip over the server-only ring-buffer module.
vi.mock('@/src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
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

async function renderPage() {
  const ui = await SettingsPage();
  return render(wrapWithIntl(ui));
}

// Helper — dirty paths form via scan_root edit, click encoder tab → AlertDialog opens.
async function dirtyAndOpenDialog() {
  await renderPage();
  const scanRoot = screen.getByLabelText(/scan path/i) as HTMLInputElement;
  await userEvent.clear(scanRoot);
  await userEvent.type(scanRoot, '/media/movies');
  const encoderTab = screen.getByRole('tab', { name: /encoder/i });
  await act(async () => {
    fireEvent.click(encoderTab);
  });
  await waitFor(() => {
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
}

describe('Settings unsaved-changes AlertDialog (Plan 05-19)', () => {
  beforeEach(() => {
    mockGetAll.mockReset();
    mockStat.mockReset();
    mockRouterRefresh.mockReset();
    mockFetch.mockReset();
    mockDetectEncoders.mockReset();
    mockToastError.mockReset();
    mockToastSuccess.mockReset();
    mockGetAll.mockReturnValue({
      scan_root: '/media',
      cache_pool_path: '/mnt/cache/x265-butler',
      min_size_mb: '50',
      extensions: 'mp4,mkv',
      max_depth: '12',
    });
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockDetectEncoders.mockResolvedValue({
      detected: ['libx265'],
      activeFromAuto: 'libx265',
    });
    (globalThis as { fetch?: unknown }).fetch = mockFetch;
  });

  // AC-1
  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_when_dialog_opens_then_three_buttons_visible_with_correct_labels', async () => {
    await dirtyAndOpenDialog();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: en.settings.unsavedChanges.action.cancel }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: en.settings.unsavedChanges.action.discard }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: en.settings.unsavedChanges.action.save }),
    ).toBeInTheDocument();
  });

  // AC-2
  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_when_save_clicked_and_fetch_ok_then_tab_switches_and_dialog_closes', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ settings: {}, requestId: 'r1' }),
    });
    await dirtyAndOpenDialog();
    const saveBtn = screen.getByRole('button', {
      name: en.settings.unsavedChanges.action.save,
    });
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(mockFetch).toHaveBeenCalled();
  });

  // AC-3a — client zod validation rejects pre-fetch
  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_when_save_clicked_and_client_validation_fails_then_dialog_stays_open_with_alert_banner', async () => {
    await dirtyAndOpenDialog();
    // Cancel + edit min_size_mb to invalid (-1) + reopen dialog.
    const cancelBtn = screen.getByRole('button', {
      name: en.settings.unsavedChanges.action.cancel,
    });
    await act(async () => {
      fireEvent.click(cancelBtn);
    });
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    const minSize = screen.getByLabelText(/minimum file size/i) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(minSize, { target: { value: '-1' } });
    });
    const encoderTab = screen.getByRole('tab', { name: /encoder/i });
    await act(async () => {
      fireEvent.click(encoderTab);
    });
    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });
    const saveBtn = screen.getByRole('button', {
      name: en.settings.unsavedChanges.action.save,
    });
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        en.settings.unsavedChanges.error.validation,
      );
    });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    // Client-validation rejects pre-fetch — fetch never fires.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // AC-3b — server 400 response → reason='validation' clamped from 400 path
  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_when_save_clicked_and_server_400_then_dialog_stays_open_with_alert_banner_and_setFocus', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: () =>
        Promise.resolve({
          details: [{ path: ['settings', 'scan_root'], message: 'invalid' }],
        }),
    });
    await dirtyAndOpenDialog();
    const saveBtn = screen.getByRole('button', {
      name: en.settings.unsavedChanges.action.save,
    });
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        en.settings.unsavedChanges.error.validation,
      );
    });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalled();
  });

  // AC-4 — 5xx → toast.error fired, dialog stays open
  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_when_save_clicked_and_fetch_5xx_then_dialog_stays_open_with_toast', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'internal_error' }),
    });
    await dirtyAndOpenDialog();
    const saveBtn = screen.getByRole('button', {
      name: en.settings.unsavedChanges.action.save,
    });
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
    });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  // AC-5 + S2 — Save/Discard disabled, Cancel enabled during in-flight
  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_when_save_in_flight_then_save_and_discard_disabled_cancel_enabled', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    mockFetch.mockReturnValue(fetchPromise);
    await dirtyAndOpenDialog();
    const saveBtn = screen.getByRole('button', {
      name: en.settings.unsavedChanges.action.save,
    });
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await waitFor(() => {
      expect(saveBtn).toBeDisabled();
    });
    const discardBtn = screen.getByRole('button', {
      name: en.settings.unsavedChanges.action.discard,
    });
    expect(discardBtn).toBeDisabled();
    const cancelBtn = screen.getByRole('button', {
      name: en.settings.unsavedChanges.action.cancel,
    });
    expect(cancelBtn).not.toBeDisabled();
    // Resolve to clean up the pending Promise.
    await act(async () => {
      resolveFetch({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ settings: {}, requestId: 'r1' }),
      });
    });
  });

  // AC-6 + S8 — initial focus lands on Cancel
  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_when_dialog_opens_then_initial_focus_lands_on_cancel_button', async () => {
    await dirtyAndOpenDialog();
    const cancelBtn = screen.getByRole('button', {
      name: en.settings.unsavedChanges.action.cancel,
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(cancelBtn);
    });
  });

  // AC-6 + M1 — Escape closes dialog via Cancel handler
  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_when_escape_pressed_then_cancel_handler_fires_and_dialog_closes', async () => {
    await dirtyAndOpenDialog();
    await act(async () => {
      fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    });
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    // Active tab unchanged (still on paths) + edit preserved.
    const pathsTab = screen.getByRole('tab', { name: /paths/i });
    expect(pathsTab.getAttribute('aria-selected')).toBe('true');
    const scanRoot = screen.getByLabelText(/scan path/i) as HTMLInputElement;
    expect(scanRoot.value).toBe('/media/movies');
  });

  // AC-6 — banner has role="alert" + aria-live="assertive"
  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_when_validation_error_then_inline_banner_has_role_alert_and_aria_live_assertive', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ details: [] }),
    });
    await dirtyAndOpenDialog();
    const saveBtn = screen.getByRole('button', {
      name: en.settings.unsavedChanges.action.save,
    });
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.getAttribute('aria-live')).toBe('assertive');
    });
  });

  // S5 mandatory — legacy keys removed from BOTH locales
  it('test_when_legacy_discardCta_keepCta_keys_referenced_then_no_call_sites', () => {
    const enStr = JSON.stringify(en.settings.unsavedChanges);
    const deStr = JSON.stringify(de.settings.unsavedChanges);
    expect(enStr.includes('discardCta')).toBe(false);
    expect(enStr.includes('keepCta')).toBe(false);
    expect(deStr.includes('discardCta')).toBe(false);
    expect(deStr.includes('keepCta')).toBe(false);
  });

  // S1 — single-formRef relies on Tabs.Panel keepMounted=false default
  // (only ONE SettingsForm mounted at a time). If a future maintainer flips
  // keepMounted=true to preserve form state across switches, this assertion
  // breaks → forces refactor to per-tab Map<Tab, RefObject<SettingsFormHandle>>.
  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_when_dialog_open_on_paths_tab_then_only_paths_form_is_mounted', async () => {
    await dirtyAndOpenDialog();
    // Paths-tab fields visible.
    expect(screen.getByLabelText(/scan path/i)).toBeInTheDocument();
    // Encoder-tab CRF inputs NOT mounted (4 spinbutton inputs would appear).
    expect(screen.queryByLabelText(/CRF.*libx265/i)).toBeNull();
  });

  // 12-05 T5a — AC-1 D1: AbortController cancels the in-flight Save when
  // operator clicks Cancel mid-await. fetch resolves with .signal.aborted=true;
  // no toast.success fires; no tab-switch happens.
  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_when_cancel_clicked_during_in_flight_save_then_fetch_signal_aborts_no_toast_no_switch', async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveFetch: (v: unknown) => void = () => {};
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return fetchPromise;
    });
    await dirtyAndOpenDialog();
    const saveBtn = screen.getByRole('button', {
      name: en.settings.unsavedChanges.action.save,
    });
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    // saveAndSwitch threaded a fresh AbortController — its signal landed in fetch.
    await waitFor(() => {
      expect(capturedSignal).toBeDefined();
    });
    expect(capturedSignal?.aborted).toBe(false);
    // Operator clicks Cancel mid-await — abort fires, dialog closes
    // immediately (pendingTab → null + saveAbortRef.abort()).
    const cancelBtn = screen.getByRole('button', {
      name: en.settings.unsavedChanges.action.cancel,
    });
    await act(async () => {
      fireEvent.click(cancelBtn);
    });
    expect(capturedSignal?.aborted).toBe(true);
    // Resolve the hanging fetch with an AbortError rejection to unblock the
    // await (the controller already aborted, so onSubmit's catch hits the
    // AbortError silent-return branch). DOMException(message, name) already
    // sets the name; Object.assign would fail (name is a readonly getter).
    await act(async () => {
      resolveFetch(Promise.reject(new DOMException('aborted', 'AbortError')));
    });
    // No success-toast (silent early-return); active tab unchanged (paths).
    expect(mockToastSuccess).not.toHaveBeenCalled();
    const pathsTab = screen.getByRole('tab', { name: /paths/i });
    expect(pathsTab.getAttribute('aria-selected')).toBe('true');
  });

  // 12-05 T5a — AC-2 D3 (imperative entry): rapid double-click on the
  // dialog's Save button collapses to exactly 1 fetch via the
  // submitInFlightRef sync-guard at onSubmit body top.
  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_when_dialog_save_clicked_rapidly_twice_then_exactly_one_fetch_fires', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    mockFetch.mockReturnValue(fetchPromise);
    await dirtyAndOpenDialog();
    const saveBtn = screen.getByRole('button', {
      name: en.settings.unsavedChanges.action.save,
    });
    // Two clicks in the SAME tick — the second hits the sync-guard before
    // React re-renders the disabled-attr propagation.
    await act(async () => {
      fireEvent.click(saveBtn);
      fireEvent.click(saveBtn);
    });
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
    // Clean up the hanging Promise.
    await act(async () => {
      resolveFetch({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ settings: {}, requestId: 'r1' }),
      });
    });
  });

  // 12-05 T5a M2 — AC-2 D3 (sticky-bar entry): same sync-guard fires from
  // the native form-submit path, not just the imperative submit(). Rapid
  // double `fireEvent.submit` on the sticky-bar <form> collapses to 1 POST.
  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_when_sticky_bar_form_submitted_rapidly_twice_then_exactly_one_fetch_fires', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    mockFetch.mockReturnValue(fetchPromise);
    await renderPage();
    // Dirty the paths form so the sticky-bar Save button is enabled.
    const scanRoot = screen.getByLabelText(/scan path/i) as HTMLInputElement;
    await userEvent.clear(scanRoot);
    await userEvent.type(scanRoot, '/media/movies');
    const form = scanRoot.closest('form');
    expect(form).not.toBeNull();
    await act(async () => {
      fireEvent.submit(form!);
      fireEvent.submit(form!);
    });
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      resolveFetch({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ settings: {}, requestId: 'r1' }),
      });
    });
  });

  // 12-05 T5a — AC-3 D4 (M6 audit-added, behavioral): per-tab Ref-Map
  // means each visited tab lazy-creates its own RefObject. The existing
  // tests already cover paths→encoder via dirtyAndOpenDialog. This test
  // verifies the contract holds AFTER a tab-cycle (paths→encoder→paths)
  // re-mounts the paths form and the freshly-bound ref still routes the
  // dialog-Save correctly. If the Map ever leaked or shared refs across
  // tabs, saveAndSwitch on the re-mounted paths form would crash (.current
  // null) or POST stale state.
  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_when_paths_tab_cycled_then_dialog_save_routes_through_fresh_ref', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ settings: {}, requestId: 'r1' }),
    });
    await renderPage();
    // First excursion: paths → encoder → back to paths (lazy-creates both
    // RefObjects via getFormRef on each mount). No form dirty yet → no
    // AlertDialog fires.
    const encoderTab = screen.getByRole('tab', { name: /encoder/i });
    await act(async () => {
      fireEvent.click(encoderTab);
    });
    const pathsTab = screen.getByRole('tab', { name: /paths/i });
    await act(async () => {
      fireEvent.click(pathsTab);
    });
    // Now do the dirty-and-open dance on the RE-MOUNTED paths form.
    const scanRoot = screen.getByLabelText(/scan path/i) as HTMLInputElement;
    await userEvent.clear(scanRoot);
    await userEvent.type(scanRoot, '/media/movies');
    await act(async () => {
      fireEvent.click(encoderTab);
    });
    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });
    const saveBtn = screen.getByRole('button', {
      name: en.settings.unsavedChanges.action.save,
    });
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    // Dialog closes + tab switches to encoder → proves saveAndSwitch read
    // the re-mounted paths-form ref correctly and onSubmit resolved
    // { ok: true } back through the Map<Tab,Ref> path.
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(mockFetch).toHaveBeenCalled();
  });

  // 12-05 T5a — AC-4 D4 mount-isolation roundtrip: under keepMounted=false
  // each Tab unmount/remount cycle re-binds the corresponding RefObject's
  // .current. Switch paths → encoder → back-to-paths; assert the paths
  // scan_root input is once-again present (re-mounted) and its value is the
  // original default (NOT the dirty edit that triggered the dialog).
  // // 14-04 (Plan 14-04 Task 5): obsolete — probes retired paths-tab UI.

  it.skip('test_when_paths_tab_revisited_after_discard_then_form_remounts_with_original_defaults', async () => {
    await dirtyAndOpenDialog();
    // Discard the unsaved edit → tab switches to encoder.
    const discardBtn = screen.getByRole('button', {
      name: en.settings.unsavedChanges.action.discard,
    });
    await act(async () => {
      fireEvent.click(discardBtn);
    });
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    // Now revisit paths — the form should re-mount with the ORIGINAL
    // scan_root, not the discarded "/media/movies" edit.
    const pathsTab = screen.getByRole('tab', { name: /paths/i });
    await act(async () => {
      fireEvent.click(pathsTab);
    });
    const scanRoot = screen.getByLabelText(/scan path/i) as HTMLInputElement;
    expect(scanRoot).toBeInTheDocument();
    expect(scanRoot.value).toBe('/media');
  });
});
