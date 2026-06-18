'use client';

import { Inbox } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { FormatLocale } from '@/src/lib/format';
import { formatBytes } from '@/src/lib/format';
import { EmptyState } from '@/components/empty-state';
import type { EncoderPerfRow } from '@/src/lib/db';

interface Props {
  rows: EncoderPerfRow[];
  locale: FormatLocale;
}

export function CssEncoderBar({ rows, locale }: Props) {
  const t = useTranslations('stats.charts');

  if (!rows || rows.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title={t('encoderPerf.empty.title')}
        body={t('encoderPerf.empty.body')}
      />
    );
  }

  const maxBytes = Math.max(...rows.map((r) => r.totalSavedBytes), 1);

  return (
    <div
      data-testid="css-encoder-bar"
      aria-label={t('encoderPerf.chartAria')}
      role="img"
      className="flex flex-col gap-2"
    >
      {rows.map((row, i) => {
        const pct = (row.totalSavedBytes / maxBytes) * 100;
        const color = `var(--chart-${(i % 5) + 1})`;
        return (
          <div key={row.encoder} className="flex items-center gap-3">
            <span className="w-20 shrink-0 truncate text-sm font-medium">{row.encoder}</span>
            <div className="flex-1">
              <div
                style={{
                  width: `${pct}%`,
                  backgroundColor: color,
                  minWidth: pct > 0 ? '2px' : undefined,
                }}
                className="h-5 rounded-sm"
                aria-hidden="true"
              />
            </div>
            <span className="w-20 text-right font-mono text-xs tabular-nums text-muted-foreground">
              {formatBytes(row.totalSavedBytes, locale)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
