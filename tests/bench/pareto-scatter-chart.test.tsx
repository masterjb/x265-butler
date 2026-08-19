import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AggregatedComboView } from '@/src/lib/db/schema';

vi.mock('recharts', () => ({
  ScatterChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="scatter-chart">{children}</div>
  ),
  Scatter: ({
    name,
    data,
    line,
    isAnimationActive,
  }: {
    name?: string;
    data?: unknown[];
    line?: unknown;
    isAnimationActive?: boolean;
  }) => (
    <div
      data-testid="scatter"
      data-name={name}
      data-count={data?.length ?? 0}
      data-has-line={String(!!line)}
      data-animation={String(isAnimationActive)}
    />
  ),
  XAxis: ({ scale, domain, ticks }: { scale?: string; domain?: unknown; ticks?: number[] }) => (
    <div
      data-testid="x-axis"
      data-scale={scale}
      data-domain={JSON.stringify(domain)}
      data-ticks={JSON.stringify(ticks ?? null)}
    />
  ),
  YAxis: ({ domain }: { domain?: unknown }) => (
    <div data-testid="y-axis" data-domain={JSON.stringify(domain)} />
  ),
  ZAxis: ({ range }: { range?: number[] }) => (
    <div data-testid="z-axis" data-range={JSON.stringify(range)} />
  ),
  CartesianGrid: () => <div />,
  Tooltip: () => <div />,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
}));

vi.mock('@/components/ui/chart', () => ({
  ChartContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="chart-container">{children}</div>
  ),
  ChartLegend: ({ content }: { content: React.ReactNode }) => (
    <div data-testid="chart-legend">{content}</div>
  ),
  ChartLegendContent: () => <div data-testid="chart-legend-content" />,
}));

vi.mock('@/src/lib/api/engine-events-client', () => ({
  useBenchComboFeed: vi.fn(),
  useBenchRunState: vi.fn(() => ({
    runId: null,
    mode: null,
    status: 'idle',
    completedCombos: 0,
    totalCombos: 0,
    currentPhase: null,
    errorReason: null,
  })),
}));

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));

import { ParetoScatterChart } from '@/components/bench/pareto-scatter-chart';

function makeCombo(
  encoder: string,
  overrides: Partial<AggregatedComboView> = {},
): AggregatedComboView {
  return {
    encoder,
    preset: 'medium',
    native_quality_param: 'crf',
    native_quality_value: 23,
    vmaf_target: null,
    vmaf: 92,
    sizeBytes: 1_000_000,
    encodeSec: 30,
    sourceSampleBytes: 4_000_000,
    sampleIds: [1],
    is_pareto: false,
    top3_role: null,
    ...overrides,
  };
}

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('ParetoScatterChart', () => {
  beforeEach(() => {
    mockMatchMedia(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('test_paretoScatterChart_renders_responsiveContainer_and_logScale_xAxis_and_vmaf_yAxis', () => {
    const summary = [makeCombo('libx265')];
    render(<ParetoScatterChart runId={1} summary={summary} isRunning={false} />);
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
    expect(screen.getByTestId('scatter-chart')).toBeInTheDocument();
    const xAxis = screen.getByTestId('x-axis');
    expect(xAxis).toHaveAttribute('data-scale', 'log');
    const yAxis = screen.getByTestId('y-axis');
    // Dynamic domain: vmaf=92, single point → [88,96] (center 92, min-span 8, padding 2)
    expect(yAxis).toHaveAttribute('data-domain', '[88,96]');
  });

  it('test_paretoScatterChart_renders_4_encoder_scatter_instances_when_all_4_encoders_present', () => {
    const summary = [
      makeCombo('libx265'),
      makeCombo('hevc_nvenc'),
      makeCombo('hevc_qsv'),
      makeCombo('hevc_vaapi'),
    ];
    render(<ParetoScatterChart runId={1} summary={summary} isRunning={false} />);
    const scatters = screen.getAllByTestId('scatter');
    const encoderScatters = scatters.filter((s) =>
      ['libx265', 'hevc_nvenc', 'hevc_qsv', 'hevc_vaapi'].includes(
        s.getAttribute('data-name') ?? '',
      ),
    );
    expect(encoderScatters).toHaveLength(4);
  });

  it('test_paretoScatterChart_renders_pareto_line_scatter_when_3_or_more_is_pareto_combos', () => {
    const summary = [
      makeCombo('libx265', { is_pareto: true, sizeBytes: 500_000 }),
      makeCombo('libx265', { is_pareto: true, sizeBytes: 1_000_000 }),
      makeCombo('libx265', { is_pareto: true, sizeBytes: 2_000_000 }),
      makeCombo('hevc_nvenc'),
    ];
    render(<ParetoScatterChart runId={1} summary={summary} isRunning={false} />);
    const scatters = screen.getAllByTestId('scatter');
    const paretoScatter = scatters.find((s) => s.getAttribute('data-name') === 'pareto');
    expect(paretoScatter).toBeTruthy();
    expect(paretoScatter).toHaveAttribute('data-has-line', 'true');
  });

  // 11-03 UAT Option A: top3 Scatter REMOVED — Top-3 emphasis lives in the
  // cards beneath the chart (single source of truth). The chart shows ONLY
  // encoder shape/color per combo + a connecting pareto-frontier line.
  it('test_paretoScatterChart_does_NOT_render_top3_scatter_anymore', () => {
    const summary = [
      makeCombo('libx265', { top3_role: 'quality' }),
      makeCombo('hevc_nvenc', { top3_role: 'balanced' }),
      makeCombo('hevc_qsv', { top3_role: 'size' }),
    ];
    render(<ParetoScatterChart runId={1} summary={summary} isRunning={false} />);
    const scatters = screen.getAllByTestId('scatter');
    expect(scatters.find((s) => s.getAttribute('data-name') === 'top3')).toBeUndefined();
  });

  // 11-03 UAT Option A: pareto combos now appear in their per-encoder Scatter
  // (form + color preserved), NOT siphoned off into a separate pareto-cross
  // Scatter. Verify: a single libx265 pareto combo shows up in the libx265
  // Scatter's data-count.
  it('test_paretoScatterChart_pareto_combos_render_in_per_encoder_scatter_with_their_encoder_form', () => {
    const summary = [
      makeCombo('libx265', { is_pareto: true, sizeBytes: 500_000 }),
      makeCombo('libx265', { is_pareto: true, sizeBytes: 1_000_000 }),
      makeCombo('libx265', { is_pareto: false, sizeBytes: 2_000_000 }),
    ];
    render(<ParetoScatterChart runId={1} summary={summary} isRunning={false} />);
    const scatters = screen.getAllByTestId('scatter');
    const libx265 = scatters.find((s) => s.getAttribute('data-name') === 'libx265');
    expect(libx265?.getAttribute('data-count')).toBe('3');
  });

  it('test_paretoScatterChart_reduced_motion_disables_animations_on_all_encoder_scatters', () => {
    mockMatchMedia(true);
    const summary = [makeCombo('libx265'), makeCombo('hevc_nvenc')];
    render(<ParetoScatterChart runId={1} summary={summary} isRunning={false} />);
    const scatters = screen.getAllByTestId('scatter');
    const encoderScatters = scatters.filter((s) =>
      ['libx265', 'hevc_nvenc'].includes(s.getAttribute('data-name') ?? ''),
    );
    for (const s of encoderScatters) {
      expect(s).toHaveAttribute('data-animation', 'false');
    }
  });

  it('test_paretoScatterChart_empty_summary_and_not_running_renders_nothing', () => {
    const { container } = render(<ParetoScatterChart runId={1} summary={[]} isRunning={false} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('scatter-chart')).toBeNull();
  });

  // 11-03 UAT regression: top3 ⊂ pareto causes duplicate sizeBytes across
  // Scatter series; Recharts auto-tick-merge produced duplicate React keys.
  // Fix: explicit `ticks` prop bypasses the auto-merge.
  it('test_xAxis_receives_explicit_ticks_when_summary_present', () => {
    const summary = [
      makeCombo('libx265', { is_pareto: true, sizeBytes: 500_000, top3_role: 'size' }),
      makeCombo('libx265', { is_pareto: true, sizeBytes: 1_000_000, top3_role: 'balanced' }),
      makeCombo('libx265', { is_pareto: true, sizeBytes: 2_000_000, top3_role: 'quality' }),
    ];
    render(<ParetoScatterChart runId={1} summary={summary} isRunning={false} />);
    const xAxis = screen.getByTestId('x-axis');
    const ticksAttr = xAxis.getAttribute('data-ticks');
    expect(ticksAttr).not.toBe('null');
    const ticks = JSON.parse(ticksAttr ?? '[]') as number[];
    // 5 log-spaced ticks (deduped), all unique
    expect(new Set(ticks).size).toBe(ticks.length);
    expect(ticks.length).toBeGreaterThan(0);
  });
});
