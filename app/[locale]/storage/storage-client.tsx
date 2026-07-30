'use client';

// 15-02 T1: Storage-Analyzer client root. Orchestrates URL ↔ state ↔ SWR
// refetches for the 5 storage endpoints. Empty-state detection runs at the
// top level so per-widget code stays focused on rendering.

import { useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { PageContainer, PageHeader } from '@/components/page-layout';
import { Skeleton } from '@/components/ui/skeleton';

import { StorageToolbar } from '@/components/storage/storage-toolbar';
import { type DepthValue } from '@/components/storage/depth-selector';
import { StorageKpiStrip } from '@/components/storage/storage-kpi-strip';
import { StorageSizeBucketsChart } from '@/components/storage/storage-size-buckets-chart';
import { StorageCodecPieChart } from '@/components/storage/storage-codec-pie-chart';
import { StorageSharesTable } from '@/components/storage/storage-shares-table';
import { StorageTopFoldersTable } from '@/components/storage/storage-top-folders-table';
import { StorageEmptyState } from '@/components/storage/storage-empty-state';
import { useSharesTable, type StorageShare } from '@/components/storage/use-storage-data';
import { useKpis } from '@/components/storage/use-storage-data';
import type { ShareActiveValue } from '@/components/library/share-filter-pill';
import type { ShareRow } from '@/src/lib/db/schema';

function parseShareParam(raw: string | null): ShareActiveValue {
  if (!raw || raw === 'all') return 'all';
  if (raw === 'orphan') return 'orphan';
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) return n;
  return 'all';
}

// Storage endpoints today only accept `all | <id>`; the library-side `orphan`
// literal is not part of the storage schema, so we treat it as `all` for
// the SWR keys and surface a warning if it ever appears.
function shareForStorage(active: ShareActiveValue): StorageShare {
  return typeof active === 'number' ? active : 'all';
}

interface StorageClientProps {
  initialShares: ShareRow[];
  initialOrphanCount: number;
}

export function StorageClient({ initialShares, initialOrphanCount }: StorageClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const locale = useLocale();
  const t = useTranslations('storage');

  const activeShare = parseShareParam(searchParams.get('share'));
  const storageShare = shareForStorage(activeShare);
  const [depth, setDepth] = useState<DepthValue>(2);
  const [computedAt, setComputedAt] = useState<string | null>(null);

  // SWR shares-table powers empty-state detection (no-files-for-share branch
  // needs the per-share totals); the toolbar pill uses the SSR-hydrated
  // ShareRow[] so the canonical shape is available without extra fetches.
  const sharesTable = useSharesTable();
  const kpis = useKpis(storageShare);

  const sharesList = initialShares;
  const orphanCount = initialOrphanCount;

  // AC-11: reflect-supplied — share=999 still returns 200 + canonical-empty
  // shape; surface a persistent inline-banner instead of a transient toast.
  const isUnknownShareSelected =
    typeof activeShare === 'number' &&
    sharesTable.data != null &&
    !sharesList.some((s) => s.id === activeShare);

  const onShareChange = useCallback(
    (next: ShareActiveValue) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === 'all') params.delete('share');
      else params.set('share', String(next));
      const qs = params.toString();
      router.push(qs ? `?${qs}` : '?', { scroll: false });
    },
    [router, searchParams],
  );

  const onClearUnknownShare = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('share');
    const qs = params.toString();
    router.push(qs ? `?${qs}` : '?', { scroll: false });
  }, [router, searchParams]);

  const initialBundleLoading =
    (sharesTable.isLoading && !sharesTable.data) || (kpis.isLoading && !kpis.data);

  // Empty-state branching only runs once the shares + kpis fetches resolve;
  // until then we render the skeletons (AC-1 aria-busy contract).
  const hasShares = sharesList.length > 0 || orphanCount > 0;
  const totalSize = kpis.data?.totalSizeBytes ?? 0;
  const showNoShares = !initialBundleLoading && !hasShares;
  const showNoFiles =
    !initialBundleLoading && hasShares && totalSize === 0 && activeShare === 'all';
  const showNoFilesForShare =
    !initialBundleLoading && hasShares && totalSize === 0 && typeof activeShare === 'number';

  const showWidgets = !showNoShares && !showNoFiles;

  return (
    <PageContainer variant="data">
      <PageHeader title={t('title')} subhead={t('subtitle')} />

      <section aria-busy={initialBundleLoading} className="flex flex-col gap-4">
        <StorageToolbar
          shares={sharesList}
          orphanCount={orphanCount}
          share={activeShare}
          onShareChange={onShareChange}
          depth={depth}
          onDepthChange={setDepth}
          computedAt={computedAt}
        />

        {isUnknownShareSelected && typeof activeShare === 'number' && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-md border border-amber-500/60 bg-amber-500/10 px-4 py-3 text-sm"
          >
            <AlertTriangle
              className="size-4 text-amber-700 dark:text-amber-300"
              aria-hidden="true"
            />
            <span className="flex-1">{t('unknownShare.warning', { id: activeShare })}</span>
            <Button type="button" size="sm" variant="outline" onClick={onClearUnknownShare}>
              <ArrowLeft className="size-3" aria-hidden="true" />
              {t('unknownShare.back')}
            </Button>
          </div>
        )}

        {initialBundleLoading ? (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
              <Skeleton className="h-64" />
              <Skeleton className="h-64" />
              <Skeleton className="h-96" />
              <Skeleton className="h-96" />
            </div>
          </>
        ) : showNoShares ? (
          <StorageEmptyState variant="noShares" locale={locale} />
        ) : showNoFiles ? (
          <StorageEmptyState variant="noFiles" locale={locale} />
        ) : (
          <>
            <StorageKpiStrip share={storageShare} onComputedAt={setComputedAt} />

            {showNoFilesForShare && <StorageEmptyState variant="noFilesForShare" locale={locale} />}

            {showWidgets && (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
                <StorageSizeBucketsChart share={storageShare} />
                <StorageCodecPieChart share={storageShare} />
                <StorageSharesTable />
                <StorageTopFoldersTable share={storageShare} depth={depth} />
              </div>
            )}
          </>
        )}
      </section>
    </PageContainer>
  );
}
