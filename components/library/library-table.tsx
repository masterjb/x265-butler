'use client';

import { useTranslations, useLocale } from 'next-intl';
import { ChevronUp, ChevronDown, ChevronsUpDown, Film } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { StatusChip, statusToI18nKey } from './status-chip';
import { EncodeNowAction } from './encode-now-action';
import { AddToBlocklistAction } from './add-to-blocklist-action';
import { LibraryRetryAction } from './retry-action';
import { SkipAction } from './skip-action';
import { cn } from '@/lib/utils';
import type { FileRow, FileStatus } from '@/src/lib/db/schema';
import {
  formatBytes,
  formatBitrate,
  formatDuration,
  formatRelativeTime,
  type FormatLocale,
} from '@/src/lib/format';
import type { SortKey, SortDir } from '@/src/lib/db/repos/file';
import { useState } from 'react';

type SortableColumn = SortKey;

// 13-02 T3: optional bulk-select prop. When undefined, no checkbox column renders.
export type LibraryTableSelection = {
  isSelected: (id: number) => boolean;
  toggle: (id: number) => void;
  headerState: 'none' | 'some' | 'all';
  selectAllOnPage: () => void;
  visibleIds: readonly number[];
};

export function LibraryTable({
  rows,
  sort,
  dir,
  onSort,
  onRowClick,
  rowRefs,
  selection,
}: {
  rows: FileRow[];
  sort: SortKey;
  dir: SortDir;
  onSort: (col: SortKey) => void;
  onRowClick: (row: FileRow, target: HTMLElement) => void;
  rowRefs?: React.MutableRefObject<Map<number, HTMLElement>>;
  selection?: LibraryTableSelection;
}) {
  const t = useTranslations('library');
  const locale = useLocale() as FormatLocale;
  const now = Math.floor(Date.now() / 1000);

  // audit-added S2 (02-04): optimistic override map for EncodeNowAction chip swap.
  const [optimisticOverrides, setOptimisticOverrides] = useState<Map<number, FileStatus>>(
    () => new Map(),
  );

  function handleOptimisticOverride(fileId: number, status: FileStatus | null) {
    setOptimisticOverrides((prev) => {
      const next = new Map(prev);
      if (status === null) next.delete(fileId);
      else next.set(fileId, status);
      return next;
    });
  }

  function ariaSort(col: SortableColumn): 'ascending' | 'descending' | 'none' {
    if (sort !== col) return 'none';
    return dir === 'asc' ? 'ascending' : 'descending';
  }

  function SortIndicator({ col }: { col: SortableColumn }) {
    if (sort !== col) {
      return <ChevronsUpDown className="size-3 opacity-40" aria-hidden="true" />;
    }
    return dir === 'asc' ? (
      <ChevronUp className="size-3" aria-hidden="true" />
    ) : (
      <ChevronDown className="size-3" aria-hidden="true" />
    );
  }

  function SortHeader({
    col,
    children,
    align,
  }: {
    col: SortableColumn;
    children: React.ReactNode;
    align?: 'left' | 'right';
  }) {
    return (
      <button
        type="button"
        onClick={() => onSort(col)}
        className={cn(
          'inline-flex items-center gap-1 select-none',
          'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        {children}
        <SortIndicator col={col} />
      </button>
    );
  }

  return (
    <Table>
      <TableHeader className="sticky top-0 z-10 bg-background">
        <TableRow>
          {selection && (
            <TableHead className="w-10 px-2">
              <Checkbox
                checked={selection.headerState === 'all'}
                indeterminate={selection.headerState === 'some'}
                onCheckedChange={() => selection.selectAllOnPage()}
                aria-label={t('selection.header.aria')}
                data-testid="library-bulk-select-all"
              />
            </TableHead>
          )}
          <TableHead className="w-12 text-right text-muted-foreground">{t('column.id')}</TableHead>
          <TableHead>{t('column.path')}</TableHead>
          <TableHead>{t('column.codec')}</TableHead>
          <TableHead className="text-right" aria-sort={ariaSort('bitrate')}>
            <SortHeader col="bitrate" align="right">
              {t('column.bitrate')}
            </SortHeader>
          </TableHead>
          <TableHead aria-sort={ariaSort('duration')}>
            <SortHeader col="duration">{t('column.duration')}</SortHeader>
          </TableHead>
          <TableHead className="text-right" aria-sort={ariaSort('size')}>
            <SortHeader col="size" align="right">
              {t('column.size')}
            </SortHeader>
          </TableHead>
          <TableHead>{t('column.status')}</TableHead>
          <TableHead aria-sort={ariaSort('scanned')}>
            <SortHeader col="scanned">{t('column.scanned')}</SortHeader>
          </TableHead>
          <TableHead className="w-[130px]" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const displayStatus = optimisticOverrides.get(row.id) ?? row.status;
          return (
            <TableRow
              key={row.id}
              tabIndex={0}
              role="button"
              ref={(el) => {
                if (!rowRefs) return;
                if (el) rowRefs.current.set(row.id, el);
                else rowRefs.current.delete(row.id);
              }}
              onClick={(e) => onRowClick(row, e.currentTarget)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onRowClick(row, e.currentTarget);
                }
              }}
              className="cursor-pointer"
            >
              {selection && (
                <TableCell className="w-10 px-2 align-middle" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={selection.isSelected(row.id)}
                    onCheckedChange={() => selection.toggle(row.id)}
                    aria-label={t('selection.row.aria', { filename: row.path })}
                    data-testid={`library-bulk-select-${row.id}`}
                  />
                </TableCell>
              )}
              <TableCell className="font-mono text-xs tabular-nums text-muted-foreground text-right w-12 select-all">
                #{row.id}
              </TableCell>
              <TableCell className="font-mono text-xs max-w-[28rem] truncate" title={row.path}>
                {row.path}
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1.5">
                  <Film className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  {row.codec ?? <span className="text-muted-foreground">—</span>}
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.bitrate != null ? (
                  formatBitrate(row.bitrate, locale)
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {row.duration_seconds != null ? (
                  formatDuration(row.duration_seconds)
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatBytes(row.size_bytes, locale)}
              </TableCell>
              <TableCell>
                <StatusChip
                  status={displayStatus}
                  label={t(`status.${statusToI18nKey(displayStatus)}`)}
                />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatRelativeTime(row.last_scanned_at, now, locale)}
              </TableCell>
              <TableCell className="text-right">
                <div
                  className="flex items-center justify-end gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <EncodeNowAction file={row} onOptimisticOverride={handleOptimisticOverride} />
                  {/* 05-09 SkipAction renders only when file.status ∈ {queued,encoding}. */}
                  <SkipAction file={row} />
                  <AddToBlocklistAction file={row} />
                  <LibraryRetryAction file={row} />
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
