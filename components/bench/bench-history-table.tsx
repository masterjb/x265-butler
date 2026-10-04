'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { SelectionBar } from '@/components/ui/selection-bar';
import { BenchEmptyState } from './bench-empty-state';
import { BenchRunDeleteAction } from './bench-run-delete-action';
import { BenchBulkActions } from './bench-bulk-actions';
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

// 47-02 3a (Pick B2): the SELECTION cap and the COMPARE cap are independent.
// MAX_SELECT is pinned to the bulk route's own MAX_BULK (app/api/bench/bulk-delete/
// route.ts:28) so no client/server drift is possible: >500 ids would fail the route's
// zod .max(MAX_BULK) as `400 invalid_body` and surface as the misleading *network*-error
// toast. The cap is HARD (toggleSelect refuses every add at the limit), so SelectionBar's
// over-cap warning is deliberately NOT wired — it could never become truthy (decision L).
// Exported so the <verification> cap-drift gate can grep both numbers (audit SR10);
// a comment alone is not a control.
export const MAX_SELECT = 500;
const MAX_COMPARE = 3;

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
  // 47-02 decision H: `runs` is useState(initialRuns) — its initial value is read only
  // at mount, so router.refresh() alone would leave a purged row on screen. totalCount
  // must become local state for the same reason (AC-7); it drives the empty-state and
  // the Load-More gate.
  const [total, setTotal] = useState(totalCount);
  // SR6 focus destination: the delete button the operator activated is unmounted by
  // handleDeleted, so focus would fall to <body> and a keyboard operator would lose
  // their place in a 50-row table. Move it to the table container instead.
  const tableWrapRef = useRef<HTMLDivElement | null>(null);

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
  const compareEnabled = selectedIds.size >= 2 && selectedIds.size <= MAX_COMPARE;

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

  // Shared by the row action (onDeleted([id])) and the bulk action (onDeleted(ids)).
  const handleDeleted = useCallback((ids: number[]) => {
    const idSet = new Set(ids);
    setRuns((prev) => prev.filter((r) => !idSet.has(r.id)));
    setTotal((prev) => Math.max(0, prev - ids.length));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    // If this emptied the table entirely the container unmounts and focus falls to
    // <body> — the empty state is then the only content, so that is acceptable.
    tableWrapRef.current?.focus();
  }, []);

  const goCompare = useCallback(() => {
    // Presentation disables the CTA; this is the guard that actually prevents a 4-id
    // compare URL if the disabled state is ever bypassed (audit SR5) — same predicate
    // as compareEnabled, not just the old `< 2` check.
    if (selectedIds.size < 2 || selectedIds.size > MAX_COMPARE) return;
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

  const canLoadMore = runs.length < total;
  const nowSec = Date.now() / 1000;

  if (total === 0) {
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
      </div>

      {selectedIds.size > 0 && (
        <SelectionBar
          count={selectedIds.size}
          onClear={clearSelection}
          countLabel={t('selection.count', { count: selectedIds.size })}
          clearLabel={t('selection.clear')}
          // No maxWarningLabel: the 500 cap is hard, so count > maxCap is unreachable
          // and the prop could never be truthy (decision L).
        >
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
          {!compareEnabled && (
            <span className="text-xs text-muted-foreground" data-testid="history-compare-hint">
              {t('compareHint')}
            </span>
          )}
          <BenchBulkActions
            ids={[...selectedIds]}
            onDeleted={handleDeleted}
            onAfter={clearSelection}
          />
        </SelectionBar>
      )}

      <div
        ref={tableWrapRef}
        tabIndex={-1}
        className="overflow-x-auto rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
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
              {/* w-20 → w-56: the P3 armed state adds an inline cancel button next to
                  the primary, which would otherwise crush this column. */}
              <th scope="col" className="px-3 py-2 w-56">
                {t('col.actions')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                  {/* audit M6: zero rows no longer implies total === 0. Optimistic
                      removal can empty the page while runs remain on the server, and
                      the old single branch told the operator "No runs match this
                      filter" next to an empty search box. Branch on the query. */}
                  {query.trim() === '' ? t('emptyPage') : t('emptyFiltered')}
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
                      {/* Deliberately NOT status-gated, unlike the row action (G2): an
                          active run CAN be selected and included in a bulk purge. The
                          server rejects it per-id with `active_run` and the mixed toast
                          is the operator's feedback — that is what makes AC-6's mixed
                          path reachable in production (audit SR4). */}
                      <Checkbox
                        checked={checked}
                        disabled={checkboxDisabled}
                        onCheckedChange={() => toggleSelect(run.id)}
                        aria-label={t('row.selectAria', { id: run.id })}
                        title={checkboxDisabled ? t('selectionLimit') : undefined}
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
                      <div className="flex items-center gap-2">
                        <Link href={detailHref} className="text-primary hover:underline text-xs">
                          {t('row.view')}
                        </Link>
                        <BenchRunDeleteAction run={run} onDeleted={handleDeleted} />
                      </div>
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
