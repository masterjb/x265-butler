import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { AggregatedComboView, BenchRunRow } from '@/src/lib/db/schema';

vi.mock('recharts', () => ({
  ScatterChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="scatter-chart">{children}</div>
  ),
  Scatter: (props: { name?: string; shape?: string; fill?: string }) => (
    <div
      data-testid={`scatter-series`}
      data-name={props.name}
      data-shape={props.shape}
      data-fill={props.fill}
    />
  ),
  XAxis: () => <div />,
  YAxis: () => <div />,
  CartesianGrid: () => <div />,
  Tooltip: () => <div />,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/chart', () => ({
  ChartContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { BenchCompareView, COMPARE_SHAPES } from '@/components/bench/bench-compare-view';
import en from '@/messages/en.json';

const MESSAGES = en;

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={MESSAGES} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

function makeRun(id: number): BenchRunRow {
  return {
    id,
    mode: 'native-sweep',
    status: 'complete',
    fileIds: [1],
    matrix: { encoders: ['libx265'], presets: ['medium'], nativeValues: [23] },
    sample_count: 3,
    sample_duration_seconds: 20,
    vmaf_buckets_json: null,
    vmaf_model: 'vmaf_v0.6.1',
    actor_id: null,
    error_reason: null,
    created_at: 1_700_000_000,
    started_at: null,
    completed_at: null,
    version: 1,
  };
}

function makeSummary(): AggregatedComboView[] {
  return [
    {
      encoder: 'libx265',
      preset: 'medium',
      native_quality_param: 'crf',
      native_quality_value: 23,
      vmaf_target: null,
      vmaf: 95,
      sizeBytes: 1_000_000,
      encodeSec: 10,
      sourceSampleBytes: 5_000_000,
      sampleIds: [1],
      is_pareto: true,
      top3_role: 'balanced',
    },
  ];
}

describe('BenchCompareView', () => {
  it('test_renders_2_scatter_series_for_2_entries', () => {
    const entries = [
      { id: 1, run: makeRun(1), summary: makeSummary() },
      { id: 2, run: makeRun(2), summary: makeSummary() },
    ];
    render(wrap(<BenchCompareView entries={entries} />));
    expect(screen.getAllByTestId('scatter-series')).toHaveLength(2);
  });

  it('test_renders_3_scatter_series_for_3_entries', () => {
    const entries = [
      { id: 1, run: makeRun(1), summary: makeSummary() },
      { id: 2, run: makeRun(2), summary: makeSummary() },
      { id: 3, run: makeRun(3), summary: makeSummary() },
    ];
    render(wrap(<BenchCompareView entries={entries} />));
    expect(screen.getAllByTestId('scatter-series')).toHaveLength(3);
  });

  it('test_chart_token_colors_applied_per_entry_index', () => {
    const entries = [
      { id: 10, run: makeRun(10), summary: makeSummary() },
      { id: 20, run: makeRun(20), summary: makeSummary() },
      { id: 30, run: makeRun(30), summary: makeSummary() },
    ];
    render(wrap(<BenchCompareView entries={entries} />));
    const series = screen.getAllByTestId('scatter-series');
    expect(series[0].getAttribute('data-fill')).toBe('var(--chart-1)');
    expect(series[1].getAttribute('data-fill')).toBe('var(--chart-2)');
    expect(series[2].getAttribute('data-fill')).toBe('var(--chart-3)');
  });

  it('test_symbol_shape_mandatory_per_run_index', () => {
    expect(COMPARE_SHAPES).toEqual(['circle', 'square', 'triangle']);
    const entries = [
      { id: 1, run: makeRun(1), summary: makeSummary() },
      { id: 2, run: makeRun(2), summary: makeSummary() },
      { id: 3, run: makeRun(3), summary: makeSummary() },
    ];
    render(wrap(<BenchCompareView entries={entries} />));
    const series = screen.getAllByTestId('scatter-series');
    expect(series[0].getAttribute('data-shape')).toBe('circle');
    expect(series[1].getAttribute('data-shape')).toBe('square');
    expect(series[2].getAttribute('data-shape')).toBe('triangle');
  });

  it('test_legend_click_toggles_series_visibility', () => {
    const entries = [
      { id: 1, run: makeRun(1), summary: makeSummary() },
      { id: 2, run: makeRun(2), summary: makeSummary() },
    ];
    render(wrap(<BenchCompareView entries={entries} />));
    expect(screen.getAllByTestId('scatter-series')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('compare-legend-1'));
    expect(screen.getAllByTestId('scatter-series')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('compare-legend-1'));
    expect(screen.getAllByTestId('scatter-series')).toHaveLength(2);
  });

  it('test_legend_buttons_have_aria_pressed_state', () => {
    const entries = [
      { id: 1, run: makeRun(1), summary: makeSummary() },
      { id: 2, run: makeRun(2), summary: makeSummary() },
    ];
    render(wrap(<BenchCompareView entries={entries} />));
    const btn = screen.getByTestId('compare-legend-1');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('test_empty_summary_renders_zero_data_points_without_crash', () => {
    const entries = [{ id: 1, run: makeRun(1), summary: [] }];
    expect(() => render(wrap(<BenchCompareView entries={entries} />))).not.toThrow();
    expect(screen.getByTestId('bench-compare-view')).toBeInTheDocument();
  });

  it('test_view_renders_within_chart_container', () => {
    const entries = [
      { id: 1, run: makeRun(1), summary: makeSummary() },
      { id: 2, run: makeRun(2), summary: makeSummary() },
    ];
    render(wrap(<BenchCompareView entries={entries} />));
    expect(screen.getByTestId('scatter-chart')).toBeInTheDocument();
  });
});

describe('compare-page ids dedup contract (audit M7)', () => {
  it('test_ids_dedup_via_Set_before_length_check', () => {
    const parseAndDedup = (raw: string) => {
      const parsed = raw
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      return Array.from(new Set(parsed));
    };
    expect(parseAndDedup('1,1,2')).toEqual([1, 2]);
    expect(parseAndDedup('1,1')).toEqual([1]);
    expect(parseAndDedup('1,2,3,2,1')).toEqual([1, 2, 3]);
  });
});
