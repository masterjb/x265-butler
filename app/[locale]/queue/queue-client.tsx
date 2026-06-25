'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown, Pause, WifiOff } from 'lucide-react';
import { ActiveJobsPanel, type ActiveJobMeta } from '@/components/queue/active-slot-card';
import { CancelAllButton } from '@/components/queue/cancel-all-button';
import { PauseToggleButton } from '@/components/queue/pause-toggle-button';
import { PendingListSortable } from '@/components/queue/pending-list-sortable';
import { CompletedListVirtualized } from '@/components/queue/completed-list-virtualized';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { FileDetailPanel } from '@/components/library/file-detail-panel';
import { PageContainer, PageHeader } from '@/components/page-layout';
import {
  useActiveJobs,
  useRecentJobs,
  useEngineEventsDisconnected,
  useQueueCounts,
  usePausedState,
} from '@/src/lib/api/engine-events-client';
import {
  useRefreshOnActiveSetChange,
  useRefreshOnReconnect,
  useRefreshOnVisibilityRegain,
} from '@/src/lib/api/use-refresh-on-dispatch';
import type { JobRow, FileRow } from '@/src/lib/db/schema';
import type { ActiveJob } from '@/src/lib/api/engine-events-client';

type StatusGroup = 'completed' | 'done' | 'failed' | 'cancelled';

type Props = {
  initialPending: JobRow[];
  initialCompleted: JobRow[];
  // 05-10 B2: scan-rooted paths for the SSR-rendered slices. SSE-pushed
  // rows that arrive after first paint may not be in this map; components
  // fall back to `#${file_id}` when path lookup misses.
  initialPathByFileId: Record<number, string>;
  // 05-09: initialPaused retained for back-compat; permanently false.
  initialPaused?: boolean;
  // 36-02: SSR-seeded ENCODING jobs (one bar each) + per-fileId file meta.
  initialActiveJobs: ActiveJob[];
  initialActiveFileMetaById: Record<number, ActiveJobMeta>;
  pagination: {
    page: number;
    size: number;
    total: number;
    pageCount: number;
  };
  statusGroup: StatusGroup;
};

export function QueueClient({
  initialPending,
  initialCompleted,
  initialPathByFileId,
  initialActiveJobs,
  initialActiveFileMetaById,
  pagination,
  statusGroup,
}: Props) {
  const t = useTranslations('queue');
  const tCompleted = useTranslations('queue.completed');
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const liveActiveJobs = useActiveJobs();
  const liveRecentJobs = useRecentJobs();
  const disconnected = useEngineEventsDisconnected();
  // 32-02: live pause state (SSE queue.updated.paused) drives the amber banner.
  const paused = usePausedState();
  const counts = useQueueCounts();

  // 05-13 UAT-fix → 36-02 (AC-10): refetch SSR-rendered initialPending whenever
  // the active-job SET changes (dispatch OR completion OR a coincident
  // sibling-swap that keeps the lowest jobId fixed at parallelism>=2). The old
  // useRefreshOnDispatch keyed off the lowest-jobId identity and missed the
  // sibling-swap case; useRefreshOnActiveSetChange keys off the sorted-jobId set
  // and subsumes it. Without this, the LEFT-pane queued list stays at first-paint
  // state because the SSE store does not maintain a recentJobs[] snapshot —
  // pre-existing 02-04 design gap. See use-refresh-on-dispatch.ts for rationale.
  useRefreshOnActiveSetChange(liveActiveJobs, router);
  // 32-03 fix: an encoder switch (PUT /api/settings) never changes active-job
  // identity, so the dispatch trigger above does not fire. Two extra triggers
  // re-fetch the SSR pending list — SSE reconnect (engine re-init blip) and tab
  // visibility-regain (operator switched encoder in another tab and returned).
  useRefreshOnReconnect(disconnected, router);
  useRefreshOnVisibilityRegain(router);

  // 36-02 counts-gated source (AC-5): prefer the live store; before any SSE
  // event, fall back to the encoding-only SSR seed — but ONLY when counts say
  // something is active. NOTE: counts.activeJobs is queued+encoding (orchestrator
  // emit), NOT an encoding signal — but initialActiveJobs is already encoding-only
  // (SSR-filtered), so when counts>0 due to queued-only rows the seed is [] →
  // panel shows idle (no phantom). The idle determinant is seed-emptiness.
  const activeJobs: ActiveJob[] =
    liveActiveJobs.length > 0 ? liveActiveJobs : counts.activeJobs > 0 ? initialActiveJobs : [];

  // 05-12 B-layout: live updates apply only on page=1 + default statusGroup.
  const useLiveData = pagination.page === 1 && statusGroup === 'completed';
  // LEFT pane livePending — derived from SSE store. Falls back to initialPending
  // when SSE has not yet delivered anything (avoids empty-list flash).
  const livePending: JobRow[] =
    useLiveData && liveRecentJobs.length > 0
      ? liveRecentJobs.filter((j) => j.status === 'queued')
      : initialPending;
  // RIGHT pane: paginated server slice. Live overlay only on page=1 default chip.
  const completedJobs: JobRow[] =
    useLiveData && liveRecentJobs.length > 0
      ? liveRecentJobs
          .filter((j) => j.status !== 'queued' && j.status !== 'encoding')
          .slice(0, pagination.size)
      : initialCompleted;

  // URL-state pagination handlers (Library-style).
  function pushUrl(updates: Partial<Record<'page' | 'size' | 'recent', string | null>>) {
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

  function onStatusGroupChange(next: StatusGroup) {
    pushUrl({ recent: next === 'completed' ? null : next, page: null });
  }

  // 36-02: per-job file meta keyed by fileId (audit-S6: no filePath on the SSE
  // wire). Seeded from the encoding-only SSR map; lazily fetched for any active
  // fileId not yet known. Pruning stale keys is unnecessary (bounded by
  // encode_parallelism).
  const [fileMetaById, setFileMetaById] =
    useState<Record<number, ActiveJobMeta>>(initialActiveFileMetaById);

  // Stable dep: the sorted set of active fileIds. The effect fetches only the
  // fileIds not already present in the meta map.
  const activeFileIdsKey = activeJobs
    .map((j) => j.fileId)
    .sort((a, b) => a - b)
    .join(',');

  useEffect(() => {
    const missing = activeJobs.map((j) => j.fileId).filter((fileId) => !(fileId in fileMetaById));
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      const fetched: Array<[number, ActiveJobMeta]> = [];
      for (const fileId of missing) {
        try {
          const res = await fetch(`/api/library/${fileId}`);
          if (res.ok) {
            const data = (await res.json()) as { file: FileRow };
            fetched.push([
              fileId,
              {
                path: data.file.path,
                durationSeconds: data.file.duration_seconds,
                sizeBytes: data.file.size_bytes,
              },
            ]);
          }
        } catch {
          // best-effort
        }
      }
      if (!cancelled && fetched.length > 0) {
        setFileMetaById((prev) => {
          const next = { ...prev };
          for (const [fileId, meta] of fetched) next[fileId] = meta;
          return next;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // Dep = activeFileIdsKey (the set of active fileIds). fileMetaById is read
    // inside but intentionally NOT a dep — a meta update must not re-trigger the
    // fetch loop; the missing-filter already excludes already-known ids.
  }, [activeFileIdsKey]);

  // FileDetailPanel state — row click opens detail for that file_id.
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailFile, setDetailFile] = useState<FileRow | null>(null);
  const detailTriggerRef = useRef<HTMLElement | null>(null);

  async function handleRowClick(job: JobRow, target: HTMLElement) {
    try {
      const res = await fetch(`/api/library/${job.file_id}`);
      if (res.ok) {
        const data = (await res.json()) as { file: FileRow };
        setDetailFile(data.file);
        detailTriggerRef.current = target;
        setDetailOpen(true);
      }
    } catch {
      // best-effort
    }
  }

  // Collapsible state (mobile only). Default collapsed.
  const [completedOpen, setCompletedOpen] = useState(false);

  const completedPane = (
    <CompletedListVirtualized
      initialCompleted={completedJobs}
      pathByFileId={initialPathByFileId}
      onRowClick={(job, target) => void handleRowClick(job, target)}
      pagination={pagination}
      statusGroup={statusGroup}
      onStatusGroupChange={onStatusGroupChange}
      onPageChange={onPageChange}
      onSizeChange={onSizeChange}
    />
  );

  return (
    <PageContainer variant="data">
      <PageHeader title={t('title')} />

      {disconnected && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          <WifiOff className="size-4 shrink-0" aria-hidden="true" />
          <span>{t('disconnected.banner')}</span>
        </div>
      )}

      {/* 32-02: persistent amber paused banner (mirrors the disconnected-banner idiom). */}
      {paused && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          <Pause className="size-4 shrink-0" aria-hidden="true" />
          <span>{t('paused.banner')}</span>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <span className="text-sm tabular-nums text-muted-foreground">
          {t('controls.activeCount', {
            active: counts.activeJobs,
            pending: counts.pendingJobs,
          })}
        </span>
        <div className="flex items-center gap-2">
          <PauseToggleButton />
          <CancelAllButton />
        </div>
      </div>

      <ActiveJobsPanel jobs={activeJobs} metaById={fileMetaById} />

      {/* B-layout split — full grid at md+, mobile collapses Completed into Collapsible. */}
      <div className="hidden gap-6 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <PendingListSortable
          initialPending={initialPending}
          livePending={livePending}
          pathByFileId={initialPathByFileId}
        />
        {completedPane}
      </div>

      <div className="flex flex-col gap-4 md:hidden">
        <PendingListSortable
          initialPending={initialPending}
          livePending={livePending}
          pathByFileId={initialPathByFileId}
        />
        <Collapsible open={completedOpen} onOpenChange={setCompletedOpen}>
          <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span>
              {tCompleted('title')} ({pagination.total})
            </span>
            <ChevronDown
              className={
                'size-4 transition-transform ' + (completedOpen ? 'rotate-180' : 'rotate-0')
              }
              aria-hidden="true"
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">{completedPane}</CollapsibleContent>
        </Collapsible>
      </div>

      <FileDetailPanel
        file={detailFile}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        triggerRef={detailTriggerRef}
      />
    </PageContainer>
  );
}
