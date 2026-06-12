import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import type { RecentActivityRow } from '@/src/lib/db';

// Mock engine-events hooks consumed by LiveQueueCard.
const {
  mockUseActiveJob,
  mockUseQueueCounts,
  mockUseEngineEventsDisconnected,
  mockUseRecentJobs,
  mockUsePausedState,
} = vi.hoisted(() => ({
  mockUseActiveJob: vi.fn(() => null),
  mockUseQueueCounts: vi.fn(() => ({ activeJobs: 0, pendingJobs: 0 })),
  mockUseEngineEventsDisconnected: vi.fn(() => false),
  mockUseRecentJobs: vi.fn(() => []),
  mockUsePausedState: vi.fn(() => false),
}));

vi.mock('@/src/lib/api/engine-events-client', () => ({
  useActiveJob: mockUseActiveJob,
  useQueueCounts: mockUseQueueCounts,
  useEngineEventsDisconnected: mockUseEngineEventsDisconnected,
  useRecentJobs: mockUseRecentJobs,
  usePausedState: mockUsePausedState,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { DashboardClient } from '@/app/[locale]/dashboard/dashboard-client';

const REPO_ROOT = join(__dirname, '..', '..');

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const FIXTURE_STATS = {
  kpis: {
    totalSaved: 5_242_880,
    filesProcessed: 5,
    avgSavingsPercent: 50,
    cumulativeThroughputPerDay: 100_000,
    queueDepth: { pending: 3, encoding: 1 },
    byEncoder: { libx265: { count: 5, saved: 5_242_880 } },
  },
  trend: Array.from({ length: 30 }, (_, i) => {
    const day = new Date(2026, 3, i + 1);
    return {
      date: day.toISOString().slice(0, 10),
      bytesIn: 1000 * (i + 1),
      bytesOut: 500 * (i + 1),
      savings: 500 * (i + 1),
    };
  }),
  recentActivity: [
    {
      id: 1,
      file_id: 1,
      status: 'done',
      started_at: 1_700_000_000,
      finished_at: 1_700_000_100,
      encoder: 'libx265',
      crf: 23,
      queue_position: 0,
      bytes_in: 1000,
      bytes_out: 500,
      duration_ms: 100,
      exit_code: null,
      error_msg: null,
      log_tail: null,
      created_at: 1_700_000_000,
      // 07-01: LEFT JOIN file surfaces basename for the row's clickable Link.
      file_path: '/mnt/user/movies/Test File.mkv',
    } satisfies RecentActivityRow,
  ],
  // 07-02 A4: Library codec mix + container distribution. Mirrors AC-1 + AC-2 seed.
  codecDistribution: {
    codec: [
      { bucket: 'hevc' as const, count: 60, bytes: 600_000_000_000 },
      { bucket: 'h264' as const, count: 30, bytes: 300_000_000_000 },
      { bucket: 'av1' as const, count: 5, bytes: 50_000_000_000 },
      { bucket: 'vp9' as const, count: 3, bytes: 20_000_000_000 },
      { bucket: 'other' as const, count: 1, bytes: 5_000_000_000 },
      { bucket: 'unknown' as const, count: 1, bytes: 5_000_000_000 },
    ],
    container: [
      { bucket: 'mkv' as const, count: 80 },
      { bucket: 'mp4' as const, count: 15 },
      { bucket: 'other' as const, count: 5 },
    ],
    totalFiles: 100,
    totalBytes: 980_000_000_000,
  },
  system: {
    cpuCount: 8,
    perEncoderLimits: { libx265: 2, nvenc: 1, qsv: 1, vaapi: 1 },
    ffmpegVersion: '6.0.1',
    cachePoolPath: '/mnt/cache/x265-butler',
    dbSizeBytes: 12345,
  },
};

const FIXTURE_QUEUE = { paused: false, activeJobs: 0, pendingJobs: 3, encodingJobs: 0 };
const FIXTURE_ENCODERS = {
  detected: ['libx265'],
  active: 'libx265',
  resolution: 'auto' as const,
  requestedButUnavailable: undefined,
  devicePath: undefined,
};

describe('DashboardClient', () => {
  beforeEach(() => {
    mockUseActiveJob.mockReturnValue(null);
    mockUseQueueCounts.mockReturnValue({ activeJobs: 0, pendingJobs: 3 });
    mockUseEngineEventsDisconnected.mockReturnValue(false);
  });

  it('test_dashboardPage_when_renders_then_KPI_row_shows_six_cards', () => {
    render(
      wrap(
        <DashboardClient
          initialStats={FIXTURE_STATS}
          initialQueueStatus={FIXTURE_QUEUE}
          initialEncoders={FIXTURE_ENCODERS}
          requestId="test-req"
        />,
      ),
    );
    // KPI labels per dashboard.md §3
    expect(screen.getByText('Total saved')).toBeTruthy();
    expect(screen.getByText('Files processed')).toBeTruthy();
    expect(screen.getByText('Avg savings')).toBeTruthy();
    expect(screen.getByText('Active encoder')).toBeTruthy();
    expect(screen.getByText('Queue depth')).toBeTruthy();
    expect(screen.getByText('Cumulative throughput')).toBeTruthy();
  });

  it('test_dashboardPage_when_empty_db_then_KPI_em_dash_displayed', () => {
    const empty = {
      kpis: {
        totalSaved: 0,
        filesProcessed: 0,
        avgSavingsPercent: 0,
        cumulativeThroughputPerDay: 0,
        queueDepth: { pending: 0, encoding: 0 },
        byEncoder: {},
      },
      trend: [],
      recentActivity: [],
      codecDistribution: { codec: [], container: [], totalFiles: 0, totalBytes: 0 },
      system: FIXTURE_STATS.system,
    };
    render(
      wrap(
        <DashboardClient
          initialStats={empty}
          initialQueueStatus={FIXTURE_QUEUE}
          initialEncoders={FIXTURE_ENCODERS}
          requestId="test-req"
        />,
      ),
    );
    // Em-dash visible in at least one KPI tile (audit S5)
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThan(0);
  });

  it('test_dashboardPage_when_empty_db_then_chart_empty_state_renders', () => {
    const empty = {
      ...FIXTURE_STATS,
      trend: Array.from({ length: 30 }, (_, i) => ({
        date: `2026-04-${String(i + 1).padStart(2, '0')}`,
        bytesIn: 0,
        bytesOut: 0,
        savings: 0,
      })),
    };
    render(
      wrap(
        <DashboardClient
          initialStats={empty}
          initialQueueStatus={FIXTURE_QUEUE}
          initialEncoders={FIXTURE_ENCODERS}
          requestId="test-req"
        />,
      ),
    );
    expect(screen.getByText('No encodes yet')).toBeTruthy();
  });

  it('test_dashboardPage_when_pendingJobs_zero_and_activeJobs_zero_then_LiveQueue_empty_state', () => {
    mockUseQueueCounts.mockReturnValue({ activeJobs: 0, pendingJobs: 0 });
    render(
      wrap(
        <DashboardClient
          initialStats={FIXTURE_STATS}
          initialQueueStatus={{ ...FIXTURE_QUEUE, pendingJobs: 0 }}
          initialEncoders={FIXTURE_ENCODERS}
          requestId="test-req"
        />,
      ),
    );
    expect(screen.getByText('Queue empty')).toBeTruthy();
  });

  it('test_dashboardPage_when_recentActivity_empty_then_card_empty_state', () => {
    const noActivity = { ...FIXTURE_STATS, recentActivity: [] };
    render(
      wrap(
        <DashboardClient
          initialStats={noActivity}
          initialQueueStatus={FIXTURE_QUEUE}
          initialEncoders={FIXTURE_ENCODERS}
          requestId="test-req"
        />,
      ),
    );
    expect(screen.getByText('No activity yet')).toBeTruthy();
  });

  it('test_dashboardPage_when_renders_then_SystemInfo_renders_cpuCount_ffmpegVersion_cachePool', () => {
    render(
      wrap(
        <DashboardClient
          initialStats={FIXTURE_STATS}
          initialQueueStatus={FIXTURE_QUEUE}
          initialEncoders={FIXTURE_ENCODERS}
          requestId="test-req"
        />,
      ),
    );
    expect(screen.getByText('CPU cores')).toBeTruthy();
    expect(screen.getByText('ffmpeg version')).toBeTruthy();
    expect(screen.getByText('Cache pool')).toBeTruthy();
    expect(screen.getByText('6.0.1')).toBeTruthy();
  });

  // audit S6: cache_pool null → em-dash NOT literal fallback
  it('test_dashboardPage_when_cache_pool_path_setting_null_then_SystemInfo_em_dash_NOT_literal_fallback', () => {
    const noCache = {
      ...FIXTURE_STATS,
      system: { ...FIXTURE_STATS.system, cachePoolPath: null },
    };
    render(
      wrap(
        <DashboardClient
          initialStats={noCache}
          initialQueueStatus={FIXTURE_QUEUE}
          initialEncoders={FIXTURE_ENCODERS}
          requestId="test-req"
        />,
      ),
    );
    // The hardcoded literal must NOT be present
    expect(screen.queryByText('/mnt/cache/x265-butler')).toBeNull();
  });

  it('test_dashboardPage_when_resolution_fallback_then_warning_aria_present', () => {
    const fallbackEnc = {
      detected: ['libx265'],
      active: 'libx265',
      resolution: 'fallback' as const,
      requestedButUnavailable: 'nvenc' as const,
      devicePath: undefined,
    };
    render(
      wrap(
        <DashboardClient
          initialStats={FIXTURE_STATS}
          initialQueueStatus={FIXTURE_QUEUE}
          initialEncoders={fallbackEnc}
          requestId="test-req"
        />,
      ),
    );
    // amber AlertTriangle has aria-label="warning"
    expect(screen.getByLabelText('warning')).toBeTruthy();
  });

  // audit S7 / chronological + per-day aggregation visible to user via chart-aria
  it('test_dashboardPage_when_trend_present_then_chart_aria_label_contains_total_and_peak', () => {
    render(
      wrap(
        <DashboardClient
          initialStats={FIXTURE_STATS}
          initialQueueStatus={FIXTURE_QUEUE}
          initialEncoders={FIXTURE_ENCODERS}
          requestId="test-req"
        />,
      ),
    );
    // chart wrapper has role=img + aria-label assembled from total + peak
    const chart = document.querySelector('[role="img"]');
    expect(chart).toBeTruthy();
    expect(chart?.getAttribute('aria-label')).toMatch(/Total saved/);
    expect(chart?.getAttribute('aria-label')).toMatch(/Peak day/);
  });

  // audit M4: every dashboard sub-component has 'use client' as first line
  // (Recharts SSR-crash invariant — extended 07-02 to include codec-distribution-card).
  it('test_dashboardPage_subcomponent_modules_carry_use_client_directive_on_first_line', () => {
    const files = [
      'components/dashboard/kpi-card.tsx',
      'components/dashboard/savings-trend-chart.tsx',
      'components/dashboard/live-queue-card.tsx',
      'components/dashboard/recent-activity.tsx',
      'components/dashboard/system-info-card.tsx',
      'components/dashboard/codec-distribution-card.tsx',
      'app/[locale]/dashboard/dashboard-client.tsx',
    ];
    for (const f of files) {
      const content = readFileSync(join(REPO_ROOT, f), 'utf8');
      const firstLine = content.split('\n')[0]?.trim();
      expect(firstLine, `${f} must start with 'use client'`).toBe("'use client';");
    }
  });

  // audit S8 (07-02 extended, 08-03 updated): recharts imported ONLY in
  // savings-trend-chart.tsx (03-04). codec-distribution-card.tsx was a second
  // whitelisted chart-bearing module (07-02) but moved to CSS stacked bars
  // in 08-03 — Recharts removed from that file; guard updated accordingly.
  it('test_dashboardPage_recharts_imported_only_in_chart_bearing_card_modules', () => {
    const dashboardFiles = [
      'components/dashboard/kpi-card.tsx',
      'components/dashboard/codec-distribution-card.tsx',
      'components/dashboard/live-queue-card.tsx',
      'components/dashboard/recent-activity.tsx',
      'components/dashboard/system-info-card.tsx',
      'app/[locale]/dashboard/dashboard-client.tsx',
      'app/[locale]/dashboard/page.tsx',
    ];
    for (const f of dashboardFiles) {
      const content = readFileSync(join(REPO_ROOT, f), 'utf8');
      expect(content, `${f} must NOT import from 'recharts'`).not.toMatch(
        /from\s+['"]recharts['"]/,
      );
    }
    // savings-trend-chart MUST still import recharts (regression guard)
    const chartContent = readFileSync(
      join(REPO_ROOT, 'components/dashboard/savings-trend-chart.tsx'),
      'utf8',
    );
    expect(chartContent).toMatch(/from\s+['"]recharts['"]/);
  });

  // audit M5: page.tsx (Server Component) does NOT self-fetch via HTTP
  it('test_dashboardPage_server_component_does_NOT_fetch_localhost_url', () => {
    const content = readFileSync(join(REPO_ROOT, 'app/[locale]/dashboard/page.tsx'), 'utf8');
    expect(content).not.toMatch(/fetch\(.*\$\{proto\}/);
    expect(content).not.toMatch(/fetch\(.*\$\{host\}/);
    expect(content).not.toMatch(/x-forwarded-proto/);
    // Direct repo calls present
    expect(content).toMatch(/statsRepo\(\)/);
    expect(content).toMatch(/jobRepo\(\)/);
  });
});
