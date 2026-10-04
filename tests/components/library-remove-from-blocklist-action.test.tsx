/*
 * 50-04 T3: RemoveFromBlocklistAction. Modeled on library-delete-action.test.tsx
 * (the nearest ConfirmButton P2 relative). Covers:
 *   AC-9  — no button for a row without a file-pinned entry (pattern-blocked).
 *   AC-10 — button for a row WITH an entry.
 *   AC-11 — click defers; undo inside the window fires nothing.
 *   AC-12 — after the window: DELETE with the ENTRY id in the path and the
 *           FILE id in ?expectFileId, then success toast + refresh.
 *   AC-13 — 404 counts as success (entry already gone).
 *   AC-14 — 409 / network error → error toast, NO refresh.
 *   AC-15 — h-11 (Constraint Z.103 ≥44px).
 *   AC-25 — the undo toast is future tense; success toast only after the response.
 *   AC-26 — unmount inside the window drops the action SILENTLY (inherited M-6).
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

import { RemoveFromBlocklistAction } from '@/components/library/remove-from-blocklist-action';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const baseFile: FileRow = {
  id: 7,
  path: '/movies/Blocked.mkv',
  size_bytes: 1024,
  mtime: 1700000000,
  content_hash: 'a'.repeat(64),
  codec: 'h264',
  bitrate: 1000000,
  duration_seconds: 60,
  width: 1920,
  height: 1080,
  container: 'matroska',
  status: 'blocklisted',
  last_scanned_at: 1700000000,
  created_at: 1700000000,
  updated_at: 1700000000,
  version: 3,
  container_override: null,
  share_id: null,
};

const BTN = /Unblock/i;

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

function stubFetch(response: Partial<Response> = {}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async () => ({ ok: true, status: 200, json: async () => ({}), ...response }) as Response,
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('RemoveFromBlocklistAction visibility (AC-9 / AC-10)', () => {
  it('test_RemoveFromBlocklistAction_when_blocklisted_with_entry_then_button_visible', () => {
    render(wrap(<RemoveFromBlocklistAction file={baseFile} entryId={91} />));
    expect(screen.getByRole('button', { name: BTN })).toBeInTheDocument();
  });

  // AC-9: a pattern-blocked row has no per-file entry — there is nothing this
  // button could remove that would affect only this file.
  it('test_RemoveFromBlocklistAction_when_blocklisted_without_entry_then_returns_null', () => {
    const { container } = render(wrap(<RemoveFromBlocklistAction file={baseFile} />));
    expect(container).toBeEmptyDOMElement();
  });

  // An entry can outlive the status: the route deliberately preserves a status
  // it did not set, so the button must key off BOTH facts.
  it.each(['pending', 'queued', 'failed', 'done-smaller'] as const)(
    'test_RemoveFromBlocklistAction_when_status_%s_then_returns_null_even_with_entry',
    (status) => {
      const { container } = render(
        wrap(<RemoveFromBlocklistAction file={{ ...baseFile, status }} entryId={91} />),
      );
      expect(container).toBeEmptyDOMElement();
    },
  );
});

describe('RemoveFromBlocklistAction touch target (AC-15)', () => {
  it('test_RemoveFromBlocklistAction_when_rendered_then_h11_touch_target', () => {
    render(wrap(<RemoveFromBlocklistAction file={baseFile} entryId={91} />));
    const btn = screen.getByRole('button', { name: BTN });
    // Constraint Z.103 ≥44px — ConfirmButton size 'md' is h-11/min-h-11.
    expect(btn.className).toMatch(/\bh-11\b/);
    expect(btn.className).toMatch(/\bmin-h-11\b/);
  });
});

describe('RemoveFromBlocklistAction P2 undo flow (AC-11 / AC-12 / AC-25)', () => {
  it('test_RemoveFromBlocklistAction_when_clicked_then_fetch_NOT_called_synchronously', () => {
    const fetchSpy = stubFetch();
    render(wrap(<RemoveFromBlocklistAction file={baseFile} entryId={91} />));
    fireEvent.click(screen.getByRole('button', { name: BTN }));
    expect(mockShowUndoToast).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    // AC-25: nothing has happened yet, so no success toast may claim otherwise.
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  // AC-25: the undo toast describes a SCHEDULED action, not a completed one.
  it('test_RemoveFromBlocklistAction_when_clicked_then_undo_toast_is_future_tense', () => {
    stubFetch();
    render(wrap(<RemoveFromBlocklistAction file={baseFile} entryId={91} />));
    fireEvent.click(screen.getByRole('button', { name: BTN }));
    const args = mockShowUndoToast.mock.calls[0]![0] as unknown as {
      message: string;
      durationMs?: number;
    };
    expect(args.message).toBe(en.library.unblocklist.undo.toastBody);
    expect(args.message).toMatch(/will be removed/i);
    expect(args.durationMs).toBe(10_000);
  });

  it('test_RemoveFromBlocklistAction_when_undo_within_window_then_fetch_NEVER_fires', async () => {
    vi.useFakeTimers();
    const fetchSpy = stubFetch();
    render(wrap(<RemoveFromBlocklistAction file={baseFile} entryId={91} />));
    fireEvent.click(screen.getByRole('button', { name: BTN }));
    const onUndo = (mockShowUndoToast.mock.calls[0]![0] as unknown as { onUndo: () => void })
      .onUndo;
    act(() => {
      onUndo();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockRouterRefresh).not.toHaveBeenCalled();
  });

  // AC-12: the ENTRY id belongs in the path, the FILE id in the query. Swapping
  // them is exactly the mistake ?expectFileId exists to catch, so the URL shape
  // is frozen here.
  it('test_RemoveFromBlocklistAction_when_window_elapses_then_DELETE_entryId_path_and_fileId_query', async () => {
    vi.useFakeTimers();
    const fetchSpy = stubFetch({ ok: true, status: 200 });
    render(wrap(<RemoveFromBlocklistAction file={baseFile} entryId={91} />));
    fireEvent.click(screen.getByRole('button', { name: BTN }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe('/api/library/91/blocklist?expectFileId=7');
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe('DELETE');
    expect(mockToastSuccess).toHaveBeenCalledWith(en.library.unblocklist.toast.success);
    expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('RemoveFromBlocklistAction response handling (AC-13 / AC-14)', () => {
  // AC-13: the entry is already gone — the outcome the operator asked for.
  it('test_RemoveFromBlocklistAction_when_404_then_treated_as_success', async () => {
    vi.useFakeTimers();
    stubFetch({ ok: false, status: 404 });
    render(wrap(<RemoveFromBlocklistAction file={baseFile} entryId={91} />));
    fireEvent.click(screen.getByRole('button', { name: BTN }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockToastSuccess).toHaveBeenCalledTimes(1);
    expect(mockToastError).not.toHaveBeenCalled();
    expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
  });

  // AC-14: the guard fired — the entry pins a different file. Never a success.
  it('test_RemoveFromBlocklistAction_when_409_mismatch_then_error_toast_AND_no_refresh', async () => {
    vi.useFakeTimers();
    stubFetch({ ok: false, status: 409 });
    render(wrap(<RemoveFromBlocklistAction file={baseFile} entryId={91} />));
    fireEvent.click(screen.getByRole('button', { name: BTN }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockToastError).toHaveBeenCalledWith(en.library.unblocklist.toast.error);
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockRouterRefresh).not.toHaveBeenCalled();
  });

  it('test_RemoveFromBlocklistAction_when_fetch_rejects_then_error_toast_AND_no_refresh', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    render(wrap(<RemoveFromBlocklistAction file={baseFile} entryId={91} />));
    fireEvent.click(screen.getByRole('button', { name: BTN }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockRouterRefresh).not.toHaveBeenCalled();
  });
});

describe('RemoveFromBlocklistAction inherited P2 unmount property (AC-26 / M-6)', () => {
  // useDeferredAction clears its timer in the unmount cleanup and does NOT fire.
  // Unmounting inside the window — closing the detail panel, switching page or
  // filter, navigating away — therefore drops the request SILENTLY.
  //
  // This test FREEZES that behaviour rather than working around it. It is
  // inherited, not introduced: LibraryDeleteAction has had it in the very same
  // detail panel since 24-04. A fix belongs in ConfirmButton, where it would
  // reach every P2 caller at once — explicitly out of scope for 50-04.
  it('test_RemoveFromBlocklistAction_when_unmounted_within_window_then_request_silently_dropped', async () => {
    vi.useFakeTimers();
    const fetchSpy = stubFetch();
    const { unmount } = render(wrap(<RemoveFromBlocklistAction file={baseFile} entryId={91} />));
    fireEvent.click(screen.getByRole('button', { name: BTN }));

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });
});
