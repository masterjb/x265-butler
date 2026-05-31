'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown, WifiOff } from 'lucide-react';
import { ActiveSlotCard } from '@/components/queue/active-slot-card';
import { CancelAllButton } from '@/components/queue/cancel-all-button';
import { PendingListSortable } from '@/components/queue/pending-list-sortable';
import { CompletedListVirtualized } from '@/components/queue/completed-list-virtualized';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { FileDetailPanel } from '@/components/library/file-detail-panel';
import { PageContainer, PageHeader } from '@/components/page-layout';
import {
  useActiveJob,
  useRecentJobs,
  useEngineEventsDisconnected,
  useQueueCounts,
} from '@/src/lib/api/engine-events-client';
import { useRefreshOnDispatch } from '@/src/lib/api/use-refresh-on-dispatch';
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
  initialActiveJob: ActiveJob | null;
  initialActiveFilePath: string | null;
  initialActiveFileDurationSeconds: number | null;
  initialActiveFileSizeBytes: number | null;
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
  initialActiveJob,
  initialActiveFilePath,
  initialActiveFileDurationSeconds,
  initialActiveFileSizeBytes,
  pagination,
  statusGroup,
}: Props) {
  const t = useTranslations('queue');
  const tCompleted = useTranslations('queue.completed');
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const liveActiveJob = useActiveJob();
  const liveRecentJobs = useRecentJobs();
  const disconnected = useEngineEventsDisconnected();
  const counts = useQueueCounts();

  // 05-13 UAT-fix: refetch SSR-rendered initialPending whenever the active
  // job's identity changes (orchestrator dispatch + completion). Without this,
  // the LEFT-pane queued list stays at first-paint state because the SSE store
  // does not maintain a recentJobs[] snapshot — pre-existing 02-04 design gap.
  // See src/lib/api/use-refresh-on-dispatch.ts for full rationale.
  useRefreshOnDispatch(liveActiveJob, router);

  const activeJob = liveActiveJob ?? initialActiveJob;

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

  // Active file details: refreshed when active job's fileId changes.
  const [activeFilePath, setActiveFilePath] = useState<string | null>(initialActiveFilePath);
  const [activeFileDuration, setActiveFileDuration] = useState<number | null>(
    initialActiveFileDurationSeconds,
  );
  const [activeFileSizeBytes, setActiveFileSizeBytes] = useState<number | null>(
    initialActiveFileSizeBytes,
  );

  useEffect(() => {
    if (!liveActiveJob) {
      setActiveFilePath(null);
      setActiveFileDuration(null);
      setActiveFileSizeBytes(null);
      return;
    }
    void (async () => {
      try {
        const res = await fetch(`/api/library/${liveActiveJob.fileId}`);
        if (res.ok) {
          const data = (await res.json()) as { file: FileRow };
          setActiveFilePath(data.file.path);
          setActiveFileDuration(data.file.duration_seconds);
          setActiveFileSizeBytes(data.file.size_bytes);
        }
      } catch {
        // best-effort
      }
    })();
  }, [liveActiveJob?.fileId]);

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

      <div className="flex items-center justify-between gap-3">
        <span className="text-sm tabular-nums text-muted-foreground">
          {t('controls.activeCount', {
            active: counts.activeJobs,
            pending: counts.pendingJobs,
          })}
        </span>
        <CancelAllButton />
      </div>

      <ActiveSlotCard
        activeJob={activeJob}
        filePath={activeFilePath}
        fileDurationSeconds={activeFileDuration}
        fileSizeBytes={activeFileSizeBytes}
      />

      {/* B-layout split — full grid at md+, mobile collapses Completed into Collapsible. */}
      <div className="hidden gap-6 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
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
