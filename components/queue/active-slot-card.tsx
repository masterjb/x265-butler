'use client';

import { useRef } from 'react';
import { Loader2, MoonStar } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { fileNameOf, parentOf } from '@/src/lib/format/job-path';
import type { ActiveJob } from '@/src/lib/api/engine-events-client';
import { SkipRowAction } from './skip-row-action';

// 05-09 → 36-02: queue.md §3.1 hero card refactored into a compact multi-row
// panel (D1=B). At encode_parallelism >= 2 the queue page renders ONE
// "Active (N)" card with a per-job row + thin progressbar — fixing both the
// single-bar limit and the disappear bug (root cause: the SSE store's single
// active slot, fixed in engine-events-client.tsx 36-02). The old single-hero
// 3-stat-tile layout is dropped for dense inline metrics. `ActiveSlotCard`
// stays exported as a thin single-job wrapper for the dashboard LiveQueueCard
// (D2=B single-summary) + back-compat tests.

// Per-job file meta resolved client-side (audit-S6: no filePath on the SSE wire).
export interface ActiveJobMeta {
  path: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
}

function ProgressBar({
  valueNow,
  max = 100,
  thin = false,
}: {
  valueNow: number | null;
  max?: number;
  thin?: boolean;
}) {
  const pct = valueNow != null && max > 0 ? Math.min(100, (valueNow / max) * 100) : null;
  return (
    <div
      role="progressbar"
      aria-valuenow={pct != null ? Math.round(pct) : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn('w-full overflow-hidden rounded-full bg-muted', thin ? 'h-2' : 'h-3')}
    >
      <div
        className={cn(
          'h-full rounded-full bg-violet-500 transition-all duration-300',
          // ui-ux-pro-max (AC-9): indeterminate pulse is motion-safe — disabled
          // under prefers-reduced-motion.
          pct == null && 'opacity-50 motion-safe:animate-pulse',
        )}
        style={{ width: pct != null ? `${pct.toFixed(1)}%` : '40%' }}
      />
    </div>
  );
}

function progressPctOf(job: ActiveJob, durationSeconds: number | null): number | null {
  return job.outTimeMs != null && durationSeconds != null && durationSeconds > 0
    ? (job.outTimeMs / (durationSeconds * 1000)) * 100
    : null;
}

// Build a synthetic JobRow for SkipRowAction — only id + status are consulted.
function skipJobRowOf(job: ActiveJob) {
  return {
    id: job.jobId,
    file_id: job.fileId,
    status: 'encoding' as const,
    started_at: null,
    finished_at: null,
    encoder: job.encoder ?? null,
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
}

// 36-02: one dense row per active encode — spinner + filename/path (or #jobId
// fallback), a thin progressbar, inline {pct} · {fps} metric + encoder badge,
// and a per-row Skip (>=44px, aria-label naming the job).
export function ActiveJobRow({
  job,
  filePath,
  fileDurationSeconds,
}: {
  job: ActiveJob;
  filePath?: string | null;
  fileDurationSeconds?: number | null;
}) {
  const t = useTranslations('queue.active');
  const tRow = useTranslations('queue.row');
  const ariaLiveRef = useRef<HTMLDivElement>(null);

  const progressPct = progressPctOf(job, fileDurationSeconds ?? null);
  const pctDisplay = progressPct != null ? `${Math.round(progressPct)}%` : '—';
  const fpsDisplay = job.fps != null ? String(Math.round(job.fps)) : '—';
  // AC-4: per-row Skip control must be identifiable by assistive tech (every
  // row's button shares the generic "Skip" label). Wrap it in a role="group"
  // named for THIS job so a screen reader announces which job it targets.
  const skipName = filePath ? fileNameOf(filePath) : `#${job.jobId}`;

  return (
    <div className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      {/* aria-live: announce skip submission for screen readers */}
      <div ref={ariaLiveRef} aria-live="polite" className="sr-only" />
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Loader2
            className="size-4 shrink-0 text-violet-500 motion-safe:animate-spin"
            aria-hidden="true"
          />
          {filePath ? (
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm text-foreground" title={filePath}>
                {fileNameOf(filePath)}
              </span>
              <span className="truncate font-mono text-xs text-muted-foreground" title={filePath}>
                {(() => {
                  const p = parentOf(filePath);
                  return p === '(root)' ? tRow('atRoot') : p;
                })()}
              </span>
            </div>
          ) : (
            <span className="truncate font-mono text-sm text-foreground">#{job.jobId}</span>
          )}
        </div>
        <div role="group" aria-label={t('skipAria', { name: skipName })} className="shrink-0">
          <SkipRowAction job={skipJobRowOf(job)} />
        </div>
      </div>

      <ProgressBar valueNow={progressPct} thin />

      {/* Inline metrics: {pct} · {fps} fps + encoder badge (replaces the old 3 hero stat tiles) */}
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-mono tabular-nums text-muted-foreground">
          {t('metricLine', { pct: pctDisplay, fps: fpsDisplay })}
        </span>
        {job.encoder && (
          <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            {t('encoderBadge')}: {job.encoder}
          </span>
        )}
      </div>
    </div>
  );
}

// 36-02: idle MoonStar state (extracted so both the panel and the single-job
// wrapper share identical copy).
function IdleCard() {
  const t = useTranslations('queue.active');
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

// 36-02 (D1=B): the "Active (N)" panel — one card, a divide-y list of compact
// rows, one per concurrent encode. Empty → the idle MoonStar card.
export function ActiveJobsPanel({
  jobs,
  metaById,
}: {
  jobs: ActiveJob[];
  metaById: Record<number, ActiveJobMeta>;
}) {
  const t = useTranslations('queue.active');

  if (jobs.length === 0) return <IdleCard />;

  return (
    <Card className="border-l-4 border-l-violet-500">
      <CardHeader className="pb-2">
        <CardTitle className="text-base tabular-nums">
          {t('panelTitle', { count: jobs.length })}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="divide-y divide-border">
          {jobs.map((job) => {
            const meta = metaById[job.fileId];
            return (
              <ActiveJobRow
                key={job.jobId}
                job={job}
                filePath={meta?.path ?? null}
                fileDurationSeconds={meta?.durationSeconds ?? null}
              />
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// Back-compat single-job wrapper. Used by the dashboard LiveQueueCard (D2=B
// single-summary) and existing tests. Renders the idle card when null, else a
// single compact row inside a bordered card.
export function ActiveSlotCard({
  activeJob,
  filePath,
  fileDurationSeconds,
}: {
  activeJob: ActiveJob | null;
  filePath?: string | null;
  fileDurationSeconds?: number | null;
  // 36-02: fileSizeBytes prop dropped from the compact row (the old footer
  // bytes line is gone); kept off the signature to avoid dead props.
}) {
  if (!activeJob) return <IdleCard />;

  return (
    <Card className="border-l-4 border-l-violet-500">
      <CardContent>
        <ActiveJobRow
          job={activeJob}
          filePath={filePath}
          fileDurationSeconds={fileDurationSeconds}
        />
      </CardContent>
    </Card>
  );
}
