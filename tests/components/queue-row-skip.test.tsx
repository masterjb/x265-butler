// 05-09 → 13-01b T3: SkipRowAction tests rewritten for ConfirmButton P2.
// 2-step "Confirm skip" button is gone; P2 fires after 10s undo-toast.
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { SkipRowAction } from '@/components/queue/skip-row-action';
import { wrap } from '../test-utils';
import type { JobRow } from '@/src/lib/db/schema';

const { mockToastSuccess, mockToastError, mockShowUndoToast, mockRouterRefresh } = vi.hoisted(
  () => ({
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
  }),
);

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
});

afterEach(() => {
  vi.useRealTimers();
});

function jobFix(over: Partial<JobRow> = {}): JobRow {
  return {
    id: 7,
    file_id: 42,
    status: 'encoding',
    started_at: null,
    finished_at: null,
    encoder: 'libx265',
    bytes_in: null,
    bytes_out: null,
    duration_ms: null,
    exit_code: null,
    error_msg: null,
    log_tail: null,
    created_at: 0,
    crf: null,
    queue_position: 0,
    ...over,
  };
}

describe('SkipRowAction visibility', () => {
  it('test_skip_row_when_status_done_then_does_not_render', () => {
    render(wrap(<SkipRowAction job={jobFix({ status: 'done' })} />));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('test_skip_row_when_status_encoding_then_renders', () => {
    render(wrap(<SkipRowAction job={jobFix({ status: 'encoding' })} />));
    expect(screen.getByRole('button', { name: /skip/i })).toBeInTheDocument();
  });

  it('test_skip_row_when_status_queued_then_renders', () => {
    render(wrap(<SkipRowAction job={jobFix({ status: 'queued' })} />));
    expect(screen.getByRole('button', { name: /skip/i })).toBeInTheDocument();
  });
});

describe('SkipRowAction P2 undo-toast flow', () => {
  it('test_skip_row_when_clicked_then_showUndoToast_invoked', () => {
    render(wrap(<SkipRowAction job={jobFix({ status: 'encoding' })} />));
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    expect(mockShowUndoToast).toHaveBeenCalledTimes(1);
  });

  it('test_skip_row_when_undo_invoked_then_fetch_NEVER_fires', async () => {
    vi.useFakeTimers();
    render(wrap(<SkipRowAction job={jobFix({ status: 'encoding' })} />));
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
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

  it('test_skip_row_when_defer_elapses_then_POSTs_queue_jobid_skip_endpoint', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ skipped: true }) });
    render(wrap(<SkipRowAction job={jobFix({ id: 7, status: 'encoding' })} />));
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/queue/7/skip',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it('test_skip_row_when_post_success_then_S4_router_refresh_after_2s', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ skipped: true }) });
    render(wrap(<SkipRowAction job={jobFix({ id: 7, status: 'encoding' })} />));
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(mockRouterRefresh).toHaveBeenCalled();
  });
});
