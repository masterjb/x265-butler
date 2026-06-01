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

  const { rows: recentJobs } = jobRepo().listRecentPaginated({ page: 1, size: 50 });

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
      />
    </PageContainer>
  );
}
