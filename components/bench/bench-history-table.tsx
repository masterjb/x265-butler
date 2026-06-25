'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { BenchEmptyState } from './bench-empty-state';
import { formatRelativeTime } from '@/src/lib/format';
import { cn } from '@/lib/utils';
import type { BenchRunRow } from '@/src/lib/db/schema';

export interface TopBalancedSummary {
  encoder: string;
  preset: string | null;
  qualityValue: string;
  vmaf: number;
}

export interface BenchHistoryTableProps {
  initialRuns: BenchRunRow[];
  topBalancedByRunId: Record<number, TopBalancedSummary | null>;
  totalCount: number;
  locale: string;
}

const PAGE_SIZE = 50;
const MAX_SELECT = 3;

export function BenchHistoryTable({
  initialRuns,
  topBalancedByRunId,
  totalCount,
  locale,
}: BenchHistoryTableProps) {
  const t = useTranslations('bench.history');
  const router = useRouter();

  const [runs, setRuns] = useState<BenchRunRow[]>(initialRuns);
  const topByRun = topBalancedByRunId;
  const [query, setQuery] = useState('');
  const [sortDesc, setSortDesc] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filteredRuns = q
      ? runs.filter((r) => r.matrix.encoders.join(',').toLowerCase().includes(q))
      : runs;
    return [...filteredRuns].sort((a, b) =>
      sortDesc ? b.created_at - a.created_at : a.created_at - b.created_at,
    );
  }, [runs, query, sortDesc]);

  const capReached = selectedIds.size >= MAX_SELECT;
  const compareEnabled = selectedIds.size >= 2;

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_SELECT) {
        next.add(id);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const goCompare = useCallback(() => {
    if (selectedIds.size < 2) return;
    const ids = [...selectedIds].join(',');
    router.push(`/${locale}/bench/compare?ids=${ids}`);
  }, [selectedIds, locale, router]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/bench?limit=${PAGE_SIZE}&offset=${runs.length}`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      const data = (await res.json()) as { runs: BenchRunRow[] };
      setRuns((prev) => [...prev, ...data.runs]);
    } finally {
      setLoadingMore(false);
    }
  }, [runs.length]);

  const canLoadMore = runs.length < totalCount;
  const nowSec = Date.now() / 1000;

  if (totalCount === 0) {
    return <BenchEmptyState onStartBenchmark={() => undefined} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder={t('searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-xs"
          aria-label={t('searchPlaceholder')}
        />
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-2 ml-auto" data-testid="history-toolbar">
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={!compareEnabled}
              onClick={goCompare}
              data-testid="history-compare-cta"
            >
              {t('compareCta', { count: selectedIds.size })}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearSelection}
              data-testid="history-clear-cta"
            >
              {t('clearSelection')}
            </Button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm" data-testid="history-table">
          <caption className="sr-only">{t('title')}</caption>
          <thead className="bg-muted/50 text-left text-xs font-medium text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 w-10" aria-label="select" />
              <th
                scope="col"
                className="px-3 py-2 sticky left-10 bg-muted/50"
                aria-sort={sortDesc ? 'descending' : 'ascending'}
              >
                <button
                  type="button"
                  className="font-medium hover:text-foreground focus-visible:underline focus-visible:outline-none"
                  onClick={() => setSortDesc((v) => !v)}
                  data-testid="history-sort-created"
                >
                  {t('col.created')} {sortDesc ? '↓' : '↑'}
                </button>
              </th>
              <th scope="col" className="px-3 py-2">
                {t('col.mode')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('col.encoders')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('col.topCombo')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('col.status')}
              </th>
              <th scope="col" className="px-3 py-2 w-20">
                {t('col.actions')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                  {t('emptyFiltered')}
                </td>
              </tr>
            ) : (
              filtered.map((run) => {
                const top = topByRun[run.id];
                const checked = selectedIds.has(run.id);
                const checkboxDisabled = !checked && capReached;
                const detailHref = `/${locale}/bench/runs/${run.id}`;
                return (
                  <tr
                    key={run.id}
                    data-testid={`history-row-${run.id}`}
                    className={cn(
                      'border-t hover:bg-muted/30 focus-within:bg-muted/30',
                      checked && 'bg-muted/40',
                    )}
                  >
                    <td className="px-3 py-2">
                      <Checkbox
                        checked={checked}
                        disabled={checkboxDisabled}
                        onCheckedChange={() => toggleSelect(run.id)}
                        aria-label={`Select run #${run.id}`}
                        title={checkboxDisabled ? t('compareLimit') : undefined}
                        data-testid={`history-checkbox-${run.id}`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={detailHref}
                        className="block hover:underline focus-visible:underline focus-visible:outline-none"
                        data-testid={`history-row-link-${run.id}`}
                      >
                        {formatRelativeTime(run.created_at, nowSec)}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{run.mode === 'native-sweep' ? 'Native' : 'VMAF'}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {run.matrix.encoders.join(', ')}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {top
                        ? `${top.encoder}/${top.preset ?? '—'}@${top.qualityValue} · VMAF ${top.vmaf.toFixed(1)}`
                        : '—'}
                    </td>
                    <td className="px-3 py-2">{run.status}</td>
                    <td className="px-3 py-2">
                      <Link href={detailHref} className="text-primary hover:underline text-xs">
                        View →
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {canLoadMore && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loadingMore}
            onClick={loadMore}
            data-testid="history-load-more"
          >
            {t('loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}
