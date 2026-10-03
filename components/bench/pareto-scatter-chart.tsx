'use client';

import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AggregatedComboView } from '@/src/lib/db/schema';
import type { EngineEvent } from '@/src/lib/encode/events';
import { useBenchComboFeed } from '@/src/lib/api/engine-events-client';
import { formatBytes, type FormatLocale } from '@/src/lib/format';
import { useLocale } from 'next-intl';

type ComboCompleteEvent = Extract<EngineEvent, { type: 'bench.combo_complete' }>;

interface LiveCombo {
  vmaf: number;
  sizeBytes: number;
  encodeSec: number;
}

// 11-03 UAT dark-mode fix: chart-N CSS vars already include hsl() wrapper
// (see globals.css :root / .dark), so component-side wrap produces
// hsl(hsl(...)) — invalid → SVG fill falls back to default black → invisible
// against the .dark near-black bg. Use the var directly.
const ENCODER_CHART_COLOR: Record<string, string> = {
  libx265: 'var(--chart-1)',
  hevc_nvenc: 'var(--chart-2)',
  hevc_qsv: 'var(--chart-3)',
  hevc_vaapi: 'var(--chart-4)',
};

// Per-encoder pattern-shape (skill §10 pattern-texture + §1 color-not-only):
// distinguishable without color for Deuteranopia / Protanopia operators.
const ENCODER_SHAPE: Record<string, 'circle' | 'square' | 'triangle' | 'diamond'> = {
  libx265: 'circle',
  hevc_nvenc: 'square',
  hevc_qsv: 'triangle',
  hevc_vaapi: 'diamond',
};

const ENCODERS = ['libx265', 'hevc_nvenc', 'hevc_qsv', 'hevc_vaapi'] as const;
type EncoderKey = (typeof ENCODERS)[number];

const PARETO_COLOR = 'var(--foreground)';
const POINT_STROKE = 'var(--background)';

const CHART_CONFIG: ChartConfig = {
  libx265: { label: 'libx265', color: 'var(--chart-1)' },
  hevc_nvenc: { label: 'NVENC', color: 'var(--chart-2)' },
  hevc_qsv: { label: 'QSV', color: 'var(--chart-3)' },
  hevc_vaapi: { label: 'VAAPI', color: 'var(--chart-4)' },
  pareto: { label: 'Pareto frontier', color: 'var(--foreground)' },
};

// 11-03 UAT-simplify: invisible shape for the pareto-frontier Scatter — only
// its connecting `line` prop should be visible. Each pareto combo is ALREADY
// rendered by its per-encoder Scatter below; the pareto Scatter exists solely
// to draw the line that connects those points. Returns `g` with no visual.
function InvisibleShape() {
  return <g />;
}

export interface ParetoScatterChartProps {
  runId: number;
  summary: AggregatedComboView[];
  isRunning: boolean;
}

export function ParetoScatterChart({ runId, summary, isRunning }: ParetoScatterChartProps) {
  const locale = useLocale() as FormatLocale;
  const [liveCombos, setLiveCombos] = useState<LiveCombo[]>([]);
  const [reducedMotion, setReducedMotion] = useState(false);
  const comboBuffer = useRef<LiveCombo[]>([]);
  const rafPending = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    if (!isRunning) setLiveCombos([]);
  }, [isRunning]);

  const onCombo = useCallback((ev: ComboCompleteEvent) => {
    comboBuffer.current.push({ vmaf: ev.vmaf, sizeBytes: ev.sizeBytes, encodeSec: ev.encodeSec });
    if (!rafPending.current) {
      rafPending.current = true;
      requestAnimationFrame(() => {
        const batch = comboBuffer.current.splice(0);
        rafPending.current = false;
        if (batch.length > 0) {
          setLiveCombos((prev) => [...prev, ...batch]);
        }
      });
    }
  }, []);

  useBenchComboFeed(isRunning ? runId : null, onCombo);

  const paretoFront = useMemo(
    () => summary.filter((c) => c.is_pareto).sort((a, b) => a.sizeBytes - b.sizeBytes),
    [summary],
  );

  // 11-03 UAT-simplify (Option A): byEncoder now includes pareto combos too,
  // so each combo renders EXACTLY ONCE with its encoder shape (form + color).
  // The pareto-frontier is conveyed via the dedicated connecting LINE below,
  // not a duplicate cross-overlay. Top-3 emphasis lives in the cards beneath
  // the chart — single source of truth, no chart-overlay duplication.
  const byEncoder = useMemo(
    () =>
      Object.fromEntries(
        ENCODERS.map((enc) => [enc, summary.filter((c) => c.encoder === enc)]),
      ) as Record<EncoderKey, AggregatedComboView[]>,
    [summary],
  );

  // 11-03 UAT fix: top3 Scatter is a SUBSET of paretoFront → same sizeBytes
  // appears in two Scatter series → Recharts auto-tick-merge produces
  // duplicate React keys (`tick-label-VALUE-x-y` collision). Bypass auto-tick
  // generation by computing explicit log-spaced ticks from the data domain.
  const yAxisDomain = useMemo((): [number, number] => {
    const vals = [...summary.map((c) => c.vmaf), ...liveCombos.map((c) => c.vmaf)].filter((n) =>
      Number.isFinite(n),
    );
    if (vals.length === 0) return [80, 100];
    const dataMin = Math.min(...vals);
    const dataMax = Math.max(...vals);
    const MIN_SPAN = 8;
    const PADDING = 2;
    let lo = dataMin - PADDING;
    let hi = dataMax + PADDING;
    if (hi - lo < MIN_SPAN) {
      const center = (lo + hi) / 2;
      lo = center - MIN_SPAN / 2;
      hi = center + MIN_SPAN / 2;
    }
    return [Math.max(0, Math.floor(lo)), Math.min(100, Math.ceil(hi))];
  }, [summary, liveCombos]);

  const xAxisTicks = useMemo(() => {
    const sizes = [
      ...summary.map((c) => c.sizeBytes),
      ...liveCombos.map((c) => c.sizeBytes),
    ].filter((n) => Number.isFinite(n) && n > 0);
    if (sizes.length === 0) return undefined;
    const min = Math.min(...sizes);
    const max = Math.max(...sizes);
    if (min === max) return [min];
    const logMin = Math.log10(min);
    const logMax = Math.log10(max);
    const TICK_COUNT = 5;
    const out: number[] = [];
    for (let i = 0; i < TICK_COUNT; i++) {
      const exp = logMin + (i / (TICK_COUNT - 1)) * (logMax - logMin);
      out.push(Math.round(Math.pow(10, exp)));
    }
    // De-dup adjacent equal ticks (narrow domain edge-case)
    return Array.from(new Set(out));
  }, [summary, liveCombos]);

  if (summary.length === 0 && liveCombos.length === 0 && !isRunning) return null;

  const hasPareto = paretoFront.length >= 2;

  return (
    <div className="space-y-2">
      <div
        role="img"
        aria-label="Pareto frontier scatter chart"
        tabIndex={0}
        className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <ChartContainer config={CHART_CONFIG} className="h-[400px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ left: 8, right: 8, top: 16, bottom: 8 }}>
              {/* Theme-aware grid + axes (skill §1 contrast-data 4.5:1, §6 color-dark-mode, §10 gridline-subtle).
                  Recharts defaults (#ccc / #666) fail in dark mode — explicit tokens required. */}
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.6} />
              <XAxis
                type="number"
                dataKey="sizeBytes"
                scale="log"
                domain={['auto', 'auto']}
                ticks={xAxisTicks}
                allowDuplicatedCategory={false}
                tickFormatter={(v: number) => formatBytes(v, locale)}
                tickLine={false}
                axisLine={false}
                tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                name="Size"
              />
              <YAxis
                type="number"
                dataKey="vmaf"
                domain={yAxisDomain}
                tickLine={false}
                axisLine={false}
                tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                name="VMAF"
              />
              {/* 11-03 UAT-simplify (Option B): Z-axis encoding removed.
                  Variable bubble-size mapped to encodeSec confused operators
                  (no legend explanation). Encode-time now surfaces only via
                  tooltip on hover. All markers render at uniform size. */}
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                content={({ payload }) => {
                  if (!payload?.length) return null;
                  const d = payload[0]?.payload as AggregatedComboView | LiveCombo;
                  return (
                    <div className="rounded border bg-background p-2 text-xs shadow">
                      {'encoder' in d && (
                        <p className="font-medium">
                          {d.encoder} {d.preset}
                        </p>
                      )}
                      <p>VMAF: {d.vmaf.toFixed(2)}</p>
                      <p>Size: {formatBytes(d.sizeBytes, locale)}</p>
                      <p>Time: {d.encodeSec.toFixed(1)}s</p>
                    </div>
                  );
                }}
              />

              {isRunning && liveCombos.length > 0 && (
                <Scatter
                  name="live"
                  data={liveCombos}
                  fill={PARETO_COLOR}
                  stroke={POINT_STROKE}
                  strokeWidth={1.5}
                  opacity={0.85}
                  isAnimationActive={!reducedMotion}
                />
              )}

              {!isRunning &&
                ENCODERS.map((enc) =>
                  byEncoder[enc].length > 0 ? (
                    <Scatter
                      key={enc}
                      name={enc}
                      data={byEncoder[enc]}
                      fill={ENCODER_CHART_COLOR[enc]}
                      stroke={POINT_STROKE}
                      strokeWidth={1.5}
                      shape={ENCODER_SHAPE[enc]}
                      isAnimationActive={!reducedMotion}
                    />
                  ) : null,
                )}

              {!isRunning && hasPareto && (
                /* 11-03 UAT-simplify: pareto-line ONLY (line prop renders the
                   connecting frontier line). shape={InvisibleShape} suppresses
                   the cross-overlay — each pareto combo is already drawn by
                   its per-encoder Scatter above with its proper form+color. */
                <Scatter
                  name="pareto"
                  data={paretoFront}
                  fill="transparent"
                  stroke="transparent"
                  line={{ stroke: PARETO_COLOR, strokeWidth: 3 }}
                  shape={InvisibleShape}
                  isAnimationActive={false}
                />
              )}

              {/* Legend (skill §10 legend-visible) — only when not running so live-mode stays focused. */}
              {!isRunning && summary.length > 0 && (
                <ChartLegend content={<ChartLegendContent />} verticalAlign="bottom" />
              )}
            </ScatterChart>
          </ResponsiveContainer>
        </ChartContainer>
      </div>
    </div>
  );
}
