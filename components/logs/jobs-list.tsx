'use client';

// 05-03 T2.C: jobs list (Per-Job tab sidebar / sheet).
// Phase 5 Plan 05-03 — AC-6.

import { useLocale, useTranslations } from 'next-intl';
import { FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/empty-state';

export interface JobLogEntry {
  id: number;
  fileId: number;
  status: string;
  encoder: string | null;
  createdAt: number;
  finishedAt: number | null;
  filePath: string | null;
  fileBasename: string | null;
  durationMs: number | null;
}

const ACTIVE_STATUSES = new Set(['queued', 'encoding']);

function basenameOrFallback(entry: JobLogEntry): string {
  return entry.fileBasename ?? entry.filePath ?? `Job #${entry.id}`;
}

// Locale-aware relative time. Uses Intl.RelativeTimeFormat per MASTER §11
// "Numbers/dates formatted via Intl". Falls back to English when locale unsupported.
function formatRelative(timestampSec: number, locale: string, now: number = Date.now()): string {
  const deltaSec = Math.max(0, Math.floor(now / 1000 - timestampSec));
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' });
  if (deltaSec < 60) return rtf.format(-deltaSec, 'second');
  if (deltaSec < 3600) return rtf.format(-Math.floor(deltaSec / 60), 'minute');
  if (deltaSec < 86400) return rtf.format(-Math.floor(deltaSec / 3600), 'hour');
  return rtf.format(-Math.floor(deltaSec / 86400), 'day');
}

export function JobsList({
  entries,
  selectedJobId,
  onSelect,
  className,
}: {
  entries: JobLogEntry[];
  selectedJobId: string | null;
  onSelect: (jobId: string) => void;
  className?: string;
}) {
  const t = useTranslations('logs.perJob');
  const locale = useLocale();

  if (entries.length === 0) {
    return (
      <div className={cn('p-4', className)}>
        <EmptyState icon={FileText} title={t('list.empty.title')} body={t('list.empty.body')} />
      </div>
    );
  }

  return (
    <ul
      role="listbox"
      aria-label={t('list.aria')}
      className={cn('flex flex-col divide-y divide-border', className)}
    >
      {entries.map((entry) => {
        const isActive = ACTIVE_STATUSES.has(entry.status);
        const isSelected = selectedJobId === String(entry.id);
        return (
          <li key={entry.id} role="option" aria-selected={isSelected}>
            <button
              type="button"
              onClick={() => onSelect(String(entry.id))}
              className={cn(
                'flex w-full flex-col items-start gap-1 px-3 py-2 text-left transition-colors',
                'hover:bg-muted focus:bg-muted focus:outline-none',
                isSelected && 'bg-muted',
              )}
            >
              <div className="flex w-full items-center gap-2">
                {isActive ? (
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 shrink-0 rounded-full bg-emerald-500 motion-safe:animate-pulse"
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40"
                  />
                )}
                <span className="flex-1 truncate font-mono text-xs">
                  {basenameOrFallback(entry)}
                </span>
                <Badge variant="outline" className="text-xs">
                  {entry.status}
                </Badge>
              </div>
              <div className="flex w-full items-center gap-3 text-xs text-muted-foreground">
                <span>#{entry.id}</span>
                {entry.encoder ? <span>{entry.encoder}</span> : null}
                {entry.durationMs ? <span>{Math.round(entry.durationMs / 1000)}s</span> : null}
                <span className="ml-auto">
                  {formatRelative(entry.finishedAt ?? entry.createdAt, locale)}
                </span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
