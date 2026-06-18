// 05-03 T2.J: LogsClient tests.
// Phase 5 Plan 05-03 — AC-6 + AC-7 + audit S8.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { JobLogEntry } from '@/components/logs/jobs-list';

const { mockRouterReplace } = vi.hoisted(() => ({
  mockRouterReplace: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/en/logs',
  useRouter: () => ({
    replace: mockRouterReplace,
    push: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

// EventSource stub — log-viewer uses useSseSubscription for live mode.
const MockEventSource = vi.fn().mockImplementation(() => ({
  onopen: null,
  onmessage: null,
  onerror: null,
  close: vi.fn(),
}));
vi.stubGlobal('EventSource', MockEventSource);

// fetch stub — log-viewer + container-panel call authFetch.
const fetchMock = vi.fn(
  async () =>
    new Response(JSON.stringify({ lines: [], totalLines: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
);
vi.stubGlobal('fetch', fetchMock);

import { LogsClient } from '@/app/[locale]/logs/logs-client';

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const SAMPLE_ENTRIES: JobLogEntry[] = [
  {
    id: 1,
    fileId: 100,
    status: 'done-smaller',
    encoder: 'libx265',
    createdAt: Math.floor(Date.now() / 1000) - 60,
    finishedAt: Math.floor(Date.now() / 1000) - 10,
    filePath: '/media/movie.mkv',
    fileBasename: 'movie.mkv',
    durationMs: 50_000,
  },
  {
    id: 2,
    fileId: 101,
    status: 'encoding',
    encoder: 'libx265',
    createdAt: Math.floor(Date.now() / 1000) - 5,
    finishedAt: null,
    filePath: '/media/show.mkv',
    fileBasename: 'show.mkv',
    durationMs: null,
  },
];

// 32-04: default pagination prop for cases that don't assert on it (≤50 jobs,
// single page — control still renders but is inert).
const DEFAULT_PAGINATION = { page: 1, size: 50, total: 0, pageCount: 0 };

beforeEach(() => {
  mockRouterReplace.mockReset();
  fetchMock.mockClear();
  MockEventSource.mockClear();
  // Radix Select pointer plumbing missing in jsdom (size selector).
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe('LogsClient — Per-Job tab', () => {
  it('renders both tab triggers', () => {
    render(
      wrap(
        <LogsClient
          initialEntries={SAMPLE_ENTRIES}
          initialTab="per-job"
          initialJobId={null}
          initialFormat="raw"
          initialLines={100}
          pagination={DEFAULT_PAGINATION}
        />,
      ),
    );
    expect(screen.getByRole('tab', { name: /per job/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /container/i })).toBeInTheDocument();
  });

  it('renders the recent-jobs list with both entries', () => {
    render(
      wrap(
        <LogsClient
          initialEntries={SAMPLE_ENTRIES}
          initialTab="per-job"
          initialJobId={null}
          initialFormat="raw"
          initialLines={100}
          pagination={DEFAULT_PAGINATION}
        />,
      ),
    );
    expect(screen.getByText('movie.mkv')).toBeInTheDocument();
    expect(screen.getByText('show.mkv')).toBeInTheDocument();
  });

  it('renders empty-state when entries array is empty', () => {
    render(
      wrap(
        <LogsClient
          initialEntries={[]}
          initialTab="per-job"
          initialJobId={null}
          initialFormat="raw"
          initialLines={100}
          pagination={DEFAULT_PAGINATION}
        />,
      ),
    );
    expect(screen.getByText(/No jobs with logs yet/i)).toBeInTheDocument();
  });

  it('clicking a job updates URL via router.replace', () => {
    render(
      wrap(
        <LogsClient
          initialEntries={SAMPLE_ENTRIES}
          initialTab="per-job"
          initialJobId={null}
          initialFormat="raw"
          initialLines={100}
          pagination={DEFAULT_PAGINATION}
        />,
      ),
    );
    fireEvent.click(screen.getByText('movie.mkv'));
    expect(mockRouterReplace).toHaveBeenCalledWith(
      expect.stringContaining('jobId=1'),
      expect.objectContaining({ scroll: false }),
    );
  });

  it('selected job renders LogViewer with filename in header', () => {
    render(
      wrap(
        <LogsClient
          initialEntries={SAMPLE_ENTRIES}
          initialTab="per-job"
          initialJobId="1"
          initialFormat="raw"
          initialLines={100}
          pagination={DEFAULT_PAGINATION}
        />,
      ),
    );
    // movie.mkv appears both in list AND viewer header.
    const matches = screen.getAllByText('movie.mkv');
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('LogsClient — Per-Job pagination (32-04)', () => {
  // AC-2 / AC-1 surface: the shared control renders with a sane "Showing" range.
  it('renders the pagination control with the Showing range on the Per-Job tab', () => {
    render(
      wrap(
        <LogsClient
          initialEntries={SAMPLE_ENTRIES}
          initialTab="per-job"
          initialJobId={null}
          initialFormat="raw"
          initialLines={100}
          pagination={{ page: 1, size: 50, total: 120, pageCount: 3 }}
        />,
      ),
    );
    expect(screen.getByText(/showing 1–50 of 120/i)).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: /pagination/i })).toBeInTheDocument();
  });

  // AC-1: clicking a page button drives the URL via router.replace with page=2.
  it('clicking page 2 calls router.replace with page=2', () => {
    render(
      wrap(
        <LogsClient
          initialEntries={SAMPLE_ENTRIES}
          initialTab="per-job"
          initialJobId={null}
          initialFormat="raw"
          initialLines={100}
          pagination={{ page: 1, size: 50, total: 120, pageCount: 3 }}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    expect(mockRouterReplace).toHaveBeenCalledWith(
      expect.stringContaining('page=2'),
      expect.objectContaining({ scroll: false }),
    );
  });

  // AC-3: changing page-size resets to page 1 (size=100, no stale page param).
  it('changing size to 100 calls replace with size=100 and drops page', async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <LogsClient
          initialEntries={SAMPLE_ENTRIES}
          initialTab="per-job"
          initialJobId={null}
          initialFormat="raw"
          initialLines={100}
          pagination={{ page: 3, size: 50, total: 120, pageCount: 3 }}
        />,
      ),
    );
    await user.click(screen.getByLabelText(/page size/i));
    await user.click(screen.getByRole('option', { name: '100' }));
    const call = mockRouterReplace.mock.calls.at(-1);
    expect(call?.[0]).toContain('size=100');
    expect(call?.[0]).not.toContain('page=');
  });

  // AC-4: entries follow props, not frozen useState — re-render with a NEW
  // initialEntries prop and assert the list reflects the new page's rows.
  it('list reflects new initialEntries prop on re-render (no frozen useState)', () => {
    const jobA: JobLogEntry = {
      ...SAMPLE_ENTRIES[0],
      id: 10,
      filePath: '/media/a.mkv',
      fileBasename: 'a.mkv',
    };
    const jobB: JobLogEntry = {
      ...SAMPLE_ENTRIES[0],
      id: 20,
      filePath: '/media/b.mkv',
      fileBasename: 'b.mkv',
    };
    const { rerender } = render(
      wrap(
        <LogsClient
          initialEntries={[jobA]}
          initialTab="per-job"
          initialJobId={null}
          initialFormat="raw"
          initialLines={100}
          pagination={{ page: 1, size: 50, total: 100, pageCount: 2 }}
        />,
      ),
    );
    expect(screen.getByText('a.mkv')).toBeInTheDocument();
    rerender(
      wrap(
        <LogsClient
          initialEntries={[jobB]}
          initialTab="per-job"
          initialJobId={null}
          initialFormat="raw"
          initialLines={100}
          pagination={{ page: 2, size: 50, total: 100, pageCount: 2 }}
        />,
      ),
    );
    expect(screen.getByText('b.mkv')).toBeInTheDocument();
    expect(screen.queryByText('a.mkv')).not.toBeInTheDocument();
  });

  // AC-5: pagination is per-job only — absent on the Container tab.
  it('does not render pagination on the Container tab', () => {
    render(
      wrap(
        <LogsClient
          initialEntries={SAMPLE_ENTRIES}
          initialTab="container"
          initialJobId={null}
          initialFormat="raw"
          initialLines={100}
          pagination={{ page: 1, size: 50, total: 120, pageCount: 3 }}
        />,
      ),
    );
    expect(screen.queryByRole('navigation', { name: /pagination/i })).not.toBeInTheDocument();
  });

  // AC-7 (audit SR-1): a server-clamped out-of-range page renders a sane range,
  // never a garbage "4901–40" header.
  it('renders a clamped page sanely (Showing 1–40 of 40, never 4901–40)', () => {
    render(
      wrap(
        <LogsClient
          initialEntries={SAMPLE_ENTRIES}
          initialTab="per-job"
          initialJobId={null}
          initialFormat="raw"
          initialLines={100}
          pagination={{ page: 1, size: 50, total: 40, pageCount: 1 }}
        />,
      ),
    );
    expect(screen.getByText(/showing 1–40 of 40/i)).toBeInTheDocument();
    expect(screen.queryByText(/4901/)).not.toBeInTheDocument();
  });
});

describe('LogsClient — audit S8 reduced-motion', () => {
  it('LiveStatusIndicator dot has motion-safe:animate-pulse class', () => {
    render(
      wrap(
        <LogsClient
          initialEntries={SAMPLE_ENTRIES}
          initialTab="per-job"
          initialJobId="2"
          initialFormat="raw"
          initialLines={100}
          pagination={DEFAULT_PAGINATION}
        />,
      ),
    );
    // The viewer header includes a LiveStatusIndicator for active job.
    const status = screen.getByRole('status');
    expect(status).toBeInTheDocument();
    const dot = status.querySelector('span[data-state]');
    expect(dot?.className ?? '').toMatch(/motion-safe:animate-pulse/);
  });
});

describe('LogsClient — Container tab', () => {
  it('renders container panel toolbar elements', () => {
    render(
      wrap(
        <LogsClient
          initialEntries={SAMPLE_ENTRIES}
          initialTab="container"
          initialJobId={null}
          initialFormat="raw"
          initialLines={100}
          pagination={DEFAULT_PAGINATION}
        />,
      ),
    );
    // RadioGroup + Switch + Refresh button + Download anchor present.
    expect(screen.getAllByText(/refresh/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Auto-refresh/i)).toBeInTheDocument();
  });
});
