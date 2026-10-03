// 05-03 T2.G: Logs page — Server Component.
// Phase 5 Plan 05-03 — AC-6 (initial paint via JobRepo.listRecentPaginated).

import path from 'node:path';
import { fileRepo, jobRepo } from '@/src/lib/db';
import { PageContainer } from '@/components/page-layout';
import { LogsClient } from './logs-client';
import type { JobLogEntry } from '@/components/logs/jobs-list';
import type { ContainerFormat } from '@/components/logs/container-log-panel';

export const dynamic = 'force-dynamic';

const VALID_FORMATS: ContainerFormat[] = ['raw', 'json'];
const VALID_LINES = [100, 500, 1000];
const VALID_SIZES = [25, 50, 100, 200];
const DEFAULT_SIZE = 50;

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function pickStr(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === 'string' ? v : null;
}

export default async function LogsPage({ searchParams }: Props) {
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return (
      <PageContainer variant="data">
        <LogsClient
          initialEntries={[]}
          initialTab="per-job"
          initialJobId={null}
          initialFormat="raw"
          initialLines={100}
          pagination={{ page: 1, size: DEFAULT_SIZE, total: 0, pageCount: 0 }}
        />
      </PageContainer>
    );
  }

  const sp = await searchParams;
  const tabRaw = pickStr(sp.tab);
  const jobIdRaw = pickStr(sp.jobId);
  const formatRaw = pickStr(sp.format);
  const linesRaw = pickStr(sp.lines);

  const initialTab = tabRaw === 'container' ? 'container' : 'per-job';
  const initialJobId = jobIdRaw && /^[a-zA-Z0-9_-]{1,64}$/.test(jobIdRaw) ? jobIdRaw : null;
  const initialFormat: ContainerFormat = VALID_FORMATS.includes(formatRaw as ContainerFormat)
    ? (formatRaw as ContainerFormat)
    : 'raw';
  const linesParsed = linesRaw ? Number.parseInt(linesRaw, 10) : 100;
  const initialLines = VALID_LINES.includes(linesParsed) ? linesParsed : 100;

  // 32-04: Per-Job pagination — parse page/size from URL (defensive, mirrors
  // tab/jobId/format/lines idiom). size allow-listed, page floored at 1.
  const sizeRaw = pickStr(sp.size);
  const pageRaw = pickStr(sp.page);
  const sizeParsed = sizeRaw ? Number.parseInt(sizeRaw, 10) : DEFAULT_SIZE;
  const size = VALID_SIZES.includes(sizeParsed) ? sizeParsed : DEFAULT_SIZE;
  const pageParsed = pageRaw ? Number.parseInt(pageRaw, 10) : 1;
  const page = Number.isFinite(pageParsed) ? Math.max(1, pageParsed) : 1;

  // First query to learn `total`, then clamp the effective page to the valid
  // range (audit SR-1): repo clamps page>=1 but NOT page<=pageCount, so a stale
  // bookmark `?page=99` (or a page emptied by Clear-Log/Trash) would hit a far
  // OFFSET → rows=[] + garbage "Showing 4901–40 of 40" header. effPage resolves
  // an out-of-range page to the last real page; re-query with effPage (SSR is
  // the source of truth — do not rely on the client to re-correct).
  const probe = jobRepo().listRecentPaginated({ page, size, statusGroup: 'all' });
  const total = probe.total;
  const pageCount = total === 0 ? 0 : Math.ceil(total / size);
  const effPage = pageCount > 0 ? Math.min(page, pageCount) : 1;
  const recentJobs =
    effPage === page
      ? probe.rows
      : jobRepo().listRecentPaginated({ page: effPage, size, statusGroup: 'all' }).rows;

  const initialEntries: JobLogEntry[] = recentJobs.map((job) => {
    const file = fileRepo().getById(job.file_id);
    const filePath = file?.path ?? null;
    const fileBasename = filePath ? path.basename(filePath) : null;
    return {
      id: job.id,
      fileId: job.file_id,
      status: job.status,
      encoder: job.encoder,
      createdAt: job.created_at,
      finishedAt: job.finished_at,
      filePath,
      fileBasename,
      durationMs: job.duration_ms,
    };
  });

  return (
    <PageContainer variant="data">
      <LogsClient
        initialEntries={initialEntries}
        initialTab={initialTab}
        initialJobId={initialJobId}
        initialFormat={initialFormat}
        initialLines={initialLines}
        pagination={{ page: effPage, size, total, pageCount }}
      />
    </PageContainer>
  );
}
