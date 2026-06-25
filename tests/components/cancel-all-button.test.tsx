// 05-09 → 13-01b T3: CancelAllButton tests rewritten for inline ConfirmButton
// P2 migration. AlertDialog Modal removed; counter sourced SSE-fresh from
// useQueueCounts (no /api/queue/status pre-toast refetch — audit M5 accepted
// staleness ≤2s).
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { CancelAllButton } from '@/components/queue/cancel-all-button';
import { wrap } from '../test-utils';

const {
  mockUseQueueCounts,
  mockToastSuccess,
  mockToastError,
  mockShowUndoToast,
  mockRouterRefresh,
} = vi.hoisted(() => ({
  mockUseQueueCounts: vi.fn<() => { activeJobs: number; pendingJobs: number; paused: boolean }>(
    () => ({ activeJobs: 0, pendingJobs: 0, paused: false }),
  ),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockShowUndoToast: vi.fn<
    (args: {
      message: string;
      undoLabel?: string;
      onUndo: () => void | Promise<void>;
      durationMs?: number;
    }) => string
  >(() => 'undo-id'),
  mockRouterRefresh: vi.fn(),
}));

vi.mock('@/src/lib/api/engine-events-client', () => ({
  useQueueCounts: mockUseQueueCounts,
  usePausedState: () => false,
  useActiveJob: () => null,
  useRecentJobs: () => [],
  useEngineEventsDisconnected: () => false,
}));

vi.mock('sonner', () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
    warning: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
    custom: vi.fn(() => 'sonner-id'),
  },
}));

vi.mock('@/components/ui/undo-toast', () => ({
  showUndoToast: mockShowUndoToast,
  UNDO_TOAST_DEFAULT_MS: 10_000,
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

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
  mockShowUndoToast.mockReset();
  mockShowUndoToast.mockReturnValue('undo-id');
  mockRouterRefresh.mockReset();
  (globalThis as { fetch?: unknown }).fetch = mockFetch;
  mockUseQueueCounts.mockReturnValue({ activeJobs: 0, pendingJobs: 0, paused: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CancelAllButton — disabled / enabled gating', () => {
  it('test_cancel_all_when_counter_zero_then_button_disabled', () => {
    render(wrap(<CancelAllButton />));
    const btn = screen.getByRole('button', { name: /reset all/i });
    expect(btn).toBeDisabled();
  });

  it('test_cancel_all_when_counter_positive_then_button_enabled', () => {
    mockUseQueueCounts.mockReturnValue({ activeJobs: 1, pendingJobs: 4, paused: false });
    render(wrap(<CancelAllButton />));
    const btn = screen.getByRole('button', { name: /reset all/i });
    expect(btn).not.toBeDisabled();
  });

  it('test_cancel_all_when_counter_positive_then_no_dialog_pre_click', () => {
    mockUseQueueCounts.mockReturnValue({ activeJobs: 1, pendingJobs: 4, paused: false });
    render(wrap(<CancelAllButton />));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('CancelAllButton — P2 confirm flow (AlertDialog removed)', () => {
  it('test_cancel_all_when_clicked_then_showUndoToast_with_counter_in_body', () => {
    mockUseQueueCounts.mockReturnValue({ activeJobs: 1, pendingJobs: 4, paused: false });
    render(wrap(<CancelAllButton />));
    fireEvent.click(screen.getByRole('button', { name: /reset all/i }));
    expect(mockShowUndoToast).toHaveBeenCalledTimes(1);
    const args = mockShowUndoToast.mock.calls[0]![0] as unknown as { message: string };
    // 5 jobs cancelling → ICU plural "other"
    expect(args.message).toMatch(/5 jobs/i);
  });

  it('test_cancel_all_when_clicked_then_fetch_NOT_called_synchronously', () => {
    mockUseQueueCounts.mockReturnValue({ activeJobs: 1, pendingJobs: 4, paused: false });
    render(wrap(<CancelAllButton />));
    fireEvent.click(screen.getByRole('button', { name: /reset all/i }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('test_cancel_all_when_clicked_then_no_AlertDialog_rendered', () => {
    mockUseQueueCounts.mockReturnValue({ activeJobs: 1, pendingJobs: 4, paused: false });
    render(wrap(<CancelAllButton />));
    fireEvent.click(screen.getByRole('button', { name: /reset all/i }));
    expect(screen.queryByText(/reset queue\?/i)).toBeNull();
  });

  it('test_cancel_all_when_undo_invoked_then_POST_NEVER_fires', async () => {
    vi.useFakeTimers();
    mockUseQueueCounts.mockReturnValue({ activeJobs: 1, pendingJobs: 4, paused: false });
    render(wrap(<CancelAllButton />));
    fireEvent.click(screen.getByRole('button', { name: /reset all/i }));
    const onUndo = (mockShowUndoToast.mock.calls[0]![0] as unknown as { onUndo: () => void })
      .onUndo;
    act(() => {
      onUndo();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('test_cancel_all_when_defer_elapses_then_POSTs_cancel_all_endpoint', async () => {
    vi.useFakeTimers();
    mockUseQueueCounts.mockReturnValue({ activeJobs: 1, pendingJobs: 4, paused: false });
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ skipped: 1, cancelled: 4 }),
    });
    render(wrap(<CancelAllButton />));
    fireEvent.click(screen.getByRole('button', { name: /reset all/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/queue/cancel-all',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it('test_cancel_all_when_post_success_then_S4_fallback_router_refresh_after_2s', async () => {
    vi.useFakeTimers();
    mockUseQueueCounts.mockReturnValue({ activeJobs: 1, pendingJobs: 4, paused: false });
    mockFetch.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ skipped: 1, cancelled: 4 }),
    });
    render(wrap(<CancelAllButton />));
    fireEvent.click(screen.getByRole('button', { name: /reset all/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(mockRouterRefresh).toHaveBeenCalled();
  });

  it('test_cancel_all_when_endpoint_errors_then_error_toast_fires', async () => {
    vi.useFakeTimers();
    mockUseQueueCounts.mockReturnValue({ activeJobs: 1, pendingJobs: 0, paused: false });
    mockFetch.mockResolvedValue({ ok: false });
    render(wrap(<CancelAllButton />));
    fireEvent.click(screen.getByRole('button', { name: /reset all/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockToastError).toHaveBeenCalled();
  });
});
