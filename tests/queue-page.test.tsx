import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { ThemeProvider } from '@/components/app-shell/theme-provider';
import en from '@/messages/en.json';
import type { JobRow } from '@/src/lib/db/schema';

// Mock engine-events hooks used in QueueClient children.
const {
  mockUsePausedState,
  mockUseActiveJob,
  mockUseActiveJobs,
  mockUseRecentJobs,
  mockUseQueueCounts,
  mockUseEngineEventsDisconnected,
} = vi.hoisted(() => ({
  mockUsePausedState: vi.fn<() => boolean>(() => false),
  mockUseActiveJob: vi.fn(() => null),
  // 36-02: QueueClient now consumes useActiveJobs (multi-slot). Default empty.
  mockUseActiveJobs: vi.fn<() => unknown[]>(() => []),
  mockUseRecentJobs: vi.fn(() => []),
  mockUseQueueCounts: vi.fn(() => ({ activeJobs: 0, pendingJobs: 0 })),
  mockUseEngineEventsDisconnected: vi.fn(() => false),
}));

vi.mock('@/src/lib/api/engine-events-client', () => ({
  usePausedState: mockUsePausedState,
  useActiveJob: mockUseActiveJob,
  useActiveJobs: mockUseActiveJobs,
  useRecentJobs: mockUseRecentJobs,
  useQueueCounts: mockUseQueueCounts,
  useEngineEventsDisconnected: mockUseEngineEventsDisconnected,
}));

const {
  mockListActive,
  mockListRecent,
  mockListRecentPaginated,
  mockSettingsGet,
  mockGetById,
  mockIsPaused,
} = vi.hoisted(() => ({
  mockListActive: vi.fn<() => JobRow[]>(() => []),
  mockListRecent: vi.fn<() => JobRow[]>(() => []),
  // 05-bonus: paginated variant; default returns empty + 0 total to match
  // existing mockListRecent default (no rows). Tests can override.
  mockListRecentPaginated: vi.fn<() => { rows: JobRow[]; total: number }>(() => ({
    rows: [],
    total: 0,
  })),
  mockSettingsGet: vi.fn<(key: string) => string | undefined>(() => undefined),
  mockGetById: vi.fn<(id: number) => unknown>(() => undefined),
  mockIsPaused: vi.fn(() => false),
}));

vi.mock('@/src/lib/db', () => ({
  jobRepo: () => ({
    listActive: mockListActive,
    listRecent: mockListRecent,
    listRecentPaginated: mockListRecentPaginated,
    peekQueued: vi.fn<(limit: number) => JobRow[]>(() => []),
  }),
  fileRepo: () => ({
    getById: mockGetById,
  }),
  settingRepo: () => ({
    get: mockSettingsGet,
  }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/encode', () => ({
  isPaused: mockIsPaused,
}));

// Mock fetch for file detail lazy load in QueueClient.
(globalThis as { fetch?: unknown }).fetch = vi.fn().mockResolvedValue({ ok: false });

import QueuePage from '@/app/[locale]/queue/page';

function wrapIntl(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
        {ui}
      </ThemeProvider>
    </NextIntlClientProvider>
  );
}

async function renderPage() {
  const ui = await QueuePage({ searchParams: Promise.resolve({}) });
  return render(wrapIntl(ui));
}

describe('QueuePage (Server + Client integration)', () => {
  beforeEach(() => {
    mockListActive.mockReset();
    mockListRecent.mockReset();
    mockListRecentPaginated.mockReset();
    mockSettingsGet.mockReset();
    mockGetById.mockReset();
    mockIsPaused.mockReset();
    mockUsePausedState.mockReturnValue(false);
    mockUseActiveJob.mockReturnValue(null);
    mockUseActiveJobs.mockReturnValue([]);
    mockUseRecentJobs.mockReturnValue([]);
    mockUseQueueCounts.mockReturnValue({ activeJobs: 0, pendingJobs: 0 });
    mockUseEngineEventsDisconnected.mockReturnValue(false);
    mockListActive.mockReturnValue([]);
    mockListRecent.mockReturnValue([]);
    mockListRecentPaginated.mockReturnValue({ rows: [], total: 0 });
    mockIsPaused.mockReturnValue(false);
    mockSettingsGet.mockReturnValue(undefined);
  });

  it('test_QueuePage_when_rendered_then_shows_queue_title', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { name: en.queue.title })).toBeInTheDocument();
  });

  it('test_QueuePage_when_no_active_job_then_shows_idle_headline', async () => {
    await renderPage();
    expect(screen.getByText(en.queue.active.idleHeadline)).toBeInTheDocument();
  });

  // 05-09 AC-6: CancelAllButton mounts in the queue page header.
  it('test_QueuePage_when_rendered_then_cancel_all_button_in_header', async () => {
    await renderPage();
    // Disabled-state still renders aria-label = button copy.
    expect(
      screen.getByRole('button', { name: new RegExp(en.queue.cancel_all.button, 'i') }),
    ).toBeInTheDocument();
  });

  it('test_QueuePage_when_no_recent_jobs_then_shows_empty_state', async () => {
    // 05-12 B-layout: empty state lives in BOTH panes — Pending shows "Queue empty"
    // (pending.empty.title), Completed shows "No completed jobs yet." (completed.empty.helper).
    await renderPage();
    // Both panes (md-grid + mobile-stacked) render simultaneously in jsdom (CSS
    // `hidden` is not effective without layout) — getAllByText returns 2.
    expect(screen.getAllByText(en.queue.pending.empty.title).length).toBeGreaterThan(0);
  });

  // 36-02 helpers: minimal JobRow + FileRow fixtures.
  function jobFix(over: Partial<JobRow> = {}): JobRow {
    return {
      id: 1,
      file_id: 1,
      status: 'encoding',
      encoder: 'libx265',
      started_at: null,
      finished_at: null,
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
    } as JobRow;
  }

  // 36-02 AC-1 / AC-5: encoding rows are SSR-seeded as multi-row panel.
  it('test_QueuePage_when_two_encoding_jobs_then_seeds_two_active_rows', async () => {
    mockListActive.mockReturnValue([
      jobFix({ id: 10, file_id: 1, status: 'encoding' }),
      jobFix({ id: 11, file_id: 2, status: 'encoding', encoder: 'qsv' }),
    ]);
    mockUseQueueCounts.mockReturnValue({ activeJobs: 2, pendingJobs: 0 });
    mockGetById.mockImplementation((id: number) =>
      id === 1
        ? { id: 1, path: '/m/a.mkv', duration_seconds: 120, size_bytes: 1000 }
        : { id: 2, path: '/m/b.mkv', duration_seconds: 120, size_bytes: 2000 },
    );
    await renderPage();
    expect(
      screen.getByText(en.queue.active.panelTitle.replace('{count}', '2')),
    ).toBeInTheDocument();
    expect(screen.getByText('a.mkv')).toBeInTheDocument();
    expect(screen.getByText('b.mkv')).toBeInTheDocument();
  });

  // 36-02 AC-5: queued-but-not-encoding rows are NOT seeded as active bars even
  // when counts.activeJobs > 0 (counts = queued+encoding). Encoding-only seed
  // empty → idle.
  it('test_QueuePage_when_only_queued_active_then_no_phantom_active_row', async () => {
    mockListActive.mockReturnValue([jobFix({ id: 20, file_id: 5, status: 'queued' })]);
    // counts.activeJobs counts the queued row → 1, but nothing is encoding.
    mockUseQueueCounts.mockReturnValue({ activeJobs: 1, pendingJobs: 0 });
    mockGetById.mockReturnValue({ id: 5, path: '/m/q.mkv', duration_seconds: 60, size_bytes: 10 });
    await renderPage();
    // Idle MoonStar headline shows; no "Active (1)" panel header.
    expect(screen.getByText(en.queue.active.idleHeadline)).toBeInTheDocument();
    expect(screen.queryByText(en.queue.active.panelTitle.replace('{count}', '1'))).toBeNull();
  });

  it('test_QueuePage_when_disconnected_then_shows_banner', async () => {
    mockUseEngineEventsDisconnected.mockReturnValue(true);
    await renderPage();
    expect(screen.getByText(en.queue.disconnected.banner)).toBeInTheDocument();
  });

  // 27-03 AC-4: pin the md+ two-column grid template (50/50 equal split).
  // jsdom serializes BOTH panes (CSS `hidden` is ineffective without layout — see
  // the empty-state test above where getAllByText returns both panes), so the
  // md-grid container markup is reachable via container.innerHTML.
  it('test_QueuePage_when_rendered_then_md_grid_is_50_50_equal_split', async () => {
    const { container } = await renderPage();
    expect(container.innerHTML).toContain('minmax(0,1fr)_minmax(0,1fr)');
    // The old pending-big-left / completed-360px-cap template must be gone.
    expect(container.innerHTML).not.toContain('minmax(0,360px)');
  });
});
