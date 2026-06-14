'use client';

import { Inbox } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';

interface BucketItem {
  bucket: string;
  count: number;
  color?: string;
}

interface Props {
  data: BucketItem[];
  total: number;
  title: string;
  emptyTitle: string;
  emptyBody: string;
}

export function StackedBar({ data, total, title, emptyTitle, emptyBody }: Props) {
  if (!data || data.length === 0 || total === 0) {
    return <EmptyState icon={Inbox} title={emptyTitle} body={emptyBody} />;
  }

  const ariaParts = data.map((b) => {
    const pct = Math.round((b.count / total) * 1000) / 10;
    return `${b.bucket}: ${b.count} (${pct}%)`;
  });
  const ariaLabel = `${title}: ${ariaParts.join(', ')}`;

  return (
    <div>
      <div
        role="img"
        tabIndex={0}
        aria-label={ariaLabel}
        className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <div className="flex h-6 overflow-hidden rounded">
          {data.map((b, i) => {
            const pct = (b.count / total) * 100;
            const color = b.color ?? `var(--chart-${(i % 5) + 1})`;
            return (
              <div
                key={b.bucket}
                style={{
                  width: `${pct}%`,
                  minWidth: pct > 0 ? '2px' : undefined,
                  backgroundColor: color,
                }}
                aria-hidden="true"
              />
            );
          })}
        </div>
      </div>
      <ul className="mt-3 flex flex-col gap-1 text-sm">
        {data.map((b, i) => {
          const pct = Math.round((b.count / total) * 1000) / 10;
          const color = b.color ?? `var(--chart-${(i % 5) + 1})`;
          return (
            <li key={b.bucket} className="flex items-center gap-2">
              <span
                className="inline-block h-3 w-3 flex-shrink-0 rounded-sm"
                style={{ backgroundColor: color }}
                aria-hidden="true"
              />
              <span className="font-medium">{b.bucket}</span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {b.count} ({pct}%)
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
