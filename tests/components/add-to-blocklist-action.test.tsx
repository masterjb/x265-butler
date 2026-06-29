/*
 * 04-02 → 13-01b T1: AddToBlocklistAction client component tests (NEW —
 * no test file existed pre-13-01b). Asserts ConfirmButton P1 1-click flow:
 *   - eligible status → button visible.
 *   - click → POST fires immediately (no popover, no countdown, no undo).
 *   - 200 → toast.success + router.refresh.
 *   - non-200 → toast.error.
 *   - submitLockRef guard preserved (3× rapid click → 1 POST).
 *   - no Popover wrapper / no countdown-revert state remains.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { FileRow } from '@/src/lib/db/schema';

const { mockRouterRefresh, mockToastSuccess, mockToastError, mockShowUndoToast } = vi.hoisted(
  () => ({
    mockRouterRefresh: vi.fn(),
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
  }),
);

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
    dismiss: vi.fn(),
    custom: vi.fn(() => 'sonner-id'),
  },
}));

vi.mock('@/components/ui/undo-toast', () => ({
  showUndoToast: mockShowUndoToast,
  UNDO_TOAST_DEFAULT_MS: 10_000,
}));

import { AddToBlocklistAction } from '@/components/library/add-to-blocklist-action';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const baseFile: FileRow = {
  id: 7,
  path: '/movies/B.h264.mkv',
  size_bytes: 2048,
  mtime: 1700000000,
  content_hash: 'b'.repeat(64),
  codec: 'h264',
  bitrate: 2_000_000,
  duration_seconds: 120,
  width: 1920,
  height: 1080,
  container: 'matroska',
  status: 'pending',
  last_scanned_at: 1700000000,
  created_at: 1700000000,
  updated_at: 1700000000,
  version: 1,
  container_override: null,
  share_id: null,
};

beforeEach(() => {
  mockRouterRefresh.mockReset();
  mockToastSuccess.mockReset();
  mockToastError.mockReset();
  mockShowUndoToast.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
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

describe('AddToBlocklistAction visibility (ELIGIBLE_STATES)', () => {
  it('test_AddToBlocklistAction_when_status_queued_then_returns_null', () => {
    const { container } = render(
      wrap(<AddToBlocklistAction file={{ ...baseFile, status: 'queued' }} />),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('test_AddToBlocklistAction_when_status_encoding_then_returns_null', () => {
    const { container } = render(
      wrap(<AddToBlocklistAction file={{ ...baseFile, status: 'encoding' }} />),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('test_AddToBlocklistAction_when_status_blocklisted_then_returns_null', () => {
    const { container } = render(
      wrap(<AddToBlocklistAction file={{ ...baseFile, status: 'blocklisted' }} />),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('test_AddToBlocklistAction_when_status_pending_then_button_visible', () => {
    render(wrap(<AddToBlocklistAction file={baseFile} />));
    expect(screen.getByRole('button', { name: /Add to Blocklist/i })).toBeInTheDocument();
  });

  it('test_AddToBlocklistAction_when_status_failed_then_button_visible', () => {
    render(wrap(<AddToBlocklistAction file={{ ...baseFile, status: 'failed' }} />));
    expect(screen.getByRole('button', { name: /Add to Blocklist/i })).toBeInTheDocument();
  });
});

describe('AddToBlocklistAction P1 1-click flow', () => {
  it('test_AddToBlocklistAction_when_clicked_then_POST_fires_immediately', async () => {
    const fetchSpy = stubFetch({ ok: true });
    render(wrap(<AddToBlocklistAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Add to Blocklist/i }));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/library/7/blocklist',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ mode: 'file' }),
        }),
      );
    });
  });

  it('test_AddToBlocklistAction_when_200_then_toast_success_AND_router_refresh', async () => {
    stubFetch({ ok: true, status: 200 });
    render(wrap(<AddToBlocklistAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Add to Blocklist/i }));
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalled();
      expect(mockRouterRefresh).toHaveBeenCalled();
    });
  });

  it('test_AddToBlocklistAction_when_500_then_toast_error_AND_no_router_refresh', async () => {
    stubFetch({ ok: false, status: 500 });
    render(wrap(<AddToBlocklistAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Add to Blocklist/i }));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
    });
    expect(mockRouterRefresh).not.toHaveBeenCalled();
  });

  it('test_AddToBlocklistAction_when_network_throws_then_toast_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network');
      }),
    );
    render(wrap(<AddToBlocklistAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Add to Blocklist/i }));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalled();
    });
  });

  it('test_AddToBlocklistAction_when_no_undo_toast_invoked_P1_plain_toast', () => {
    stubFetch({ ok: true });
    render(wrap(<AddToBlocklistAction file={baseFile} />));
    fireEvent.click(screen.getByRole('button', { name: /Add to Blocklist/i }));
    expect(mockShowUndoToast).not.toHaveBeenCalled();
  });

  it('test_AddToBlocklistAction_when_clicked_3x_rapidly_then_only_one_POST_fires', async () => {
    let resolveFetch!: () => void;
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = () =>
            resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    render(wrap(<AddToBlocklistAction file={baseFile} />));
    const btn = screen.getByRole('button', { name: /Add to Blocklist/i });
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    resolveFetch();
    await waitFor(() => {
      expect(mockRouterRefresh).toHaveBeenCalled();
    });
  });
});
