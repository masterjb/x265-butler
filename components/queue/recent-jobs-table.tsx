'use client';

import { useTranslations, useLocale } from 'next-intl';
import { ChevronUp, ChevronDown, ChevronsUpDown, History } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { JobStatusChip } from './job-status-chip';
import { SkipRowAction } from './skip-row-action';
import { cn } from '@/lib/utils';
import type { JobRow } from '@/src/lib/db/schema';
import {
  formatBytes,
  formatDuration,
  formatRelativeTime,
  type FormatLocale,
} from '@/src/lib/format';
import { fileNameOf, parentOf } from '@/src/lib/format/job-path';

// queue.md §3.3 — sortable columns.
export type RecentJobSortKey = 'finished' | 'savings' | 'duration';
export type RecentJobSortDir = 'asc' | 'desc';

function computeSavings(bytesIn: number | null, bytesOut: number | null) {
  if (bytesIn == null || bytesOut == null || bytesIn === 0) return null;
  return ((bytesIn - bytesOut) / bytesIn) * 100;
}

function SavingsCell({ bytesIn, bytesOut }: { bytesIn: number | null; bytesOut: number | null }) {
  const pct = computeSavings(bytesIn, bytesOut);
  if (pct == null) return <span className="text-muted-foreground">—</span>;
  if (pct > 0)
    return (
      <span className="text-green-700 dark:text-green-400 tabular-nums">+{pct.toFixed(1)}%</span>
    );
  if (pct < 0)
    return <span className="text-red-700 dark:text-red-400 tabular-nums">{pct.toFixed(1)}%</span>;
  return <span className="tabular-nums">0%</span>;
}

export function RecentJobsTable({
  jobs,
  pathByFileId,
  sort = 'finished',
  dir = 'desc',
  onSort,
  onRowClick,
}: {
  jobs: JobRow[];
  pathByFileId?: Record<number, string>;
  sort?: RecentJobSortKey;
  dir?: RecentJobSortDir;
  onSort?: (col: RecentJobSortKey) => void;
  onRowClick?: (job: JobRow, target: HTMLElement) => void;
}) {
  const t = useTranslations('queue');
  const tRow = useTranslations('queue.row');
  const locale = useLocale() as FormatLocale;
  const now = Math.floor(Date.now() / 1000);

  function ariaSort(col: RecentJobSortKey): 'ascending' | 'descending' | 'none' {
    if (sort !== col) return 'none';
    return dir === 'asc' ? 'ascending' : 'descending';
  }

  function SortIndicator({ col }: { col: RecentJobSortKey }) {
    if (sort !== col) return <ChevronsUpDown className="size-3 opacity-40" aria-hidden="true" />;
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
    col: RecentJobSortKey;
    children: React.ReactNode;
    align?: 'right';
  }) {
    return (
      <button
        type="button"
        onClick={() => onSort?.(col)}
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

  if (jobs.length === 0) {
    return (
      <EmptyState
        icon={History}
        title={t('recent.empty.headline')}
        body={t('recent.empty.helper')}
      />
    );
  }

  return (
    <Table>
      <TableHeader className="sticky top-0 z-10 bg-background">
        <TableRow>
          <TableHead>{t('recent.column.file')}</TableHead>
          <TableHead>{t('recent.column.status')}</TableHead>
          <TableHead>{t('recent.column.encoder')}</TableHead>
          <TableHead className="text-right">{t('recent.column.bytes')}</TableHead>
          <TableHead className="text-right">{t('recent.column.savings')}</TableHead>
          <TableHead className="text-right" aria-sort={ariaSort('duration')}>
            <SortHeader col="duration" align="right">
              {t('recent.column.duration')}
            </SortHeader>
          </TableHead>
          <TableHead className="text-right" aria-sort={ariaSort('finished')}>
            <SortHeader col="finished" align="right">
              {t('recent.column.finished')}
            </SortHeader>
          </TableHead>
          {/* 05-09: Skip column — only renders the action for queued/encoding rows. */}
          <TableHead className="text-right">{t('recent.column.skip')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.map((job) => (
          <TableRow
            key={job.id}
            tabIndex={0}
            role="button"
            onClick={(e) => onRowClick?.(job, e.currentTarget)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onRowClick?.(job, e.currentTarget);
              }
            }}
            className="cursor-pointer"
          >
            <TableCell className="max-w-[20rem]">
              {(() => {
                const fullPath = pathByFileId?.[job.file_id];
                if (!fullPath) {
                  return (
                    <span
                      className="font-mono text-xs text-muted-foreground"
                      title={String(job.file_id)}
                    >
                      #{job.file_id}
                    </span>
                  );
                }
                const name = fileNameOf(fullPath);
                const parent = parentOf(fullPath);
                const parentDisplay = parent === '(root)' ? tRow('atRoot') : parent;
                return (
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm truncate" title={fullPath}>
                      {name}
                    </span>
                    <span
                      className="font-mono text-xs text-muted-foreground truncate"
                      title={fullPath}
                    >
                      {parentDisplay}
                    </span>
                  </div>
                );
              })()}
            </TableCell>
            <TableCell>
              <JobStatusChip status={job.status} label={t(`status.${job.status}`)} />
            </TableCell>
            <TableCell>
              {job.encoder ? (
                <span className="font-mono text-xs">{job.encoder}</span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="text-right tabular-nums text-xs">
              {job.bytes_in != null && job.bytes_out != null ? (
                <>
                  {formatBytes(job.bytes_in, locale)}
                  {' → '}
                  {formatBytes(job.bytes_out, locale)}
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="text-right">
              <SavingsCell bytesIn={job.bytes_in} bytesOut={job.bytes_out} />
            </TableCell>
            <TableCell className="text-right font-mono text-xs">
              {job.duration_ms != null ? (
                formatDuration(job.duration_ms / 1000)
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="text-right text-muted-foreground text-xs">
              {job.finished_at != null ? formatRelativeTime(job.finished_at, now, locale) : '—'}
            </TableCell>
            <TableCell
              className="text-right"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <SkipRowAction job={job} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
