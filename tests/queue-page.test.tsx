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
  mockUseRecentJobs,
  mockUseQueueCounts,
  mockUseEngineEventsDisconnected,
} = vi.hoisted(() => ({
  mockUsePausedState: vi.fn<() => boolean>(() => false),
  mockUseActiveJob: vi.fn(() => null),
  mockUseRecentJobs: vi.fn(() => []),
  mockUseQueueCounts: vi.fn(() => ({ activeJobs: 0, pendingJobs: 0 })),
  mockUseEngineEventsDisconnected: vi.fn(() => false),
}));

vi.mock('@/src/lib/api/engine-events-client', () => ({
  usePausedState: mockUsePausedState,
  useActiveJob: mockUseActiveJob,
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
  mockGetById: vi.fn(() => undefined),
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

  it('test_QueuePage_when_disconnected_then_shows_banner', async () => {
    mockUseEngineEventsDisconnected.mockReturnValue(true);
    await renderPage();
    expect(screen.getByText(en.queue.disconnected.banner)).toBeInTheDocument();
  });
});
