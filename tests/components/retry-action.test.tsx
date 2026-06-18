/*
 * 04-03 → 13-01b T1: LibraryRetryAction client component tests rewritten for
 * ConfirmButton P2 migration (10s undo-toast). The 2-step countdown-revert
 * pattern is gone; tests assert the new P2 flow:
 *   - click Retry → showUndoToast invoked with countdown + Undo-button +
 *     fetch deferred 10s via useDeferredAction.
 *   - click Undo within window → fetch NEVER fires.
 *   - wait 10s → fetch fires + success-toast + router.refresh.
 *   - visibilitychange→hidden during defer-window → fetch fires immediately.
 *   - submitLockRef synchronous guard preserved inside onConfirm callback.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { FileRow } from '@/src/lib/db/schema';

const { mockRouterRefresh, mockToastSuccess, mockToastError, mockToastDismiss, mockShowUndoToast } =
  vi.hoisted(() => ({
    mockRouterRefresh: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
    mockToastDismiss: vi.fn(),
    mockShowUndoToast: vi.fn<
      (args: {
        message: string;
        undoLabel?: string;
        onUndo: () => void | Promise<void>;
        durationMs?: number;
      }) => string
    >(() => 'undo-toast-id-1'),
  }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: mockRouterRefresh,
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
    dismiss: mockToastDismiss,
    custom: vi.fn(() => 'sonner-id'),
  },
}));

vi.mock('@/components/ui/undo-toast', () => ({
  showUndoToast: mockShowUndoToast,
  UNDO_TOAST_DEFAULT_MS: 10_000,
}));

import { LibraryRetryAction } from '@/components/library/retry-action';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const baseFile: FileRow = {
  id: 1,
  path: '/movies/A.x265.mkv',
  size_bytes: 1024,
  mtime: 1700000000,
  content_hash: 'a'.repeat(64),
  codec: 'hevc',
  bitrate: 1000000,
  duration_seconds: 60,
  width: 1920,
  height: 1080,
  container: 'matroska',
  status: 'failed',
  last_scanned_at: 1700000000,
  created_at: 1700000000,
  updated_at: 1700000000,
  version: 7,
  container_override: null,
  share_id: null,
};

beforeEach(() => {
  mockRouterRefresh.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
  mockToastDismiss.mockReset();
  mockShowUndoToast.mockReset();
  mockShowUndoToast.mockReturnValue('undo-toast-id-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function stubFetch(response: Partial<Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({}),
        ...response,
      }) as Response,
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('LibraryRetryAction visibility (ELIGIBLE_STATES)', () => {
  it('test_LibraryRetryAction_when_status_pending_then_returns_null', () => {
    const { container } = render(
      wrap(<LibraryRetryAction file={{ ...baseFile, status: 'pending' }} />),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('test_LibraryRetryAction_when_status_done_smaller_then_returns_null', () => {
    const { container } = render(
      wrap(<LibraryRetryAction file={{ ...baseFile, status: 'done-smaller' }} />),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('test_LibraryRetryAction_when_status_blocklisted_then_returns_null', () => {
    const { container } = render(
      wrap(<LibraryRetryAction file={{ ...baseFile, status: 'blocklisted' }} />),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('test_LibraryRetryAction_when_status_failed_then_button_visible', () => {
    render(wrap(<LibraryRetryAction file={baseFile} />));
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
  });

  it('test_LibraryRetryAction_when_status_interrupted_then_button_visible', () => {
    render(wrap(<LibraryRetryAction file={{ ...baseFile, status: 'interrupted' }} />));
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
  });

  it('test_LibraryRetryAction_when_status_done_larger_then_button_visible', () => {
    render(wrap(<LibraryRetryAction file={{ ...baseFile, status: 'done-larger' }} />));
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
  });
});

describe('LibraryRetryAction P2 undo-toast flow', () => {
  it('test_LibraryRetryAction_when_clicked_then_showUndoToast_invoked_with_filename_body', () => {
    stubFetch({ ok: true });
    render(wrap(<LibraryRetryAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(mockShowUndoToast).toHaveBeenCalledTimes(1);
    const args = mockShowUndoToast.mock.calls[0]![0] as unknown as {
      message: string;
      undoLabel?: string;
      onUndo: () => void;
      durationMs?: number;
    };
    expect(args.message).toContain('A.x265.mkv');
    expect(args.durationMs).toBe(10_000);
    expect(typeof args.onUndo).toBe('function');
  });

  it('test_LibraryRetryAction_when_clicked_then_fetch_NOT_called_synchronously', () => {
    const fetchSpy = stubFetch({ ok: true });
    render(wrap(<LibraryRetryAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('test_LibraryRetryAction_when_undo_invoked_within_window_then_fetch_NEVER_fires', async () => {
    vi.useFakeTimers();
    const fetchSpy = stubFetch({ ok: true });
    render(wrap(<LibraryRetryAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    const onUndo = (mockShowUndoToast.mock.calls[0]![0] as unknown as { onUndo: () => void })
      .onUndo;
    act(() => {
      onUndo();
    });
    // Advance past defer window.
    await act(async () => {
      vi.advanceTimersByTime(11_000);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it('test_LibraryRetryAction_when_defer_elapses_then_POST_fires_AND_toast_success_AND_router_refresh', async () => {
    vi.useFakeTimers();
    const fetchSpy = stubFetch({ ok: true, status: 200 });
    render(wrap(<LibraryRetryAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/library/1/retry',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(mockToastSuccess).toHaveBeenCalled();
    expect(mockRouterRefresh).toHaveBeenCalled();
  });

  it('test_LibraryRetryAction_when_409_then_toast_notEligible_AND_no_router_refresh', async () => {
    vi.useFakeTimers();
    stubFetch({ ok: false, status: 409 });
    render(wrap(<LibraryRetryAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(/cannot be retried/i));
    expect(mockRouterRefresh).not.toHaveBeenCalled();
  });

  it('test_LibraryRetryAction_when_5xx_then_toast_error', async () => {
    vi.useFakeTimers();
    stubFetch({ ok: false, status: 500 });
    render(wrap(<LibraryRetryAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(/Could not retry/i));
  });

  it('test_LibraryRetryAction_when_network_throws_then_toast_error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network');
      }),
    );
    render(wrap(<LibraryRetryAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockToastError).toHaveBeenCalled();
  });

  it('test_LibraryRetryAction_when_tab_hidden_during_defer_then_fetch_fires_immediately', async () => {
    vi.useFakeTimers();
    const fetchSpy = stubFetch({ ok: true, status: 200 });
    render(wrap(<LibraryRetryAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    // Simulate tab hide before 10s elapse.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      // Flush microtasks (fetch is async) without advancing the 10s timer.
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchSpy).toHaveBeenCalled();
  });
});
