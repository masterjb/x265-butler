/*
 * 24-04 F6 T2: LibraryDeleteAction client component tests. Mirrors
 * retry-action.test.tsx (ConfirmButton P2 10s undo-toast). Covers:
 *   AC-6 — renders for non-active statuses, returns null for queued/encoding.
 *   AC-7 — defer→DELETE fires + success-toast + router.refresh; undo→no fetch;
 *          409 active-job + 409 bench-ref → distinct error toasts.
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

import { LibraryDeleteAction } from '@/components/library/delete-action';

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
  status: 'vanished',
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

function stubFetch(response: Partial<Response> & { jsonBody?: unknown }): ReturnType<typeof vi.fn> {
  const { jsonBody, ...rest } = response;
  const fn = vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => jsonBody ?? {},
        ...rest,
      }) as Response,
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('LibraryDeleteAction visibility (AC-6)', () => {
  it('test_LibraryDeleteAction_when_status_queued_then_returns_null', () => {
    const { container } = render(
      wrap(<LibraryDeleteAction file={{ ...baseFile, status: 'queued' }} />),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('test_LibraryDeleteAction_when_status_encoding_then_returns_null', () => {
    const { container } = render(
      wrap(<LibraryDeleteAction file={{ ...baseFile, status: 'encoding' }} />),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('test_LibraryDeleteAction_when_status_vanished_then_button_visible', () => {
    render(wrap(<LibraryDeleteAction file={baseFile} />));
    expect(screen.getByRole('button', { name: /Delete entry/i })).toBeInTheDocument();
  });

  it('test_LibraryDeleteAction_when_status_failed_then_button_visible', () => {
    render(wrap(<LibraryDeleteAction file={{ ...baseFile, status: 'failed' }} />));
    expect(screen.getByRole('button', { name: /Delete entry/i })).toBeInTheDocument();
  });

  it('test_LibraryDeleteAction_when_status_done_smaller_then_button_visible', () => {
    render(wrap(<LibraryDeleteAction file={{ ...baseFile, status: 'done-smaller' }} />));
    expect(screen.getByRole('button', { name: /Delete entry/i })).toBeInTheDocument();
  });
});

describe('LibraryDeleteAction P2 undo-toast flow (AC-7)', () => {
  it('test_LibraryDeleteAction_when_clicked_then_showUndoToast_with_filename_body', () => {
    stubFetch({ ok: true });
    render(wrap(<LibraryDeleteAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Delete entry/i }));
    expect(mockShowUndoToast).toHaveBeenCalledTimes(1);
    const args = mockShowUndoToast.mock.calls[0]![0] as unknown as {
      message: string;
      durationMs?: number;
    };
    expect(args.message).toContain('A.x265.mkv');
    expect(args.durationMs).toBe(10_000);
  });

  it('test_LibraryDeleteAction_when_clicked_then_fetch_NOT_called_synchronously', () => {
    const fetchSpy = stubFetch({ ok: true });
    render(wrap(<LibraryDeleteAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Delete entry/i }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('test_LibraryDeleteAction_when_undo_within_window_then_fetch_NEVER_fires', async () => {
    vi.useFakeTimers();
    const fetchSpy = stubFetch({ ok: true });
    render(wrap(<LibraryDeleteAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Delete entry/i }));
    const onUndo = (mockShowUndoToast.mock.calls[0]![0] as unknown as { onUndo: () => void })
      .onUndo;
    act(() => {
      onUndo();
    });
    await act(async () => {
      vi.advanceTimersByTime(11_000);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it('test_LibraryDeleteAction_when_defer_elapses_then_DELETE_fires_AND_success_AND_refresh', async () => {
    vi.useFakeTimers();
    const fetchSpy = stubFetch({ ok: true, status: 200 });
    render(wrap(<LibraryDeleteAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Delete entry/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/library/1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(mockToastSuccess).toHaveBeenCalled();
    expect(mockRouterRefresh).toHaveBeenCalled();
  });

  it('test_LibraryDeleteAction_when_409_active_job_then_activeJob_toast_no_refresh', async () => {
    vi.useFakeTimers();
    stubFetch({ ok: false, status: 409, jsonBody: { error: 'delete_rejected_active_job' } });
    render(wrap(<LibraryDeleteAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Delete entry/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(/being encoded/i));
    expect(mockRouterRefresh).not.toHaveBeenCalled();
  });

  it('test_LibraryDeleteAction_when_409_bench_ref_then_benchRef_toast', async () => {
    vi.useFakeTimers();
    stubFetch({ ok: false, status: 409, jsonBody: { error: 'delete_blocked_bench_reference' } });
    render(wrap(<LibraryDeleteAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Delete entry/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(/benchmark/i));
  });

  it('test_LibraryDeleteAction_when_5xx_then_generic_error_toast', async () => {
    vi.useFakeTimers();
    stubFetch({ ok: false, status: 500 });
    render(wrap(<LibraryDeleteAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Delete entry/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(/Could not delete/i));
  });

  it('test_LibraryDeleteAction_when_network_throws_then_error_toast', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network');
      }),
    );
    render(wrap(<LibraryDeleteAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Delete entry/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockToastError).toHaveBeenCalled();
  });
});
