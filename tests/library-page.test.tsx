/*
 * Server Component test pattern (audit-added S8)
 * --------------------------------------------------
 * Server Components are async functions, not React class trees with hooks.
 * To test them, invoke the page function directly with the props Next.js
 * would supply at runtime:
 *
 *   await PageComponent({
 *     params: Promise.resolve({ locale: 'en' }),
 *     searchParams: Promise.resolve({ status: 'pending' }),
 *   })
 *
 * Then render the resolved React tree via React Testing Library and query
 * for expected elements. Mock `@/src/lib/db` via `vi.mock` with a factory
 * that returns stub `fileRepo()` + `settingRepo()` returning fixture data.
 *
 * The Client Component below the page is mounted into the same tree, so
 * client-only behaviors (router push, URL state) require additional mocks
 * via the global `next/navigation` mock in tests/setup.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { ThemeProvider } from '@/components/app-shell/theme-provider';
import en from '@/messages/en.json';
import type { FileRow } from '@/src/lib/db/schema';
import type { CountByStatus, ListResult } from '@/src/lib/db/repos/file';

const {
  mockListPaginated,
  mockCountByStatus,
  mockSettingsGet,
  mockStatSync,
  mockRouterPush,
  // 50-04: batched file-pinned blocklist lookup behind the blocklistEntryIds prop.
  mockFindByFileIds,
} = vi.hoisted(() => ({
  mockListPaginated: vi.fn<(opts: unknown) => ListResult>(),
  mockCountByStatus: vi.fn<() => CountByStatus>(),
  mockSettingsGet: vi.fn<(key: string) => string | undefined>(),
  mockStatSync: vi.fn(),
  mockRouterPush: vi.fn(),
  mockFindByFileIds: vi.fn(() => [] as Array<{ id: number; file_id: number | null }>),
}));

vi.mock('@/src/lib/db', () => ({
  fileRepo: () => ({
    listPaginated: mockListPaginated,
    countByStatus: mockCountByStatus,
    // 14-03: ShareFilterPill data source — empty here; pill stays hidden.
    countOrphaned: () => 0,
  }),
  settingRepo: () => ({ get: mockSettingsGet }),
  blocklistRepo: () => ({ findByFileIds: mockFindByFileIds }),
  shareRepo: () => ({
    listAll: () => [],
  }),
  default: {},
}));

vi.mock('node:fs', () => ({
  default: { statSync: (...a: unknown[]) => mockStatSync(...a) },
  statSync: (...a: unknown[]) => mockStatSync(...a),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/en/library',
  useRouter: () => ({
    push: mockRouterPush,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

import LibraryPage from '@/app/[locale]/library/page';

const emptyCounts: CountByStatus = {
  all: 0,
  pending: 0,
  queued: 0,
  encoding: 0,
  'done-smaller': 0,
  'done-larger': 0,
  'skipped-codec': 0,
  'skipped-bitrate': 0,
  'skipped-suffix': 0,
  'skipped-tag': 0,
  'skipped-sidecar': 0,
  'skipped-blocklist': 0,
  failed: 0,
  blocklisted: 0,
  interrupted: 0,
  vanished: 0,
  // 05-13: 3-bucket verdict + sidecar-driven skip evolution.
  'done-not-worth': 0,
  'done-already-evaluated': 0,
};

function row(over: Partial<FileRow> = {}): FileRow {
  return {
    id: 1,
    path: '/media/movie.mp4',
    size_bytes: 1024,
    mtime: 1_700_000_000,
    content_hash: 'a'.repeat(64),
    codec: 'h264',
    bitrate: 5_000_000,
    duration_seconds: 60,
    width: 1920,
    height: 1080,
    container: 'mp4',
    status: 'pending',
    last_scanned_at: Math.floor(Date.now() / 1000) - 60,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    version: 0,
    container_override: null,
    share_id: null,
    ...over,
  };
}

function wrapWithIntl(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
        {ui}
      </ThemeProvider>
    </NextIntlClientProvider>
  );
}

async function renderPage(searchParams: Record<string, string> = {}) {
  const ui = await LibraryPage({
    params: Promise.resolve({ locale: 'en' }),
    searchParams: Promise.resolve(searchParams),
  });
  return render(wrapWithIntl(ui));
}

describe('LibraryPage (Server + Client integration)', () => {
  beforeEach(() => {
    mockListPaginated.mockReset();
    mockCountByStatus.mockReset();
    mockSettingsGet.mockReset();
    mockStatSync.mockReset();
    mockRouterPush.mockReset();
    mockFindByFileIds.mockReset();
    mockFindByFileIds.mockReturnValue([]);
    mockSettingsGet.mockReturnValue('/media');
    mockStatSync.mockReturnValue({ isDirectory: () => true });
  });

  it('test_LibraryPage_when_rows_present_then_renders_table_with_paths', async () => {
    mockListPaginated.mockReturnValue({ rows: [row({ id: 1, path: '/media/foo.mp4' })], total: 1 });
    mockCountByStatus.mockReturnValue({ ...emptyCounts, all: 1, pending: 1 });
    await renderPage();
    // Both table (≥md) and card list (<md) render simultaneously and toggle
    // via Tailwind's `hidden`/`md:hidden`, so the path appears twice in DOM.
    expect(screen.getAllByText('/media/foo.mp4').length).toBeGreaterThan(0);
  });

  it('test_LibraryPage_when_db_empty_then_renders_empty_state_with_scan_cta', async () => {
    mockListPaginated.mockReturnValue({ rows: [], total: 0 });
    mockCountByStatus.mockReturnValue(emptyCounts);
    await renderPage();
    expect(screen.getByRole('heading', { name: /no files scanned yet/i })).toBeInTheDocument();
    // Two "Scan now" buttons render (the topbar one + the EmptyState CTA);
    // either is acceptable evidence of the CTA being available.
    const scanCtas = screen.getAllByRole('button', { name: /scan now/i });
    expect(scanCtas.length).toBeGreaterThan(0);
  });

  // audit-added S3: scan_root missing → CTA gated, "Configure path" link shown
  it('test_LibraryPage_when_scan_root_missing_then_configure_path_link_shown', async () => {
    mockStatSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    mockListPaginated.mockReturnValue({ rows: [], total: 0 });
    mockCountByStatus.mockReturnValue(emptyCounts);
    await renderPage();
    expect(screen.getByRole('link', { name: /configure scan path/i })).toBeInTheDocument();
  });

  // audit-added S7: URL state restoration — Server Component reads searchParams
  it('test_LibraryPage_when_searchParams_provided_then_repo_called_with_those_filters', async () => {
    mockListPaginated.mockReturnValue({ rows: [], total: 0 });
    mockCountByStatus.mockReturnValue(emptyCounts);
    await renderPage({ status: 'failed', page: '3', q: 'movie' });
    const opts = mockListPaginated.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.status).toBe('failed');
    expect(opts.page).toBe(3);
    expect(opts.q).toBe('movie');
  });

  it('test_LibraryPage_when_filtered_with_zero_results_then_filtered_empty_state', async () => {
    mockListPaginated.mockReturnValue({ rows: [], total: 0 });
    mockCountByStatus.mockReturnValue({ ...emptyCounts, all: 5, pending: 5 });
    await renderPage({ status: 'failed' });
    expect(screen.getByRole('heading', { name: /no matches/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear filters/i })).toBeInTheDocument();
  });

  // audit-added M3: filter change resets page=1
  it('test_LibraryClient_when_filter_chip_clicked_then_router_push_resets_page_to_1', async () => {
    mockListPaginated.mockReturnValue({ rows: [row()], total: 200 });
    mockCountByStatus.mockReturnValue({ ...emptyCounts, all: 200, pending: 100, failed: 100 });
    await renderPage({ page: '5' });
    // Click the Failed filter chip
    const failedChip = screen.getByRole('radio', { name: /failed/i });
    fireEvent.click(failedChip);
    expect(mockRouterPush).toHaveBeenCalled();
    const calledUrl = mockRouterPush.mock.calls[0][0] as string;
    // page=5 should be removed (filter change resets); status=failed should be present
    expect(calledUrl).toContain('status=failed');
    expect(calledUrl).not.toContain('page=5');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 50-04 AC-27: WIRING, not component behaviour.
//
// The blocklistEntryIds prop is OPTIONAL with an empty default in all three
// consumers — necessary so the existing render tests keep passing, but it means
// a FORGOTTEN prop hand-off is invisible: the component tests pass the prop
// themselves and stay green while the feature is dead in the running app.
//
// These tests drive the real Server Component, so they fail if page.tsx stops
// building the map, or if LibraryClient stops handing it to the table, the card
// list, or the detail panel.
// ─────────────────────────────────────────────────────────────────────────────
describe('LibraryPage — blocklistEntryIds wiring (50-04 AC-27)', () => {
  beforeEach(() => {
    mockListPaginated.mockReset();
    mockCountByStatus.mockReset();
    mockSettingsGet.mockReset();
    mockStatSync.mockReset();
    mockFindByFileIds.mockReset();
    mockFindByFileIds.mockReturnValue([]);
    mockSettingsGet.mockReturnValue('/media');
    mockStatSync.mockReturnValue({ isDirectory: () => true });
  });

  function seedBlocklistedRow() {
    mockListPaginated.mockReturnValue({
      rows: [row({ id: 5, path: '/media/blocked.mkv', status: 'blocklisted' })],
      total: 1,
    });
    mockCountByStatus.mockReturnValue({ ...emptyCounts, all: 1, blocklisted: 1 });
  }

  it('test_LibraryPage_when_blocklisted_row_pinned_then_page_queries_only_that_id', async () => {
    seedBlocklistedRow();
    mockFindByFileIds.mockReturnValue([{ id: 91, file_id: 5 }]);
    await renderPage();
    expect(mockFindByFileIds).toHaveBeenCalledWith([5]);
  });

  // Table (hidden md:block) and card list (md:hidden) both render into the DOM,
  // so a correctly wired hand-off yields exactly two buttons — one per layout.
  it('test_LibraryPage_when_pinned_entry_then_unblock_button_in_table_AND_card_list', async () => {
    seedBlocklistedRow();
    mockFindByFileIds.mockReturnValue([{ id: 91, file_id: 5 }]);
    await renderPage();
    // Anchored name: the table ROW also carries role="button" (click-to-open)
    // and its accessible name contains the nested button's label, so an
    // unanchored /Unblock/ would count the row as a third match.
    expect(screen.getAllByRole('button', { name: /^Unblock$/ })).toHaveLength(2);
  });

  it('test_LibraryPage_when_row_opened_then_unblock_button_also_in_detail_panel', async () => {
    seedBlocklistedRow();
    mockFindByFileIds.mockReturnValue([{ id: 91, file_id: 5 }]);
    await renderPage();

    // Opening the row mounts DetailBody, the third consumer of the map. The
    // panel is a modal, so the table and the card list go aria-hidden and drop
    // out of the accessibility tree — the single remaining match IS the panel's,
    // which is exactly the hand-off under test.
    fireEvent.click(screen.getAllByText('/media/blocked.mkv')[0]);

    const inPanel = await screen.findAllByRole('button', { name: /^Unblock$/ });
    expect(inPanel).toHaveLength(1);
    expect(inPanel[0].closest('[role="dialog"]')).not.toBeNull();
  });

  // AC-9 at the wiring level: pattern-blocked row → no entry → no button, and
  // the chip carries the reason instead.
  it('test_LibraryPage_when_blocklisted_without_entry_then_no_button_but_chip_title', async () => {
    seedBlocklistedRow();
    mockFindByFileIds.mockReturnValue([]);
    await renderPage();

    expect(screen.queryByRole('button', { name: /^Unblock$/ })).toBeNull();
    const chips = document.querySelectorAll('[data-status="blocklisted"]');
    expect(chips.length).toBeGreaterThan(0);
    expect(chips[0].getAttribute('title')).toBe(en.library.unblocklist.chipTitle.noEntry);
  });

  // AC-8: no blocklisted row on the page ⇒ the lookup must not run at all.
  it('test_LibraryPage_when_no_blocklisted_row_then_findByFileIds_never_called', async () => {
    mockListPaginated.mockReturnValue({ rows: [row({ id: 1 })], total: 1 });
    mockCountByStatus.mockReturnValue({ ...emptyCounts, all: 1, pending: 1 });
    await renderPage();
    expect(mockFindByFileIds).not.toHaveBeenCalled();
  });
});
