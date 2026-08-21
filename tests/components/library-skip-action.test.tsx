// 05-09 → 13-01b T3: Library SkipAction tests rewritten for ConfirmButton P2
// migration. 2-step confirm-button is gone; P2 fires after 10s undo-toast.
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { SkipAction } from '@/components/library/skip-action';
import { wrap } from '../test-utils';
import type { FileRow, FileStatus } from '@/src/lib/db/schema';

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

function fileFix(over: Partial<FileRow> = {}): FileRow {
  return {
    id: 42,
    path: '/m/x.mp4',
    size_bytes: 1000,
    mtime: 0,
    content_hash: 'a'.repeat(64),
    codec: 'h264',
    bitrate: 5_000_000,
    duration_seconds: 60,
    width: 1280,
    height: 720,
    container: 'mp4',
    last_scanned_at: 0,
    status: 'encoding' as FileStatus,
    version: 1,
    updated_at: 0,
    created_at: 0,
    container_override: null,
    share_id: null,
    ...over,
  };
}

describe('Library SkipAction visibility', () => {
  it('test_SkipAction_when_status_pending_then_does_not_render', () => {
    render(wrap(<SkipAction file={fileFix({ status: 'pending' })} />));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('test_SkipAction_when_status_done_smaller_then_does_not_render', () => {
    render(wrap(<SkipAction file={fileFix({ status: 'done-smaller' })} />));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('test_SkipAction_when_status_encoding_then_renders_skip_button', () => {
    render(wrap(<SkipAction file={fileFix({ status: 'encoding' })} />));
    expect(screen.getByRole('button', { name: /skip/i })).toBeInTheDocument();
  });

  it('test_SkipAction_when_status_queued_then_renders_skip_button', () => {
    render(wrap(<SkipAction file={fileFix({ status: 'queued' })} />));
    expect(screen.getByRole('button', { name: /skip/i })).toBeInTheDocument();
  });
});

describe('Library SkipAction P2 undo-toast flow', () => {
  it('test_SkipAction_when_clicked_then_showUndoToast_invoked', () => {
    render(wrap(<SkipAction file={fileFix({ status: 'encoding' })} />));
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    expect(mockShowUndoToast).toHaveBeenCalledTimes(1);
  });

  it('test_SkipAction_when_clicked_then_fetch_NOT_called_synchronously', () => {
    render(wrap(<SkipAction file={fileFix({ status: 'encoding' })} />));
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('test_SkipAction_when_undo_invoked_then_fetch_NEVER_fires', async () => {
    vi.useFakeTimers();
    render(wrap(<SkipAction file={fileFix({ status: 'encoding' })} />));
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

  it('test_SkipAction_when_defer_elapses_then_POSTs_library_skip_endpoint', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ skipped: true }) });
    render(wrap(<SkipAction file={fileFix({ id: 42, status: 'encoding' })} />));
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/library/42/skip',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  it('test_SkipAction_when_post_success_then_S4_fallback_router_refresh_after_2s', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ skipped: true }) });
    render(wrap(<SkipAction file={fileFix({ id: 42, status: 'encoding' })} />));
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    // S4 fallback fires 2s post-success.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(mockRouterRefresh).toHaveBeenCalled();
  });

  it('test_SkipAction_when_500_then_toast_error', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: vi.fn().mockResolvedValue({}) });
    render(wrap(<SkipAction file={fileFix({ id: 42, status: 'encoding' })} />));
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockToastError).toHaveBeenCalled();
  });
});
