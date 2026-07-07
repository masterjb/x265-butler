// Phase 16-02 T4 — AutoScanAdvanced component tests.
//
// Coverage: AC-3 / AC-4 / AC-5 (UI half) + AC-8 (render + a11y) + AC-9
// (i18n parity exercised via NextIntlClientProvider).
//
// Audit-added M6 hydration-strategy: render does NOT emit hydration warnings
// (initial-prop drilled server-side → client first-paint matches).
// Audit-added M7 touch-target: classes assert h-11 mobile / md:h-9 desktop.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { ReactNode } from 'react';

vi.mock('swr', () => ({ __esModule: true, default: vi.fn(), mutate: vi.fn() }));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { AutoScanAdvanced } from '@/components/settings/auto-scan-advanced';
import { toast } from 'sonner';

const toastSuccessMock = vi.mocked(toast.success);
const toastErrorMock = vi.mocked(toast.error);

function wrap(children: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {children}
    </NextIntlClientProvider>
  );
}

const DEFAULT_INITIAL = {
  bootScanOnStart: 'true' as const,
  stabilityThreshold: '10000',
  batchWindow: '5000',
  reconcileIntervalH: '6',
};

beforeEach(() => {
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openPanel(): Promise<void> {
  // Trigger ist die erste Region mit role="button" + advanced-section-title text.
  const trigger = screen.getByText(/Advanced options/i).closest('button');
  if (!trigger) throw new Error('Collapsible trigger not found');
  await userEvent.click(trigger);
}

describe('AutoScanAdvanced (16-02 T4)', () => {
  it('renders with initial values — section collapsed by default (T3 decision a)', () => {
    render(wrap(<AutoScanAdvanced initial={DEFAULT_INITIAL} />));
    expect(screen.getByText(/Advanced options/i)).toBeTruthy();
    // Panel not visible while closed (Switch not in DOM yet via collapsible).
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('toggle bootScanOnStart switch → dirty hint + Save enabled', async () => {
    render(wrap(<AutoScanAdvanced initial={DEFAULT_INITIAL} />));
    await openPanel();
    const sw = screen.getByRole('switch');
    await userEvent.click(sw);
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    const save = screen.getByRole('button', { name: /^Save$/i });
    expect(save.hasAttribute('disabled')).toBe(false);
  });

  it('enter 15000 in stabilityThreshold + Save → PUT /api/settings with key', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    render(wrap(<AutoScanAdvanced initial={DEFAULT_INITIAL} />));
    await openPanel();
    const input = screen.getByLabelText(/Write-stability threshold/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '15000' } });
    const save = screen.getByRole('button', { name: /^Save$/i });
    await userEvent.click(save);
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const putCall = calls.find((c) => c[1]?.method === 'PUT');
    expect(putCall).toBeDefined();
    const body = JSON.parse(putCall![1].body as string);
    expect(body).toEqual({ settings: { 'autoScan.stabilityThreshold': '15000' } });
  });

  it('enter 500 in stabilityThreshold + blur → inline error + Save disabled + NO PUT', async () => {
    render(wrap(<AutoScanAdvanced initial={DEFAULT_INITIAL} />));
    await openPanel();
    const input = screen.getByLabelText(/Write-stability threshold/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '500' } });
    fireEvent.blur(input);
    expect(screen.getByText(/Must be between 1000 and 60000/i)).toBeTruthy();
    const save = screen.getByRole('button', { name: /^Save$/i });
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('enter 0.04 in reconcileIntervalH → inline error', async () => {
    render(wrap(<AutoScanAdvanced initial={DEFAULT_INITIAL} />));
    await openPanel();
    const input = screen.getByLabelText(/Reconcile interval/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.04' } });
    fireEvent.blur(input);
    expect(screen.getByText(/Must be between 0.05 and 72/i)).toBeTruthy();
  });

  it('failed PUT (500) → toast.error fires', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    render(wrap(<AutoScanAdvanced initial={DEFAULT_INITIAL} />));
    await openPanel();
    const input = screen.getByLabelText(/Write-stability threshold/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '15000' } });
    await userEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(toastErrorMock).toHaveBeenCalled();
  });

  it('failed PUT (400 zod) → field-level error highlighted via i18n key', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        details: [
          {
            path: ['settings', 'autoScan.stabilityThreshold'],
            message: 'autoScan.stabilityThreshold_out_of_range',
          },
        ],
      }),
    });
    render(wrap(<AutoScanAdvanced initial={DEFAULT_INITIAL} />));
    await openPanel();
    const input = screen.getByLabelText(/Write-stability threshold/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '15000' } });
    await userEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(screen.getByText(/Must be between 1000 and 60000/i)).toBeTruthy();
  });

  it('all 3 inputs at once → single PUT with all 3 keys', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    render(wrap(<AutoScanAdvanced initial={DEFAULT_INITIAL} />));
    await openPanel();
    fireEvent.change(screen.getByLabelText(/Write-stability threshold/i), {
      target: { value: '15000' },
    });
    fireEvent.change(screen.getByLabelText(/Batch collection window/i), {
      target: { value: '8000' },
    });
    fireEvent.change(screen.getByLabelText(/Reconcile interval/i), { target: { value: '12' } });
    await userEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    const putCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1]?.method === 'PUT',
    );
    expect(putCall).toBeDefined();
    const body = JSON.parse(putCall![1].body as string);
    expect(body.settings).toEqual({
      'autoScan.stabilityThreshold': '15000',
      'autoScan.batchWindow': '8000',
      'autoScan.reconcileIntervalH': '12',
    });
  });

  it('audit M7 — touch-target classes: number-inputs + Save carry h-11 md:h-9 (Constraint Z.103)', async () => {
    render(wrap(<AutoScanAdvanced initial={DEFAULT_INITIAL} />));
    await openPanel();
    const stability = screen.getByLabelText(/Write-stability threshold/i);
    expect(stability.className).toMatch(/h-11/);
    expect(stability.className).toMatch(/md:h-9/);
    const save = screen.getByRole('button', { name: /^Save$/i });
    expect(save.className).toMatch(/h-11/);
    expect(save.className).toMatch(/md:h-9/);
  });

  it('audit M6 — no hydration warnings emitted during render (initial-prop server-drilled)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(wrap(<AutoScanAdvanced initial={DEFAULT_INITIAL} />));
    const hydrationWarns = errSpy.mock.calls.filter((c) =>
      /hydrat|did not match/i.test(String(c[0])),
    );
    expect(hydrationWarns).toHaveLength(0);
    errSpy.mockRestore();
  });

  // 20-02 AC-3 — hash-detection auto-open: location.hash === '#auto-scan-advanced' at mount opens Collapsible
  it('20-02 AC-3 — when window.location.hash is #auto-scan-advanced, Collapsible auto-opens on mount', () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, hash: '#auto-scan-advanced' },
      writable: true,
    });
    render(wrap(<AutoScanAdvanced initial={DEFAULT_INITIAL} />));
    // Switch lives inside CollapsibleContent — its presence proves open-state.
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });

  // 20-02 AC-5 — no-hash default: Collapsible stays closed (defends against future regressions of useState(false) default)
  it('20-02 AC-5 — when no hash present, Collapsible stays closed (default useState(false) preserved)', () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, hash: '' },
      writable: true,
    });
    render(wrap(<AutoScanAdvanced initial={DEFAULT_INITIAL} />));
    // Switch NOT in DOM → CollapsibleContent not mounted → Collapsible closed.
    expect(screen.queryByRole('switch')).toBeNull();
  });

  // 20-02 AC-4 + audit-M1 + audit-M4 — anchor id forwarded to Collapsible root DOM + scroll-mt-20 + uniqueness vs panel-id
  it('20-02 AC-4 — id="auto-scan-advanced" forwarded to Collapsible root, distinct from panel-id, with scroll-mt-20', () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, hash: '#auto-scan-advanced' },
      writable: true,
    });
    render(wrap(<AutoScanAdvanced initial={DEFAULT_INITIAL} />));
    const root = document.getElementById('auto-scan-advanced');
    expect(root).not.toBeNull();
    // audit-M4: scroll-mt-20 token on root className
    expect(root!.className).toMatch(/scroll-mt-20/);
    // audit-M1: root MUST be distinct from CollapsibleContent panel-id (the panel-id stays on a different element)
    const panel = document.getElementById('auto-scan-advanced-panel');
    expect(panel).not.toBeNull();
    expect(root).not.toBe(panel);
    // Root should contain the panel as descendant (root = Collapsible, panel = CollapsibleContent inside).
    expect(root!.contains(panel)).toBe(true);
  });

  // 20-02 audit-SR3 — StrictMode dev double-mount: setOpen(true) is idempotent → no flicker / toggle
  it('20-02 audit-SR3 — StrictMode double-mount preserves single open-state (idempotent setOpen)', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, hash: '#auto-scan-advanced' },
      writable: true,
    });
    const { StrictMode } = await import('react');
    render(<StrictMode>{wrap(<AutoScanAdvanced initial={DEFAULT_INITIAL} />)}</StrictMode>);
    // Mount-effect runs twice under StrictMode dev double-mount; setOpen(true) idempotent.
    // End-state: open exactly once → Switch present in DOM, no duplicate switches.
    const switches = screen.queryAllByRole('switch');
    expect(switches).toHaveLength(1);
  });
});
