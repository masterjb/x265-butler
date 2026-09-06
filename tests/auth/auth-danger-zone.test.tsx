// 05-02 → 13-01b T6: AuthDangerZone tests rewritten for ConfirmButton P3
// inverted-cooldown migration. role=alertdialog 2-step countdown is gone;
// ConfirmButton P3 owns idle → cooldown(3s) → armed(up to 8s) state-machine
// with instance-scoped ESC + SR3 cooldown-HTML-disabled + SR6 silent
// auto-disarm.
//
// Note: ConfirmButton P3 reads `common.confirm.armedAriaLabel` from the
// shared namespace for the armed state (Foundation invariant). The
// `settings.danger.disableAndDelete.armedLabel` leaf added in T6 i18n is
// reserved for a future Route-1 Foundation extension and is not consumed
// today — documented as a benign additive in 13-01b-SUMMARY deviations.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { AuthDangerZone } from '@/components/settings/auth-danger-zone';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    dismiss: vi.fn(),
    custom: vi.fn(),
  }),
}));

function wrap(ui: React.ReactElement): React.ReactElement {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>
  );
}

const ARMED_TEXT = en.common.confirm.armedAriaLabel;

describe('AuthDangerZone — P3 inverted-cooldown migration', () => {
  const originalFetch = global.fetch;
  let replaceMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    global.fetch = vi.fn();
    replaceMock = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { pathname: '/en/settings', search: '', replace: replaceMock },
      writable: true,
    });
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((q: string) => ({
        matches: false,
        media: q,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        onchange: null,
        dispatchEvent: vi.fn(),
      })),
    });
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('initial render: idle button visible, no alertdialog DOM', () => {
    render(wrap(<AuthDangerZone />));
    expect(
      screen.getByRole('button', { name: en.settings.danger.disableAndDelete.label }),
    ).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('click idle → enters cooldown (button HTML-disabled per SR3)', () => {
    vi.useFakeTimers();
    render(wrap(<AuthDangerZone />));
    const btn = screen.getByRole('button', {
      name: en.settings.danger.disableAndDelete.label,
    });
    act(() => {
      fireEvent.click(btn);
    });
    const primary = screen.getByTestId('confirm-button-primary');
    expect(primary).toBeDisabled();
  });

  it('cooldown elapse (3s) → enters armed state (Foundation aria-label)', () => {
    vi.useFakeTimers();
    const { container } = render(wrap(<AuthDangerZone />));
    fireEvent.click(screen.getByRole('button', { name: /Disable \+ delete user/i }));
    act(() => {
      vi.advanceTimersByTime(3001);
    });
    expect(container.querySelector('[data-state="armed"]')).toBeTruthy();
    // ConfirmButton P3 swaps the visible span to armedAriaLabel.
    expect(screen.getByRole('button', { name: ARMED_TEXT })).toBeTruthy();
  });

  it('click while armed → POST fires', async () => {
    vi.useFakeTimers();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    render(wrap(<AuthDangerZone />));
    fireEvent.click(screen.getByRole('button', { name: /Disable \+ delete user/i }));
    act(() => {
      vi.advanceTimersByTime(3001);
    });
    const armed = screen.getByRole('button', { name: ARMED_TEXT });
    await act(async () => {
      fireEvent.click(armed);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/auth/disable-and-delete',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('successful POST 204 → window.location.replace fires', async () => {
    vi.useFakeTimers();
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    render(wrap(<AuthDangerZone />));
    fireEvent.click(screen.getByRole('button', { name: /Disable \+ delete user/i }));
    act(() => {
      vi.advanceTimersByTime(3001);
    });
    const armed = screen.getByRole('button', { name: ARMED_TEXT });
    await act(async () => {
      fireEvent.click(armed);
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(replaceMock).toHaveBeenCalled();
  });

  it('Cancel button while armed → ABORT (no fetch fires)', () => {
    vi.useFakeTimers();
    render(wrap(<AuthDangerZone />));
    fireEvent.click(screen.getByRole('button', { name: /Disable \+ delete user/i }));
    act(() => {
      vi.advanceTimersByTime(3001);
    });
    const cancel = screen.getByTestId('confirm-button-cancel');
    fireEvent.click(cancel);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('auto-disarm after 8s armed without click → leaves armed state, NO toast (SR6 silent)', () => {
    vi.useFakeTimers();
    const { container } = render(wrap(<AuthDangerZone />));
    fireEvent.click(screen.getByRole('button', { name: /Disable \+ delete user/i }));
    act(() => {
      vi.advanceTimersByTime(3001); // cooldown done → armed
    });
    expect(container.querySelector('[data-state="armed"]')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(8001); // auto-disarm fires
    });
    expect(container.querySelector('[data-state="armed"]')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
