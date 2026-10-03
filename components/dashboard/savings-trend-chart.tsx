'use client';

// 03-04 Plan Task 2 — Savings Trend line chart per dashboard.md §4.
// Audit findings landed:
// - M4: 'use client' first line (recharts crashes on SSR).
// - S8: recharts imported ONLY in this file (grep regression gate).

import { Receipt } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SectionHint } from '@/components/stats/charts/section-hint';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { formatBytes, formatBytesAccessible, type FormatLocale } from '@/src/lib/format';

interface TrendPoint {
  date: string; // YYYY-MM-DD UTC
  bytesIn: number;
  bytesOut: number;
  savings: number;
}

interface Props {
  stats: {
    trend?: TrendPoint[];
  } | null;
}

export function SavingsTrendChart({ stats }: Props) {
  const t = useTranslations('dashboard.chart');
  const locale = useLocale() as FormatLocale;
  const trend = stats?.trend ?? [];
  const allZero = trend.every((p) => p.savings === 0);

  if (trend.length === 0 || allZero) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-1.5">
            <CardTitle>{t('title')}</CardTitle>
            <SectionHint content={t('hint')} />
          </div>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
          <Receipt className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
          <h3 className="text-lg font-semibold">{t('empty.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('empty.body')}</p>
        </CardContent>
      </Card>
    );
  }

  const peak = trend.reduce((m, p) => (p.savings > m.savings ? p : m), trend[0]);
  const total = trend.reduce((s, p) => s + p.savings, 0);
  const aria = t('aria', {
    total: formatBytesAccessible(total, locale),
    date: peak.date,
    peak: formatBytesAccessible(peak.savings, locale),
  });

  const config: ChartConfig = {
    savings: {
      label: t('tooltip.savings', { value: '' }).trim(),
      color: 'var(--chart-1)',
    },
  };

  // X-axis: only show every 5th tick to avoid clutter on mobile.
  const tickFormatter = (d: string): string => {
    const dt = new Date(`${d}T00:00:00Z`);
    const day = String(dt.getUTCDate()).padStart(2, '0');
    const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
    return `${day}.${month}`;
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-1.5">
          <CardTitle>{t('title')}</CardTitle>
          <SectionHint content={t('hint')} />
        </div>
      </CardHeader>
      <CardContent>
        <div role="img" tabIndex={0} aria-label={aria}>
          <ChartContainer config={config} className="h-[280px] w-full">
            <LineChart data={trend} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={tickFormatter}
                interval={4}
                tickLine={false}
                axisLine={false}
                fontSize={11}
              />
              <YAxis
                tickFormatter={(v: number) => formatBytes(v, locale)}
                tickCount={4}
                tickLine={false}
                axisLine={false}
                fontSize={11}
                width={70}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, _name, item) => {
                      const v = typeof value === 'number' ? value : 0;
                      const dateRaw = (item?.payload?.date as string) ?? '';
                      return (
                        <div className="grid gap-0.5">
                          <div className="text-xs text-muted-foreground">
                            {t('tooltip.dateUtc', { date: dateRaw })}
                          </div>
                          <div className="font-mono text-sm">
                            {t('tooltip.savings', { value: formatBytes(v, locale) })}
                          </div>
                        </div>
                      );
                    }}
                  />
                }
              />
              <Line
                type="monotone"
                dataKey="savings"
                stroke="var(--chart-1)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ChartContainer>
        </div>
      </CardContent>
    </Card>
  );
}
