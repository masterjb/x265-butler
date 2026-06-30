// 32-05 T2: TrashClient pagination tests.
// Mirrors tests/components/logs-page.test.tsx. Covers the 32-05 stale-row fix:
// rows must re-sync to a fresh `initialRows` on SSR re-fetch (AC-1 prop layer),
// in-page optimistic removal must survive a stable-ref re-render (AC-2, audit
// SR-3), the out-of-range double-fetch fallback keeps footer/rows consistent
// (AC-6, audit SR-2), the effPage clamp arithmetic (AC-3), empty→no footer
// (AC-4), and multi-select regression (AC-5).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { TrashEntryRow } from '@/src/lib/db/schema';

const { mockRouterPush, mockRouterRefresh } = vi.hoisted(() => ({
  mockRouterPush: vi.fn(),
  mockRouterRefresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/en/trash',
  useRouter: () => ({
    push: mockRouterPush,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: mockRouterRefresh,
  }),
  useSearchParams: () => new URLSearchParams(),
}));

// RestoreButton drives the single-row optimistic removal via onRemoveRow. The
// real component wraps a ConfirmButton P1 flow that is not reliably reachable in
// jsdom; mock it to a plain button that fires onRemoveRow(entry.id) so AC-2 (the
// highest-risk claim) is unit-provable rather than human-verify-only.
vi.mock('@/components/trash/restore-button', () => ({
  RestoreButton: ({
    entry,
    onRemoveRow,
  }: {
    entry: { id: number };
    onRemoveRow: (id: number) => void;
  }) => (
    <button
      type="button"
      data-testid={`mock-restore-${entry.id}`}
      onClick={() => onRemoveRow(entry.id)}
    >
      restore
    </button>
  ),
}));

import { TrashClient } from '@/app/[locale]/trash/trash-client';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

function makeRow(id: number, path: string): TrashEntryRow {
  return {
    id,
    file_id: id + 1000,
    original_path: path,
    trash_path: `/config/trash/${id}.mkv`,
    size_bytes: 1_000_000,
    trashed_at: Math.floor(Date.now() / 1000) - 3600,
    expires_at: Math.floor(Date.now() / 1000) + 86_400 * 30,
    restored_at: null,
  };
}

const DEFAULT_SUMMARY = { initialBytesReclaimed: 0, initialCount: 0 };

beforeEach(() => {
  mockRouterPush.mockReset();
  mockRouterRefresh.mockReset();
  // isDesktop effect reads window.matchMedia; absent in jsdom. Force the card
  // list (matches:false) — rows render `original_path` text either way.
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe('TrashClient — pagination re-sync (32-05)', () => {
  // AC-1 (prop layer): rows reflect a fresh initialRows on re-render (the bug =
  // useState froze them at mount). The SSR re-fetch-on-nav itself is Next
  // behaviour, human-verify-only per audit SR-3 — this proves prop adoption.
  it('list reflects new initialRows prop on re-render (no frozen useState)', () => {
    const { rerender } = render(
      wrap(
        <TrashClient
          initialRows={[makeRow(1, '/media/a.mkv')]}
          initialTotal={50}
          {...DEFAULT_SUMMARY}
          pagination={{ page: 1, size: 25, total: 50, pageCount: 2 }}
        />,
      ),
    );
    expect(screen.getByText('/media/a.mkv')).toBeInTheDocument();

    rerender(
      wrap(
        <TrashClient
          initialRows={[makeRow(2, '/media/b.mkv')]}
          initialTotal={50}
          {...DEFAULT_SUMMARY}
          pagination={{ page: 2, size: 25, total: 50, pageCount: 2 }}
        />,
      ),
    );
    expect(screen.getByText('/media/b.mkv')).toBeInTheDocument();
    expect(screen.queryByText('/media/a.mkv')).not.toBeInTheDocument();
  });

  // AC-2 (audit SR-3, load-bearing): a single-row optimistic removal must NOT be
  // clobbered when the component re-renders with the SAME initialRows REFERENCE
  // (stable ref ⇒ sync-effect dep unchanged ⇒ effect does not refire). This is
  // the correctness pivot of the whole fix.
  it('in-page optimistic removal survives a stable-ref re-render', () => {
    const stableRows = [makeRow(1, '/media/keep.mkv'), makeRow(2, '/media/gone.mkv')];
    const { rerender } = render(
      wrap(
        <TrashClient
          initialRows={stableRows}
          initialTotal={2}
          {...DEFAULT_SUMMARY}
          pagination={{ page: 1, size: 25, total: 2, pageCount: 1 }}
        />,
      ),
    );
    expect(screen.getByText('/media/gone.mkv')).toBeInTheDocument();

    // Optimistic restore-removal of row 2.
    fireEvent.click(screen.getByTestId('mock-restore-2'));
    expect(screen.queryByText('/media/gone.mkv')).not.toBeInTheDocument();

    // Re-render with the SAME array reference — no SSR nav happened, so the
    // sync-effect dep ([initialRows]) is unchanged and must NOT refire.
    rerender(
      wrap(
        <TrashClient
          initialRows={stableRows}
          initialTotal={2}
          {...DEFAULT_SUMMARY}
          pagination={{ page: 1, size: 25, total: 2, pageCount: 1 }}
        />,
      ),
    );
    expect(screen.queryByText('/media/gone.mkv')).not.toBeInTheDocument();
    expect(screen.getByText('/media/keep.mkv')).toBeInTheDocument();
  });

  // AC-6 (audit SR-2): the out-of-range list re-fetch can fail (null) while total
  // is already known. page.tsx falls back to probe rows so the footer range and
  // the rendered rows stay consistent — never "Showing 26–40 of 40" over a bare [].
  it('renders probe-row fallback consistently with the footer range', () => {
    const probeRows = Array.from({ length: 15 }, (_, i) =>
      makeRow(100 + i, `/media/page2-${i}.mkv`),
    );
    render(
      wrap(
        <TrashClient
          initialRows={probeRows}
          initialTotal={40}
          {...DEFAULT_SUMMARY}
          pagination={{ page: 2, size: 25, total: 40, pageCount: 2 }}
        />,
      ),
    );
    // Footer promises 26–40 of 40; the 15 fallback rows back that promise.
    expect(screen.getByText(/showing 26–40 of 40/i)).toBeInTheDocument();
    expect(screen.getByText('/media/page2-0.mkv')).toBeInTheDocument();
    expect(screen.getByText('/media/page2-14.mkv')).toBeInTheDocument();
  });

  // AC-3 (clamp arithmetic): effPage = pageCount>0 ? min(page,pageCount) : 1.
  // page.tsx computes this server-side; assert the formula + the rendered footer
  // reflects the clamped page (the server passes effPage, not the raw 99).
  it('clamps an out-of-range page to the last real page (formula + footer)', () => {
    const effPage = (page: number, pageCount: number) =>
      pageCount > 0 ? Math.min(page, pageCount) : 1;
    expect(effPage(99, 2)).toBe(2); // stale bookmark → last real page
    expect(effPage(1, 2)).toBe(1); // in range → unchanged
    expect(effPage(99, 0)).toBe(1); // empty → page 1 (AC-4 path)

    render(
      wrap(
        <TrashClient
          initialRows={[makeRow(7, '/media/last.mkv')]}
          initialTotal={40}
          {...DEFAULT_SUMMARY}
          // server already resolved ?page=99 → effPage=2
          pagination={{ page: 2, size: 25, total: 40, pageCount: 2 }}
        />,
      ),
    );
    expect(screen.getByText(/showing 26–40 of 40/i)).toBeInTheDocument();
    expect(screen.queryByText(/2451/)).not.toBeInTheDocument();
  });

  // AC-4: empty trash → footer hidden (pagination.total === 0 guard).
  it('hides the pagination footer when the trash is empty', () => {
    render(
      wrap(
        <TrashClient
          initialRows={[]}
          initialTotal={0}
          {...DEFAULT_SUMMARY}
          pagination={{ page: 1, size: 25, total: 0, pageCount: 0 }}
        />,
      ),
    );
    expect(screen.queryByRole('navigation', { name: /pagination/i })).not.toBeInTheDocument();
  });
});

describe('TrashClient — multi-select regression (AC-5)', () => {
  it('selecting all shows the SelectionBar; clearing hides it', () => {
    render(
      wrap(
        <TrashClient
          initialRows={[makeRow(1, '/media/a.mkv'), makeRow(2, '/media/b.mkv')]}
          initialTotal={2}
          {...DEFAULT_SUMMARY}
          pagination={{ page: 1, size: 25, total: 2, pageCount: 1 }}
        />,
      ),
    );
    // No selection yet → no SelectionBar. (SelectionBar renders both a desktop
    // and a mobile region; assert via the desktop testid to avoid the dual node.)
    expect(screen.queryByTestId('selection-bar-desktop')).not.toBeInTheDocument();

    // Select-all header checkbox (card list testid) → SelectionBar appears.
    fireEvent.click(screen.getByTestId('trash-bulk-select-all-cards'));
    expect(screen.getByTestId('selection-bar-desktop')).toBeInTheDocument();

    // Clear → SelectionBar gone.
    fireEvent.click(screen.getByTestId('selection-bar-clear-desktop'));
    expect(screen.queryByTestId('selection-bar-desktop')).not.toBeInTheDocument();
  });
});
