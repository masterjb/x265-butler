import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { StatsClient } from '@/components/stats/stats-client';
import type {
  TopSaverRow,
  EncoderPerfRow,
  StatsTrendPointFull,
  CodecDistribution,
} from '@/src/lib/db';

if (typeof globalThis.ResizeObserver === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

const NOW_UNIX = 1_800_000_000;

const FIXTURE_TOP_SAVERS: TopSaverRow[] = [
  {
    jobId: 1,
    fileId: 42,
    filePath: '/media/movies/foo/bar.mp4',
    bytesIn: 1_000_000_000,
    bytesOut: 400_000_000,
    savedBytes: 600_000_000,
    savedPercent: 60.0,
    finishedAt: NOW_UNIX,
    encoder: 'libx265',
  },
];

const FIXTURE_ENCODER_PERF: EncoderPerfRow[] = [
  { encoder: 'libx265', jobCount: 5, totalSavedBytes: 3_000_000_000, avgSavedPercent: 55.0 },
];

function makeBlankTrend(): StatsTrendPointFull[] {
  return Array.from({ length: 30 }, (_, i) => ({
    date: new Date((NOW_UNIX - (29 - i) * 86400) * 1000).toISOString().slice(0, 10),
    bytesIn: 0,
    bytesOut: 0,
    savings: 0,
    jobCount: 0,
  }));
}

const FIXTURE_TREND_WITH_DATA: StatsTrendPointFull[] = makeBlankTrend().map((p, i) =>
  i === 29
    ? { ...p, bytesIn: 1_000_000_000, bytesOut: 600_000_000, savings: 400_000_000, jobCount: 1 }
    : p,
);

const FIXTURE_CODEC: CodecDistribution = {
  codec: [{ bucket: 'hevc', count: 10, bytes: 100_000_000_000 }],
  container: [{ bucket: 'mkv', count: 10 }],
  totalFiles: 10,
  totalBytes: 100_000_000_000,
};

// Base fixture — all new fields set to safe empty defaults
function makeData(
  overrides?: Partial<Parameters<typeof StatsClient>[0]['initialData'] & object>,
): NonNullable<Parameters<typeof StatsClient>[0]['initialData']> {
  return {
    topSavers: [],
    encoderPerf: [],
    trend: makeBlankTrend(),
    codecDistribution: null,
    resolutionDist: [],
    fileStatusDist: [],
    bitrateDist: [],
    encodeSpeedRatio: { avgSpeedRatio: 0, sampleSize: 0 },
    failedJobRate: { failRate: 0, sampleSize: 0 },
    avgQueueWait: { avgWaitSec: 0, sampleSize: 0 },
    skipTypeBreakdown: [],
    allTimeJobSummary: { done: 0, failed: 0, interrupted: 0, cancelled: 0, total: 0 },
    currentTrashSize: { trashBytes: 0, trashCount: 0 },
    expiringTrash: { count: 0 },
    netDiskFreed: 0,
    ...overrides,
  };
}

describe('StatsClient', () => {
  it('test_StatsClient_renders_without_crash_when_null_data', () => {
    expect(() => render(wrap(<StatsClient initialData={null} />))).not.toThrow();
  });

  it('test_StatsClient_shows_topSavers_empty_state_when_no_rows', () => {
    render(wrap(<StatsClient initialData={makeData()} />));
    expect(screen.getByText('No data yet')).toBeTruthy();
  });

  it('test_StatsClient_renders_topSavers_row_with_basename_and_savings', () => {
    render(wrap(<StatsClient initialData={makeData({ topSavers: FIXTURE_TOP_SAVERS })} />));
    expect(screen.getByText('bar.mp4')).toBeTruthy();
    expect(screen.getByText(/MiB|GiB/)).toBeTruthy();
  });

  it('test_StatsClient_topSavers_shows_fileMissing_when_filePath_null', () => {
    const nullPathRow: TopSaverRow = { ...FIXTURE_TOP_SAVERS[0], filePath: null, fileId: null };
    render(wrap(<StatsClient initialData={makeData({ topSavers: [nullPathRow] })} />));
    expect(screen.getAllByText('File not found').length).toBeGreaterThan(0);
  });

  it('test_StatsClient_shows_encoderPerf_empty_state_when_no_rows', () => {
    render(wrap(<StatsClient initialData={makeData()} />));
    expect(screen.getByText('No encoder data')).toBeTruthy();
  });

  it('test_StatsClient_encoderPerf_renders_when_data_present', () => {
    render(wrap(<StatsClient initialData={makeData({ encoderPerf: FIXTURE_ENCODER_PERF })} />));
    expect(screen.getByRole('img', { name: /Encoder performance bar chart/i })).toBeTruthy();
  });

  it('test_StatsClient_timeline_empty_state_when_all_zeros', () => {
    render(wrap(<StatsClient initialData={makeData()} />));
    expect(screen.getByText('No activity yet')).toBeTruthy();
  });

  it('test_StatsClient_codec_distribution_section_renders_CodecDistributionCard', () => {
    render(wrap(<StatsClient initialData={makeData({ codecDistribution: FIXTURE_CODEC })} />));
    expect(screen.getByText('Codec Distribution')).toBeTruthy();
  });

  // ── New section tests (08-05) ──────────────────────────────────────────

  it('test_StatsClient_pipeline_health_section_heading_visible', () => {
    render(wrap(<StatsClient initialData={makeData()} />));
    expect(screen.getByText(en.stats.charts.pipelineHealth.title)).toBeTruthy();
  });

  it('test_StatsClient_bulletKpiCard_renders_with_failed_rate_data', () => {
    render(
      wrap(
        <StatsClient
          initialData={makeData({ failedJobRate: { failRate: 0.02, sampleSize: 50 } })}
        />,
      ),
    );
    expect(screen.getByText(en.stats.charts.failedJobRate.threshold.healthy)).toBeTruthy();
  });

  it('test_StatsClient_allTimeJobSummary_total_renders', () => {
    render(
      wrap(
        <StatsClient
          initialData={makeData({
            allTimeJobSummary: { done: 10, failed: 2, interrupted: 1, cancelled: 0, total: 13 },
          })}
        />,
      ),
    );
    expect(screen.getByText('13')).toBeTruthy();
  });

  it('test_StatsClient_skip_analysis_heading_and_empty_state_visible', () => {
    render(wrap(<StatsClient initialData={makeData()} />));
    expect(screen.getByText(en.stats.charts.skipAnalysis.title)).toBeTruthy();
    expect(screen.getByText(en.stats.charts.skipTypeBreakdown.empty.title)).toBeTruthy();
  });

  it('test_StatsClient_skip_analysis_renders_translated_skip_labels', () => {
    render(
      wrap(
        <StatsClient
          initialData={makeData({
            skipTypeBreakdown: [
              { status: 'skipped-codec', count: 5 },
              { status: 'skipped-bitrate', count: 3 },
            ],
          })}
        />,
      ),
    );
    expect(screen.getByText(en.library.status.skippedCodec)).toBeTruthy();
    expect(screen.getByText(en.library.status.skippedBitrate)).toBeTruthy();
  });

  it('test_StatsClient_disk_recovery_expiringSoon_shows_count', () => {
    render(wrap(<StatsClient initialData={makeData({ expiringTrash: { count: 3 } })} />));
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('test_StatsClient_inline_svg_timeline_renders_when_data_present', () => {
    const { container } = render(
      wrap(<StatsClient initialData={makeData({ trend: FIXTURE_TREND_WITH_DATA })} />),
    );
    expect(container.querySelector('[data-testid="inline-svg-timeline"]')).toBeTruthy();
  });

  it('test_StatsClient_disk_recovery_section_heading_visible', () => {
    render(wrap(<StatsClient initialData={makeData()} />));
    expect(screen.getByText(en.stats.charts.diskRecovery.title)).toBeTruthy();
  });
});
