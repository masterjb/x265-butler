'use client';

import { useTranslations, useLocale } from 'next-intl';
import { JobStatusChip } from './job-status-chip';
import { SkipRowAction } from './skip-row-action';
import type { JobRow } from '@/src/lib/db/schema';
import {
  formatBytes,
  formatDuration,
  formatRelativeTime,
  type FormatLocale,
} from '@/src/lib/format';
import { fileNameOf, parentOf } from '@/src/lib/format/job-path';

// queue.md §3.4 — mobile stacked cards (mirrors library-card-list.tsx pattern).

function computeSavingsText(bytesIn: number | null, bytesOut: number | null): string {
  if (bytesIn == null || bytesOut == null || bytesIn === 0) return '—';
  const pct = ((bytesIn - bytesOut) / bytesIn) * 100;
  if (pct > 0) return `+${pct.toFixed(1)}%`;
  return `${pct.toFixed(1)}%`;
}

export function RecentJobsCardList({
  jobs,
  pathByFileId,
  onCardClick,
}: {
  jobs: JobRow[];
  pathByFileId?: Record<number, string>;
  onCardClick?: (job: JobRow, target: HTMLElement) => void;
}) {
  const t = useTranslations('queue');
  const tRow = useTranslations('queue.row');
  const locale = useLocale() as FormatLocale;
  const now = Math.floor(Date.now() / 1000);

  return (
    <ul className="flex flex-col gap-2">
      {jobs.map((job) => (
        <li
          key={job.id}
          className="rounded-lg border border-border bg-card transition-all duration-150 hover:bg-muted/50"
        >
          <button
            type="button"
            onClick={(e) => onCardClick?.(job, e.currentTarget)}
            className="block w-full rounded-t-lg p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {/* Row 1: filename (top) + parent path (muted, monospace) — 05-10 B2 */}
            {(() => {
              const fullPath = pathByFileId?.[job.file_id];
              if (!fullPath) {
                return (
                  <div className="font-mono text-xs text-muted-foreground truncate">
                    #{job.file_id}
                  </div>
                );
              }
              const name = fileNameOf(fullPath);
              const parent = parentOf(fullPath);
              const parentDisplay = parent === '(root)' ? tRow('atRoot') : parent;
              return (
                <div className="flex flex-col min-w-0">
                  <span className="text-sm text-foreground truncate" title={fullPath}>
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
            {/* Row 2: status chip + savings */}
            <div className="mt-2 flex items-center justify-between gap-2">
              <JobStatusChip status={job.status} label={t(`status.${job.status}`)} />
              <span className="font-mono text-xs tabular-nums text-foreground">
                {computeSavingsText(job.bytes_in, job.bytes_out)}
              </span>
            </div>
            {/* Row 3: bytes + duration + time */}
            <div className="mt-1 text-xs text-muted-foreground">
              {[
                job.bytes_in != null && job.bytes_out != null
                  ? `${formatBytes(job.bytes_in, locale)} → ${formatBytes(job.bytes_out, locale)}`
                  : '—',
                job.duration_ms != null ? formatDuration(job.duration_ms / 1000) : '—',
                job.finished_at != null ? formatRelativeTime(job.finished_at, now, locale) : '—',
              ].join(' • ')}
            </div>
          </button>
          {/* 05-09: Skip affordance below the card body for active|queued rows. */}
          {(job.status === 'queued' || job.status === 'encoding') && (
            <div className="border-t border-border px-3 py-2">
              <SkipRowAction job={job} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
