'use client';

import { useState, useCallback, useEffect, useMemo, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PageContainer, PageHeader } from '@/components/page-layout';
import { CumulativeSavingsPill } from '@/components/trash/cumulative-savings-pill';
import { TrashTable } from '@/components/trash/trash-table';
import { TrashCardList } from '@/components/trash/trash-card-list';
import { TrashBulkActions } from '@/components/trash/trash-bulk-actions';
import { SelectionBar } from '@/components/ui/selection-bar';
import { Pagination } from '@/components/library/pagination';
import { useMultiSelect } from '@/src/lib/ui/use-multi-select';
import type { TrashEntryRow } from '@/src/lib/db/schema';

type Props = {
  initialRows: TrashEntryRow[];
  initialTotal: number;
  initialBytesReclaimed: number;
  initialCount: number;
  pagination: {
    page: number;
    size: number;
    total: number;
    pageCount: number;
  };
};

export function TrashClient({
  initialRows,
  initialBytesReclaimed,
  initialCount,
  pagination,
}: Props) {
  const t = useTranslations('trash');
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function pushUrl(updates: Partial<Record<'page' | 'size', string | null>>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v == null || v === '') params.delete(k);
      else params.set(k, v);
    }
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `?${qs}` : '?', { scroll: false });
    });
  }

  function onPageChange(next: number) {
    if (next < 1) return;
    pushUrl({ page: next === 1 ? null : String(next) });
  }
  function onSizeChange(next: number) {
    pushUrl({ size: next === 25 ? null : String(next), page: null });
  }

  const [rows, setRows] = useState<TrashEntryRow[]>(initialRows);
  const [bytesReclaimed, setBytesReclaimed] = useState(initialBytesReclaimed);
  const [summaryCount, setSummaryCount] = useState(initialCount);

  // 13-01b T2: base-ui Popover removed → RestoreButton owns its own confirm
  // state via ConfirmButton P1. The single-popover-open invariant (S6) +
  // openPopoverId pipe-through (formerly preventing dual-tree popup leaks)
  // are obsolete.
  // CSS `hidden md:block` would still risk dual mounting; preserve the JS-
  // toggled isDesktop so exactly one list is in the DOM.
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    setIsDesktop(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const handleRemoveRow = useCallback((id: number) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const handleSummaryRefetch = useCallback(async () => {
    try {
      const res = await fetch('/api/trash/summary');
      if (res.ok) {
        const data = (await res.json()) as { bytesReclaimed: number; count: number };
        setBytesReclaimed(data.bytesReclaimed);
        setSummaryCount(data.count);
      }
    } catch {
      // best-effort
    }
  }, []);

  // 13-02 T7-FIX1: bulk-action post-success refetch — full /api/trash list reload
  // (chosen over per-ID setRows-filter for simplicity). Single-endpoint Restore
  // still uses onRemoveRow for instant UX; bulk operations refetch the page.
  const handleRowsRefetch = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        page: String(pagination.page),
        size: String(pagination.size),
      });
      const res = await fetch(`/api/trash?${params.toString()}`);
      if (res.ok) {
        const data = (await res.json()) as { rows: TrashEntryRow[] };
        if (Array.isArray(data.rows)) setRows(data.rows);
      }
    } catch {
      // best-effort
    }
  }, [pagination.page, pagination.size]);

  // 13-02 T5: bulk-select state. Reset on page change via resetSignal.
  const visibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const resetSignal = `${pagination.page}|${pagination.size}`;
  const sel = useMultiSelect({ visibleIds, resetSignal });
  const selection = useMemo(
    () => ({
      isSelected: sel.isSelected,
      toggle: sel.toggle,
      headerState: sel.headerState,
      selectAllOnPage: () => sel.selectAllOnPage(visibleIds),
      visibleIds,
    }),
    [sel, visibleIds],
  );

  const tableProps = {
    rows,
    onRemoveRow: handleRemoveRow,
    onSummaryRefetch: () => void handleSummaryRefetch(),
    selection,
  };

  return (
    <PageContainer variant="data">
      <PageHeader title={t('title')} />

      {/* Cumulative savings pill (S8 refetches on restore) */}
      <CumulativeSavingsPill bytesReclaimed={bytesReclaimed} count={summaryCount} />

      {sel.selectedCount > 0 && (
        <SelectionBar
          count={sel.selectedCount}
          onClear={sel.clear}
          countLabel={t('selection.bar.label_count', { count: sel.selectedCount })}
          clearLabel={t('selection.bar.clear')}
          maxWarningLabel={
            sel.selectedCount > 500
              ? t('selection.bar.max_warning_over', {
                  count: sel.selectedCount,
                  overflow: sel.selectedCount - 500,
                })
              : undefined
          }
        >
          <TrashBulkActions
            ids={[...sel.selectedIds]}
            onAfter={() => {
              sel.clear();
              void handleSummaryRefetch();
              void handleRowsRefetch();
            }}
          />
        </SelectionBar>
      )}

      {/* Responsive table/cards — JS-toggled, see useEffect above. */}
      {isDesktop ? <TrashTable {...tableProps} /> : <TrashCardList {...tableProps} />}

      {/* 05-bonus: pagination footer (Library-parity). Hidden when zero. */}
      {pagination.total > 0 && (
        <Pagination
          page={pagination.page}
          size={pagination.size}
          total={pagination.total}
          pageCount={pagination.pageCount}
          onPageChange={onPageChange}
          onSizeChange={onSizeChange}
        />
      )}
    </PageContainer>
  );
}
