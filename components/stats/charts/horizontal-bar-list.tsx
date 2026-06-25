'use client';

import { useState } from 'react';
import { Inbox } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { EmptyState } from '@/components/empty-state';

interface BarItem {
  label: string;
  count: number;
  color?: string;
}

interface Props {
  data: BarItem[];
  title: string;
  emptyTitle: string;
  emptyBody: string;
  sortable?: boolean;
}

export function HorizontalBarList({ data, title, emptyTitle, emptyBody, sortable }: Props) {
  const t = useTranslations('stats.charts');
  const [asc, setAsc] = useState(false);

  if (!data || data.length === 0) {
    return <EmptyState icon={Inbox} title={emptyTitle} body={emptyBody} />;
  }

  const sorted = sortable
    ? [...data].sort((a, b) => (asc ? a.count - b.count : b.count - a.count))
    : data;

  const max = Math.max(...sorted.map((d) => d.count), 1);
  const direction = asc ? 'ascending' : 'descending';
  const topItem = sorted[0];
  const ariaLabel = `${title}: ${sorted.length} categories, top: ${topItem.label} ${topItem.count}`;

  return (
    <div>
      {sortable && (
        <button
          type="button"
          className="mb-2 text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setAsc((v) => !v)}
          aria-label={t('sortToggle.aria', { direction: asc ? 'descending' : 'ascending' })}
        >
          {asc ? '↑' : '↓'} {t('sortToggle.aria', { direction })}
        </button>
      )}
      <ul
        role="table"
        aria-label={ariaLabel}
        aria-sort={sortable ? direction : undefined}
        className="flex flex-col gap-1"
      >
        {sorted.map((item, i) => {
          const pct = (item.count / max) * 100;
          const color = item.color ?? `var(--chart-${(i % 5) + 1})`;
          return (
            <li key={item.label} className="flex items-center gap-2 text-sm" role="row">
              <span className="w-36 shrink-0 truncate text-muted-foreground">{item.label}</span>
              <div className="flex-1">
                <div
                  style={{
                    width: `${pct}%`,
                    backgroundColor: color,
                    minWidth: pct > 0 ? '2px' : undefined,
                  }}
                  className="h-4 rounded-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-hidden="true"
                />
              </div>
              <span className="w-10 text-right font-mono tabular-nums text-xs">{item.count}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
