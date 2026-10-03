/*
 * 24-05 F7 T3: ClearLogsButton tests — AC-5 + AC-6.
 * ConfirmButton P3 (inverted-cooldown one-way door, NO undo). The P3 flow is
 * idle → (click) cooldown 3s → armed → (click) fire. Covers:
 *   - warning copy present (AC-5 shared-store disclosure)
 *   - during cooldown NO fetch; after arm + confirm-click fires exactly one DELETE
 *   - onCleared called on ok; error / network branch → error toast + NO onCleared
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';

const { mockToastSuccess, mockToastError, mockToastDismiss } = vi.hoisted(() => ({
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockToastDismiss: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
    dismiss: mockToastDismiss,
    custom: vi.fn(() => 'sonner-id'),
  },
}));

// P3 internally consumes the undo-toast module via the shared ConfirmButton
// barrel (P2 path); stub it so the import graph stays isolated.
vi.mock('@/components/ui/undo-toast', () => ({
  showUndoToast: vi.fn(() => 'undo-id'),
  UNDO_TOAST_DEFAULT_MS: 10_000,
}));

import { ClearLogsButton } from '@/components/logs/clear-logs-button';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

function stubFetch(response: Partial<Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({ ok: true, status: 200, ...response }) as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

// Flush pending microtasks (the async onConfirm fetch chain) under fake timers.
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
  mockToastDismiss.mockReset();
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ClearLogsButton (AC-5/AC-6)', () => {
  it('renders the shared-store warning copy', () => {
    render(wrap(<ClearLogsButton onCleared={vi.fn()} />));
    expect(screen.getByText(/shared log store/i)).toBeInTheDocument();
  });

  it('first click cools down (no fetch); after 3s it ARMS', () => {
    vi.useFakeTimers();
    const fetchSpy = stubFetch({ ok: true });
    render(wrap(<ClearLogsButton onCleared={vi.fn()} />));

    const btn = screen.getByTestId('confirm-button-primary');
    expect(btn).toHaveTextContent(/Clear log/i);

    act(() => {
      fireEvent.click(btn); // → cooldown
    });
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(fetchSpy).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(3000); // cooldown elapses → armed
    });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('arm + confirm fires exactly one DELETE /api/logs and calls onCleared on ok', async () => {
    vi.useFakeTimers();
    const fetchSpy = stubFetch({ ok: true, status: 200 });
    const onCleared = vi.fn();
    render(wrap(<ClearLogsButton onCleared={onCleared} />));

    const btn = screen.getByTestId('confirm-button-primary');
    act(() => {
      fireEvent.click(btn); // → cooldown
    });
    act(() => {
      vi.advanceTimersByTime(3000); // → armed
    });
    act(() => {
      fireEvent.click(btn); // → fired → async onConfirm
    });
    await flush();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/logs',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it('error response shows error toast and does NOT call onCleared', async () => {
    vi.useFakeTimers();
    stubFetch({ ok: false, status: 500 });
    const onCleared = vi.fn();
    render(wrap(<ClearLogsButton onCleared={onCleared} />));

    const btn = screen.getByTestId('confirm-button-primary');
    act(() => {
      fireEvent.click(btn);
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => {
      fireEvent.click(btn);
    });
    await flush();

    expect(mockToastError).toHaveBeenCalled();
    expect(onCleared).not.toHaveBeenCalled();
  });

  it('network throw shows error toast and does NOT call onCleared', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network');
      }),
    );
    const onCleared = vi.fn();
    render(wrap(<ClearLogsButton onCleared={onCleared} />));

    const btn = screen.getByTestId('confirm-button-primary');
    act(() => {
      fireEvent.click(btn);
    });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    act(() => {
      fireEvent.click(btn);
    });
    await flush();

    expect(mockToastError).toHaveBeenCalled();
    expect(onCleared).not.toHaveBeenCalled();
  });
});
