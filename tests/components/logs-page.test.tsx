// 05-03 T2.J: LogsClient tests.
// Phase 5 Plan 05-03 — AC-6 + AC-7 + audit S8.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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

beforeEach(() => {
  mockRouterReplace.mockReset();
  fetchMock.mockClear();
  MockEventSource.mockClear();
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
        />,
      ),
    );
    // movie.mkv appears both in list AND viewer header.
    const matches = screen.getAllByText('movie.mkv');
    expect(matches.length).toBeGreaterThanOrEqual(2);
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
        />,
      ),
    );
    // RadioGroup + Switch + Refresh button + Download anchor present.
    expect(screen.getAllByText(/refresh/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Auto-refresh/i)).toBeInTheDocument();
  });
});
