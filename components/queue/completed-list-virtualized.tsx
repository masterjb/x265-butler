'use client';

// Plan 05-12 (B3 Queue Reorder) — RIGHT pane: completed jobs (done / failed /
// cancelled / interrupted), reverse-chronological. Direction B layout per
// design-system/pages/queue.md §10.3: ALWAYS card-list (no md-table branch
// because the 360px width cap precludes a useful table render). Virtualizer
// engages when count > 50.

import { useRef } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useVirtualizer } from '@tanstack/react-virtual';
import { JobStatusChip } from './job-status-chip';
import { formatBytes, formatRelativeTime, type FormatLocale } from '@/src/lib/format';
import { fileNameOf, parentOf } from '@/src/lib/format/job-path';
import { Pagination } from '@/components/library/pagination';
import type { JobRow } from '@/src/lib/db/schema';

const VIRTUALIZER_THRESHOLD = 50;
const ROW_HEIGHT_ESTIMATE = 88;

const COMPLETED_FILTERS = ['done', 'failed', 'cancelled'] as const;
type CompletedFilter = (typeof COMPLETED_FILTERS)[number];
// 'completed' = no chip selected (default = show all 4 terminal statuses).
type CompletedStatusGroup = 'completed' | CompletedFilter;

function computeSavingsText(bytesIn: number | null, bytesOut: number | null): string {
  if (bytesIn == null || bytesOut == null || bytesIn === 0) return '—';
  const pct = ((bytesIn - bytesOut) / bytesIn) * 100;
  if (pct > 0) return `+${pct.toFixed(1)}%`;
  return `${pct.toFixed(1)}%`;
}

function CompletedCard({
  job,
  filePath,
  onClick,
}: {
  job: JobRow;
  filePath?: string;
  onClick?: (job: JobRow, target: HTMLElement) => void;
}) {
  const t = useTranslations('queue');
  const tRow = useTranslations('queue.row');
  const locale = useLocale() as FormatLocale;
  const now = Math.floor(Date.now() / 1000);
  const filename = filePath ? fileNameOf(filePath) : `#${job.file_id}`;
  const parent = filePath ? parentOf(filePath) : null;
  const parentDisplay = parent === '(root)' ? tRow('atRoot') : parent;
  const savings = computeSavingsText(job.bytes_in, job.bytes_out);

  return (
    <button
      type="button"
      onClick={(e) => onClick?.(job, e.currentTarget)}
      className="flex w-full flex-col gap-1 rounded-md border border-border bg-card p-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="truncate text-sm" title={filePath ?? undefined}>
        {filename}
      </span>
      {parentDisplay && (
        <span
          className="truncate font-mono text-xs text-muted-foreground"
          title={filePath ?? undefined}
        >
          {parentDisplay}
        </span>
      )}
      <div className="mt-1 flex items-center justify-between gap-2 text-xs">
        <JobStatusChip status={job.status} label={t(`status.${job.status}`)} />
        <span className="font-mono tabular-nums">{savings}</span>
      </div>
      <div className="text-xs text-muted-foreground" suppressHydrationWarning>
        {[
          job.bytes_in != null && job.bytes_out != null
            ? `${formatBytes(job.bytes_in, locale)} → ${formatBytes(job.bytes_out, locale)}`
            : '—',
          job.finished_at != null ? formatRelativeTime(job.finished_at, now, locale) : '—',
        ].join(' • ')}
      </div>
    </button>
  );
}

export interface CompletedListVirtualizedProps {
  initialCompleted: JobRow[];
  pathByFileId?: Record<number, string>;
  onRowClick?: (job: JobRow, target: HTMLElement) => void;
  pagination: { page: number; size: number; total: number; pageCount: number };
  statusGroup: CompletedStatusGroup;
  onStatusGroupChange: (next: CompletedStatusGroup) => void;
  onPageChange: (next: number) => void;
  onSizeChange: (next: number) => void;
}

export function CompletedListVirtualized({
  initialCompleted,
  pathByFileId,
  onRowClick,
  pagination,
  statusGroup,
  onStatusGroupChange,
  onPageChange,
  onSizeChange,
}: CompletedListVirtualizedProps) {
  const t = useTranslations('queue.completed');
  const parentRef = useRef<HTMLDivElement | null>(null);

  const useVirtual = initialCompleted.length > VIRTUALIZER_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: initialCompleted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    overscan: 5,
    enabled: useVirtual,
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          {t('title')} ({pagination.total})
        </h2>
        <div
          className="flex items-center gap-1 overflow-x-auto"
          role="radiogroup"
          aria-label={t('filter.aria')}
        >
          {COMPLETED_FILTERS.map((group) => {
            const active = statusGroup === group;
            return (
              <button
                key={group}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onStatusGroupChange(active ? 'completed' : group)}
                className={
                  'inline-flex shrink-0 items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors min-h-[32px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
                  (active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground')
                }
              >
                {t(`filter.${group}`)}
              </button>
            );
          })}
        </div>
      </div>

      {initialCompleted.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {t('empty.helper')}
        </div>
      ) : useVirtual ? (
        <div
          ref={parentRef}
          className="max-h-[60vh] overflow-y-auto"
          data-testid="completed-virtualizer-scroll"
        >
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((virt) => {
              const job = initialCompleted[virt.index];
              return (
                <div
                  key={virt.key}
                  data-index={virt.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virt.size}px`,
                    transform: `translateY(${virt.start}px)`,
                    padding: '4px 0',
                  }}
                >
                  <CompletedCard
                    job={job}
                    filePath={pathByFileId?.[job.file_id]}
                    onClick={onRowClick}
                  />
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {initialCompleted.map((job) => (
            <li key={job.id}>
              <CompletedCard
                job={job}
                filePath={pathByFileId?.[job.file_id]}
                onClick={onRowClick}
              />
            </li>
          ))}
        </ul>
      )}

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
    </div>
  );
}
