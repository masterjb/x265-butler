'use client';

// 05-03 T2.H: Logs page client — Tabs strip + URL-state-driven panels.
// Phase 5 Plan 05-03 — AC-6 + AC-7.

import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useCallback, useMemo } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/page-layout';
import { JobsList, type JobLogEntry } from '@/components/logs/jobs-list';
import { LogViewer } from '@/components/logs/log-viewer';
import { ContainerLogPanel, type ContainerFormat } from '@/components/logs/container-log-panel';
import { Pagination } from '@/components/library/pagination';
import { cn } from '@/lib/utils';

type Tab = 'per-job' | 'container';

const VALID_FORMATS: ContainerFormat[] = ['raw', 'json'];
const VALID_LINES = [100, 500, 1000];
const VALID_SIZES = [25, 50, 100, 200];
const DEFAULT_SIZE = 50;

function parseTab(raw: string | null): Tab {
  return raw === 'container' ? 'container' : 'per-job';
}
function parseFormat(raw: string | null): ContainerFormat {
  return raw && VALID_FORMATS.includes(raw as ContainerFormat) ? (raw as ContainerFormat) : 'raw';
}
function parseLines(raw: string | null): number {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && VALID_LINES.includes(n) ? n : 100;
}

export function LogsClient({
  initialEntries,
  initialTab,
  initialJobId,
  initialFormat,
  initialLines,
  pagination,
}: {
  initialEntries: JobLogEntry[];
  initialTab: Tab;
  initialJobId: string | null;
  initialFormat: ContainerFormat;
  initialLines: number;
  pagination: { page: number; size: number; total: number; pageCount: number };
}) {
  const t = useTranslations('logs');
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  // URL state — read fresh from useSearchParams to react to navigation.
  // When the URL param is absent, fall back to the server-provided initial.
  const tabRaw = sp.get('tab');
  const formatRaw = sp.get('format');
  const linesRaw = sp.get('lines');
  const tab: Tab = tabRaw === null ? initialTab : parseTab(tabRaw);
  const jobId = sp.get('jobId') ?? initialJobId;
  const format: ContainerFormat = formatRaw === null ? initialFormat : parseFormat(formatRaw);
  const lines = linesRaw === null ? initialLines : parseLines(linesRaw);

  // 32-04: page/size from URL, falling back to server-provided pagination when
  // the param is absent (same null-fallback idiom as tab/format/lines).
  const sizeRaw = sp.get('size');
  const pageRaw = sp.get('page');
  const size = (() => {
    if (sizeRaw === null) return pagination.size;
    const n = Number.parseInt(sizeRaw, 10);
    return VALID_SIZES.includes(n) ? n : DEFAULT_SIZE;
  })();
  const page = (() => {
    if (pageRaw === null) return pagination.page;
    const n = Number.parseInt(pageRaw, 10);
    return Number.isFinite(n) ? Math.max(1, n) : 1;
  })();

  // AC-4: derive entries from props (NOT frozen useState) — Next re-runs the
  // force-dynamic Server Component on URL change and supplies a fresh
  // initialEntries prop per page; a frozen useState would never update.
  const entries = initialEntries;

  const updateUrl = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, sp],
  );

  const onTabChange = useCallback(
    (next: string) => {
      updateUrl({ tab: next === 'container' ? 'container' : null });
    },
    [updateUrl],
  );

  const onSelectJob = useCallback(
    (next: string) => {
      updateUrl({ jobId: next });
    },
    [updateUrl],
  );

  const onPageChange = useCallback(
    (next: number) => {
      updateUrl({ page: next === 1 ? null : String(next) });
    },
    [updateUrl],
  );

  const onSizeChange = useCallback(
    (next: number) => {
      // AC-3: size change resets to page 1 (drop page param).
      updateUrl({ size: next === DEFAULT_SIZE ? null : String(next), page: null });
    },
    [updateUrl],
  );

  const selectedEntry = useMemo(() => {
    if (!jobId) return null;
    return entries.find((e) => String(e.id) === jobId) ?? null;
  }, [entries, jobId]);

  return (
    <div className="flex h-[calc(100vh-12rem)] flex-col gap-3">
      <PageHeader title={t('title')} />

      <Tabs value={tab} onValueChange={onTabChange} className="flex flex-1 flex-col gap-3">
        <TabsList>
          <TabsTrigger value="per-job">{t('tab.perJob')}</TabsTrigger>
          <TabsTrigger value="container">{t('tab.container')}</TabsTrigger>
        </TabsList>

        <TabsContent value="per-job" className="flex flex-1 flex-col gap-3">
          <div className={cn('grid flex-1 gap-3 lg:grid-cols-[280px_minmax(0,1fr)]')}>
            <aside className="overflow-auto rounded-md border border-border bg-card">
              <JobsList entries={entries} selectedJobId={jobId} onSelect={onSelectJob} />
            </aside>
            <div className="overflow-hidden rounded-md border border-border bg-card">
              <LogViewer entry={selectedEntry} className="h-full" />
            </div>
          </div>
          <Pagination
            page={page}
            size={size}
            total={pagination.total}
            pageCount={pagination.pageCount}
            onPageChange={onPageChange}
            onSizeChange={onSizeChange}
          />
        </TabsContent>

        <TabsContent value="container" className="flex flex-1">
          <ContainerLogPanel
            format={format}
            lines={lines}
            onFormatChange={(next) => updateUrl({ format: next === 'raw' ? null : next })}
            onLinesChange={(next) => updateUrl({ lines: next === 100 ? null : String(next) })}
            className="flex-1"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
