'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartContainer, type ChartConfig } from '@/components/ui/chart';
import { useLocale } from 'next-intl';
import { formatBytes } from '@/src/lib/format';
import type { BenchRunRow, AggregatedComboView } from '@/src/lib/db/schema';
import { Button } from '@/components/ui/button';

export interface BenchCompareEntry {
  id: number;
  run: BenchRunRow;
  summary: AggregatedComboView[];
}

export interface BenchCompareViewProps {
  entries: BenchCompareEntry[];
}

// audit-locked M6: symbol-shape by run-index is RELEASE-BLOCKING per 07-04
// color-blind gate. Color-only encoding violates WCAG 1.4.1.
export const COMPARE_SHAPES: readonly ('circle' | 'square' | 'triangle')[] = [
  'circle',
  'square',
  'triangle',
] as const;

const COMPARE_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)'] as const;

const CHART_CONFIG: ChartConfig = {
  run0: { label: 'Run 1', color: 'var(--chart-1)' },
  run1: { label: 'Run 2', color: 'var(--chart-2)' },
  run2: { label: 'Run 3', color: 'var(--chart-3)' },
};

interface ScatterPoint {
  x: number;
  y: number;
  runId: number;
  comboLabel: string;
}

export function BenchCompareView({ entries }: BenchCompareViewProps) {
  const locale = useLocale();
  const [visible, setVisible] = useState<Set<number>>(() => new Set(entries.map((e) => e.id)));
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const toggle = (id: number) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const seriesData = useMemo(() => {
    return entries.map((e, idx) => ({
      id: e.id,
      idx,
      color: COMPARE_COLORS[idx % COMPARE_COLORS.length],
      shape: COMPARE_SHAPES[idx % COMPARE_SHAPES.length],
      data: e.summary
        .filter((c) => Number.isFinite(c.sizeBytes) && Number.isFinite(c.vmaf))
        .map<ScatterPoint>((c) => ({
          x: c.sizeBytes,
          y: c.vmaf,
          runId: e.id,
          comboLabel: `${c.encoder}/${c.preset ?? '—'} @ ${c.native_quality_value}`,
        })),
    }));
  }, [entries]);

  const yDomain: [number, number] = useMemo(() => {
    const all = seriesData.flatMap((s) => s.data.map((p) => p.y)).filter(Number.isFinite);
    if (all.length === 0) return [80, 100];
    const lo = Math.max(0, Math.floor(Math.min(...all) - 2));
    const hi = Math.min(100, Math.ceil(Math.max(...all) + 2));
    return [lo, hi];
  }, [seriesData]);

  return (
    <div className="space-y-2" data-testid="bench-compare-view">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="legend">
        {seriesData.map((s) => {
          const active = visible.has(s.id);
          return (
            <Button
              key={s.id}
              type="button"
              variant={active ? 'default' : 'outline'}
              size="sm"
              onClick={() => toggle(s.id)}
              aria-pressed={active}
              data-testid={`compare-legend-${s.id}`}
              data-shape={s.shape}
              className="gap-2"
            >
              <span
                aria-hidden="true"
                className="inline-block size-3"
                style={{
                  backgroundColor: s.color,
                  clipPath:
                    s.shape === 'triangle'
                      ? 'polygon(50% 0%, 0% 100%, 100% 100%)'
                      : s.shape === 'square'
                        ? 'none'
                        : 'circle(50% at 50% 50%)',
                  borderRadius: s.shape === 'square' ? 0 : undefined,
                }}
              />
              Run #{s.id}
            </Button>
          );
        })}
      </div>

      <div
        role="img"
        aria-label="Compare overlay Pareto chart"
        tabIndex={0}
        className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChartContainer config={CHART_CONFIG} className="h-[420px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ left: 8, right: 8, top: 16, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.6} />
              <XAxis
                type="number"
                dataKey="x"
                scale="log"
                domain={['auto', 'auto']}
                tickFormatter={(v: number) => formatBytes(v, locale as 'en' | 'de')}
                tickLine={false}
                axisLine={false}
                tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                name="Size"
              />
              <YAxis
                type="number"
                dataKey="y"
                domain={yDomain}
                tickLine={false}
                axisLine={false}
                tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                name="VMAF"
              />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                content={({ active, payload }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const p = payload[0].payload as ScatterPoint;
                  return (
                    <div className="rounded-md border bg-popover px-2 py-1 text-xs shadow">
                      <div className="font-mono">
                        #{p.runId} · {p.comboLabel}
                      </div>
                      <div>
                        VMAF {p.y.toFixed(1)} · {formatBytes(p.x, locale as 'en' | 'de')}
                      </div>
                    </div>
                  );
                }}
              />
              {seriesData
                .filter((s) => visible.has(s.id))
                .map((s) => (
                  <Scatter
                    key={s.id}
                    name={`Run #${s.id}`}
                    data={s.data}
                    fill={s.color}
                    stroke={s.color}
                    shape={s.shape}
                    isAnimationActive={!reducedMotion}
                    data-testid={`compare-scatter-${s.id}`}
                  />
                ))}
            </ScatterChart>
          </ResponsiveContainer>
        </ChartContainer>
      </div>
    </div>
  );
}
