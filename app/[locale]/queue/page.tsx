import { jobRepo, fileRepo } from '@/src/lib/db';
// 32-02: dependency-free pause-state import (NOT the encode barrel — SR-3).
import { isQueuePaused } from '@/src/lib/encode/pause-state';
import { QueueClient } from './queue-client';
import type { ActiveJob } from '@/src/lib/api/engine-events-client';
import type { ActiveJobMeta } from '@/components/queue/active-slot-card';

export const dynamic = 'force-dynamic';

const DEFAULT_PAGE_SIZE = 25;
const ALLOWED_PAGE_SIZES = new Set([25, 50, 100, 200]);
// 05-12 B-layout: completed-pane filter chips. Default 'completed' = all 4 terminal statuses.
const ALLOWED_STATUS_GROUPS = ['completed', 'done', 'failed', 'cancelled'] as const;
type StatusGroup = (typeof ALLOWED_STATUS_GROUPS)[number];

function parseStatusGroup(raw: string | undefined): StatusGroup {
  if (!raw) return 'completed';
  return (ALLOWED_STATUS_GROUPS as readonly string[]).includes(raw)
    ? (raw as StatusGroup)
    : 'completed';
}

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function parseSize(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || !ALLOWED_PAGE_SIZES.has(n)) return DEFAULT_PAGE_SIZE;
  return n;
}

function parsePage(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

export default async function QueuePage({ searchParams }: Props) {
  // audit-added S3: guard against next-build static analysis phase invoking
  // this Server Component against routes that short-circuit via ensureServerInit.
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return (
      <QueueClient
        initialPending={[]}
        initialCompleted={[]}
        initialPathByFileId={{}}
        initialPaused={false}
        initialActiveJobs={[]}
        initialActiveFileMetaById={{}}
        pagination={{ page: 1, size: DEFAULT_PAGE_SIZE, total: 0, pageCount: 0 }}
        statusGroup="completed"
      />
    );
  }

  const sp = await searchParams;
  const sizeRaw = Array.isArray(sp.size) ? sp.size[0] : sp.size;
  const pageRaw = Array.isArray(sp.page) ? sp.page[0] : sp.page;
  const recentRaw = Array.isArray(sp.recent) ? sp.recent[0] : sp.recent;
  const size = parseSize(sizeRaw);
  const page = parsePage(pageRaw);
  const statusGroup = parseStatusGroup(recentRaw);

  // 05-12 B-layout: LEFT pane consumes the full pending queue (peekQueued cap = 1000
  // matches PATCH /api/queue/reorder body cap). RIGHT pane consumes the paginated
  // completed slice filtered by the chip-driven statusGroup.
  const initialPending = jobRepo().peekQueued(1000);
  const activeJobs = jobRepo().listActive();
  const { rows: initialCompleted, total } = jobRepo().listRecentPaginated({
    page,
    size,
    statusGroup,
  });
  const pageCount = total === 0 ? 0 : Math.ceil(total / size);

  // 05-10 B2: bulk-resolve scan-rooted paths for both pane slices so row
  // components can show filename + parent dir without N client round-trips.
  const initialPathByFileId: Record<number, string> = {};
  const seenFileIds = new Set<number>();
  for (const job of [...initialPending, ...initialCompleted]) {
    if (seenFileIds.has(job.file_id)) continue;
    seenFileIds.add(job.file_id);
    const file = fileRepo().getById(job.file_id);
    if (file) initialPathByFileId[job.file_id] = file.path;
  }
  // 32-02: pause re-activated — SSR seeds initialPaused with the real in-memory
  // flag (isQueuePaused, shared getter) so first paint matches the live state
  // before the SSE connects. The NEXT_PHASE build-guard branch above keeps its
  // literal false (no runtime state during static build).
  const paused = isQueuePaused();

  // 36-02: seed ALL ENCODING jobs (one bar each) + a per-fileId meta map. The
  // seed MUST be filtered to status==='encoding' — listActive() is
  // status IN ('queued','encoding'), but the live SSE store only ever holds
  // encoding jobs (job.started fires at dispatch). Seeding queued rows would
  // render phantom indeterminate bars for jobs that ALSO appear in the LEFT
  // pending pane (double-render). queued rows live only in the pending pane.
  const encodingJobs = activeJobs.filter((job) => job.status === 'encoding');
  const initialActiveJobs: ActiveJob[] = encodingJobs.map((job) => ({
    jobId: job.id,
    fileId: job.file_id,
    outTimeMs: null,
    fps: null,
    totalSize: null,
    speed: null,
    encoder: job.encoder,
  }));
  const initialActiveFileMetaById: Record<number, ActiveJobMeta> = {};
  for (const job of encodingJobs) {
    if (job.file_id in initialActiveFileMetaById) continue;
    const file = fileRepo().getById(job.file_id);
    initialActiveFileMetaById[job.file_id] = file
      ? { path: file.path, durationSeconds: file.duration_seconds, sizeBytes: file.size_bytes }
      : { path: null, durationSeconds: null, sizeBytes: null };
  }

  return (
    <QueueClient
      initialPending={initialPending}
      initialCompleted={initialCompleted}
      initialPathByFileId={initialPathByFileId}
      initialPaused={paused}
      initialActiveJobs={initialActiveJobs}
      initialActiveFileMetaById={initialActiveFileMetaById}
      pagination={{ page, size, total, pageCount }}
      statusGroup={statusGroup}
    />
  );
}
