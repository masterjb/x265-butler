import fs from 'node:fs';
import { fileRepo, settingRepo, shareRepo } from '@/src/lib/db';
import { libraryQuerySchema, toListOptions } from '@/src/lib/api/library-query';
import { logger } from '@/src/lib/logger';
import { LibraryClient } from './library-client';

export const dynamic = 'force-dynamic';

// 22-01 IMP-1: slow_request threshold (ms). Module-const; operator-config deferred.
const SLOW_REQUEST_MS = 1000;

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LibraryPage({ searchParams }: Props) {
  const sp = await searchParams;

  // Validate via zod, fall back to defaults silently when malformed
  // (Server Component must always render; query errors are not user-visible).
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (v == null) continue;
    const value = Array.isArray(v) ? v[0] : v;
    if (value && value !== '') raw[k] = value;
  }
  const parsed = libraryQuerySchema.safeParse(raw);
  const query = parsed.success ? parsed.data : libraryQuerySchema.parse({});

  const repo = fileRepo();
  const opts = toListOptions(query);

  // 22-01 IMP-1 (audit-SR4): timed repo-reads + slow_request emit on threshold breach.
  // Try/catch wrap preserves existing error-bubble contract (page renders error boundary).
  const t0 = performance.now();
  let listPaginated_ms = 0;
  let countByStatus_ms = 0;
  let countOrphaned_ms = 0;
  let shareListAll_ms = 0;
  let settingGet_ms = 0;

  let rows: ReturnType<ReturnType<typeof fileRepo>['listPaginated']>['rows'];
  let total: number;
  let counts: ReturnType<ReturnType<typeof fileRepo>['countByStatus']>;
  let shares: ReturnType<ReturnType<typeof shareRepo>['listAll']>;
  let orphanCount: number;
  let globalContainer: string;

  try {
    const t_lp = performance.now();
    const paged = repo.listPaginated(opts);
    rows = paged.rows;
    total = paged.total;
    listPaginated_ms = performance.now() - t_lp;

    const t_cs = performance.now();
    counts = repo.countByStatus();
    countByStatus_ms = performance.now() - t_cs;

    const t_co = performance.now();
    orphanCount = repo.countOrphaned();
    countOrphaned_ms = performance.now() - t_co;

    const t_sl = performance.now();
    shares = shareRepo().listAll();
    shareListAll_ms = performance.now() - t_sl;

    const t_sg = performance.now();
    // 10-02 E-D1: pass global output_container so FileDetailPanel can show
    // "(global: X)" hint in ContainerOverrideField.
    globalContainer = settingRepo().get('output_container') ?? 'mkv';
    settingGet_ms = performance.now() - t_sg;
  } catch (err) {
    const totalMs = performance.now() - t0;
    logger.warn(
      {
        action: 'slow_request_failed',
        route: '/library',
        durationMs: totalMs,
        errorName: err instanceof Error ? err.name : 'unknown',
      },
      'slow_request_failed',
    );
    throw err;
  }

  const totalMs = performance.now() - t0;
  if (totalMs > SLOW_REQUEST_MS) {
    logger.info(
      {
        action: 'slow_request',
        route: '/library',
        durationMs: totalMs,
        breakdown: {
          listPaginated: listPaginated_ms,
          countByStatus: countByStatus_ms,
          countOrphaned: countOrphaned_ms,
          shareListAll: shareListAll_ms,
          settingGet: settingGet_ms,
        },
      },
      'slow_request',
    );
  }

  const pageCount = total === 0 ? 0 : Math.ceil(total / opts.size);
  // 14-03: share-axis filter source data — shareRepo.listAll() is id-ASC per
  // 14-02 contract; orphanCount feeds the ShareFilterPill orphan-bucket.

  // 14-04 (Plan 14-04 Task 7): scan_root existence check sourced from
  // shareRepo().listAll()[0] instead of legacy settings.scan_root. When
  // shares table is empty the existence check is skipped (operator has not
  // configured any path yet → empty-state already informative).
  const firstSharePath = shares[0]?.path ?? '';
  let scanRootExists = false;
  if (firstSharePath) {
    try {
      scanRootExists = fs.statSync(firstSharePath).isDirectory();
    } catch {
      scanRootExists = false;
    }
  }

  return (
    <LibraryClient
      rows={rows}
      pagination={{
        page: query.page,
        size: query.size,
        total,
        pageCount,
      }}
      counts={counts}
      query={query}
      scanRootExists={scanRootExists}
      scanRoot={firstSharePath}
      globalContainer={globalContainer}
      shares={shares}
      orphanCount={orphanCount}
    />
  );
}
