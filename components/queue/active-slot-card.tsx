'use client';

import { useEffect, useRef } from 'react';
import { Loader2, MoonStar } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/src/lib/format';
import { fileNameOf, parentOf } from '@/src/lib/format/job-path';
import type { ActiveJob } from '@/src/lib/api/engine-events-client';
import { SkipRowAction } from './skip-row-action';

// 05-09: queue.md §3.1 hero card — idle state + active state with progress
// + Skip affordance (replaces 05-08 2-step Cancel; semantic is now "throw
// away progress + file→pending" per Option B redesign).

function ProgressBar({ valueNow, max = 100 }: { valueNow: number | null; max?: number }) {
  const pct = valueNow != null && max > 0 ? Math.min(100, (valueNow / max) * 100) : null;
  return (
    <div
      role="progressbar"
      aria-valuenow={pct != null ? Math.round(pct) : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-3 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn(
          'h-full rounded-full bg-violet-500 transition-all duration-300',
          pct == null && 'animate-pulse opacity-50',
        )}
        style={{ width: pct != null ? `${pct.toFixed(1)}%` : '40%' }}
      />
    </div>
  );
}

export function ActiveSlotCard({
  activeJob,
  filePath,
  fileDurationSeconds,
  fileSizeBytes,
}: {
  activeJob: ActiveJob | null;
  filePath?: string | null;
  fileDurationSeconds?: number | null;
  fileSizeBytes?: number | null;
}) {
  const t = useTranslations('queue.active');
  const tRow = useTranslations('queue.row');
  const ariaLiveRef = useRef<HTMLDivElement>(null);

  // Reset announcer when active job clears.
  useEffect(() => {
    if (!activeJob && ariaLiveRef.current) {
      ariaLiveRef.current.textContent = '';
    }
  }, [activeJob]);

  if (!activeJob) {
    return (
      <Card className="min-h-[200px]">
        <CardContent className="flex min-h-[200px] flex-col items-center justify-center gap-3 text-center">
          <MoonStar className="size-12 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="font-medium text-foreground">{t('idleHeadline')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('idleHelper')}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const progressPct =
    activeJob.outTimeMs != null && fileDurationSeconds != null && fileDurationSeconds > 0
      ? (activeJob.outTimeMs / (fileDurationSeconds * 1000)) * 100
      : null;

  const processedDisplay = activeJob.totalSize != null ? formatBytes(activeJob.totalSize) : '—';
  const totalDisplay = fileSizeBytes != null ? formatBytes(fileSizeBytes) : '—';
  // ETA: complex realtime tracking deferred (D12).
  const etaDisplay = '—';

  // Build a synthetic JobRow shape for SkipRowAction — only id + status are
  // consulted by the action.
  const skipJobRow = {
    id: activeJob.jobId,
    file_id: activeJob.fileId,
    status: 'encoding' as const,
    started_at: null,
    finished_at: null,
    encoder: activeJob.encoder ?? null,
    bytes_in: null,
    bytes_out: null,
    duration_ms: null,
    exit_code: null,
    error_msg: null,
    log_tail: null,
    created_at: 0,
    crf: null,
    queue_position: 0,
  };

  return (
    <Card className="border-l-4 border-l-violet-500">
      {/* aria-live: announce skip submission for screen readers */}
      <div ref={ariaLiveRef} aria-live="polite" className="sr-only" />
      <CardContent className="flex flex-col gap-4">
        {/* Header: filename + parent path (05-10 B2) + Skip button */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Loader2 className="size-4 shrink-0 text-violet-500 animate-spin" aria-hidden="true" />
            {filePath ? (
              <div className="flex flex-col min-w-0">
                <span className="text-sm truncate text-foreground" title={filePath}>
                  {fileNameOf(filePath)}
                </span>
                <span className="font-mono text-xs text-muted-foreground truncate" title={filePath}>
                  {(() => {
                    const p = parentOf(filePath);
                    return p === '(root)' ? tRow('atRoot') : p;
                  })()}
                </span>
              </div>
            ) : (
              <span className="font-mono text-sm truncate text-foreground">#{activeJob.jobId}</span>
            )}
          </div>
          <SkipRowAction job={skipJobRow} />
        </div>

        {/* Progress bar */}
        <ProgressBar valueNow={progressPct} />

        {/* 3 stat tiles */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-3xl font-semibold tabular-nums">
              {progressPct != null ? `${Math.round(progressPct)}%` : '—'}
            </span>
            <span className="font-mono text-xs text-muted-foreground">{t('statProgress')}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-3xl font-semibold tabular-nums">
              {activeJob.fps != null ? Math.round(activeJob.fps) : '—'}
            </span>
            <span className="font-mono text-xs text-muted-foreground">{t('statFps')}</span>
          </div>
          <div className="col-span-2 flex flex-col gap-0.5 md:col-span-1">
            <span className="text-3xl font-semibold tabular-nums">{etaDisplay}</span>
            <span className="font-mono text-xs text-muted-foreground">{t('statEta')}</span>
          </div>
        </div>

        {/* Footer: bytes + encoder + jobId */}
        <div className="flex items-center justify-between text-xs">
          <span className="font-mono tabular-nums text-muted-foreground">
            {t('statBytes', { processed: processedDisplay, total: totalDisplay })}
          </span>
          <div className="flex items-center gap-2">
            {activeJob.encoder && (
              <span className="font-mono rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                {t('encoderBadge')}: {activeJob.encoder}
              </span>
            )}
            <span className="text-muted-foreground">
              {t('jobIdBadge', { jobId: activeJob.jobId })}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
