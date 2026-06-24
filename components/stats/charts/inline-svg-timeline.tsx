'use client';

import { Inbox } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import type { FormatLocale } from '@/src/lib/format';
import { formatBytes } from '@/src/lib/format';
import { EmptyState } from '@/components/empty-state';
import type { StatsTrendPointFull } from '@/src/lib/db';

interface Props {
  data: StatsTrendPointFull[];
  locale: FormatLocale;
}

export function InlineSvgTimeline({ data, locale }: Props) {
  const t = useTranslations('stats.charts');
  const tl = useTranslations('stats.timeline');

  const isEmpty = !data || data.every((d) => d.savings === 0 && d.jobCount === 0);
  if (isEmpty) {
    return (
      <EmptyState
        icon={Inbox}
        title={t('savingsTimeline.empty.title' as Parameters<typeof t>[0])}
        body={t('savingsTimeline.empty.body' as Parameters<typeof t>[0])}
      />
    );
  }

  let cumulative = 0;
  const chartData = data.map((d) => {
    cumulative += d.savings;
    return { ...d, cumulative };
  });

  const config: ChartConfig = {
    savings: { label: tl('daily'), color: 'var(--chart-1)' },
    cumulative: { label: tl('cumulative'), color: 'var(--chart-2)' },
  };

  const tickFormatter = (d: string): string => {
    const dt = new Date(`${d}T00:00:00Z`);
    return `${String(dt.getUTCDate()).padStart(2, '0')}.${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  return (
    <div data-testid="inline-svg-timeline">
      <p className="mb-1 text-xs text-muted-foreground">
        {t('savingsTimeline.subtitle' as Parameters<typeof t>[0])}
      </p>
      <div
        role="img"
        tabIndex={0}
        aria-label={t('savingsTimeline.chartAria' as Parameters<typeof t>[0])}
      >
        <ChartContainer config={config} className="h-[200px] w-full">
          <ComposedChart data={chartData} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
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
                  labelFormatter={(label) => `${String(label)} (UTC)`}
                  formatter={(value) => formatBytes(typeof value === 'number' ? value : 0, locale)}
                />
              }
            />
            <Bar dataKey="savings" fill="var(--chart-1)" fillOpacity={0.7} />
            <Line
              type="monotone"
              dataKey="cumulative"
              stroke="var(--chart-2)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </ComposedChart>
        </ChartContainer>
      </div>
    </div>
  );
}
