'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/page-layout';
import { BenchCompareView } from '@/components/bench/bench-compare-view';
import { formatRelativeTime } from '@/src/lib/format';
import type { BenchRunRow, AggregatedComboView } from '@/src/lib/db/schema';

export interface CompareEntry {
  id: number;
  run: BenchRunRow | null;
  summary: AggregatedComboView[];
}

export interface CompareClientProps {
  entries: CompareEntry[];
  missingIds: number[];
  fileSizeMap: Record<number, number>;
  locale: string;
}

export function CompareClient({ entries, missingIds, locale }: CompareClientProps) {
  const t = useTranslations('bench.compare');
  const tHistory = useTranslations('bench.history');
  const backHref = `/${locale}/bench?tab=history`;

  if (missingIds.length > 0) {
    return (
      <div className="space-y-4">
        <PageHeader
          title={t('title')}
          actions={
            <Link href={backHref} className="text-sm text-muted-foreground hover:text-foreground">
              ← Back
            </Link>
          }
        />
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm">
          <p role="alert" className="font-medium text-destructive">
            {t('missingIds', { count: missingIds.length, ids: missingIds.join(', #') })}
          </p>
        </div>
      </div>
    );
  }

  const validEntries = entries.flatMap((e) =>
    e.run !== null ? [{ id: e.id, run: e.run, summary: e.summary }] : [],
  );
  const nowSec = Date.now() / 1000;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        actions={
          <Link href={backHref} className="text-sm text-muted-foreground hover:text-foreground">
            {tHistory('clearSelection')}
          </Link>
        }
      />

      <BenchCompareView entries={validEntries} />

      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        {validEntries.map((e) => (
          <div
            key={e.id}
            className="rounded-md border p-3 text-sm"
            data-testid={`compare-run-card-${e.id}`}
          >
            <div className="font-mono text-xs text-muted-foreground">#{e.id}</div>
            <div className="text-muted-foreground">
              {formatRelativeTime(e.run.created_at, nowSec)}
            </div>
            <div className="mt-1 font-mono text-xs">{e.run.matrix.encoders.join(', ')}</div>
            <div className="text-xs">{e.run.status}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
