'use client';

// 15-02 T4: KPI-strip — 4 cards. Cards refetch via the shared SWR hook
// keyed on `share`; the "Most Optimized Share" card always renders the
// cross-share winner per AC-3 (badge stays visible even when the operator
// picks a share-filter), and the Legacy-Codec-% card uses icon + tooltip in
// addition to color so the threshold is readable under deuteranopia.

import { useMemo } from 'react';
import Link from 'next/link';
import { AlertCircle, AlertOctagon, CheckCircle2 } from 'lucide-react';
import { useTranslations, useLocale } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleKpiCard } from '@/components/stats/charts/simple-kpi-card';
import { formatBytes, type FormatLocale } from '@/src/lib/format';
import { cn } from '@/lib/utils';

import { StorageErrorCard } from './storage-error-card';
import { useKpis, useSharesTable, type StorageShare } from './use-storage-data';

interface Props {
  share: StorageShare;
  onComputedAt?: (iso: string) => void;
}

type LegacyZone = 'healthy' | 'attention' | 'critical';

function legacyZone(pct: number): LegacyZone {
  if (pct >= 50) return 'critical';
  if (pct >= 20) return 'attention';
  return 'healthy';
}

const ZONE_ICONS: Record<LegacyZone, typeof AlertOctagon> = {
  healthy: CheckCircle2,
  attention: AlertCircle,
  critical: AlertOctagon,
};

const ZONE_BAR: Record<LegacyZone, string> = {
  healthy: 'bg-emerald-500',
  attention: 'bg-amber-500',
  critical: 'bg-destructive',
};

const ZONE_TEXT: Record<LegacyZone, string> = {
  healthy: 'text-emerald-700 dark:text-emerald-400',
  attention: 'text-amber-700 dark:text-amber-400',
  critical: 'text-destructive',
};

export function StorageKpiStrip({ share, onComputedAt }: Props) {
  const localeCode = useLocale();
  const locale: FormatLocale = localeCode === 'de' ? 'de' : 'en';
  const t = useTranslations('storage.kpi');

  const kpis = useKpis(share);
  const shares = useSharesTable();

  // Cross-widget data-sharing: AC-3 says mostOptimizedShare label resolves
  // against the shares-table fetch; if that fetch hasn't completed yet we
  // fall back to `Share #<id>` so the card stays meaningful instead of empty.
  const sharesByIdLookup = useMemo(() => {
    const map = new Map<number, string>();
    shares.data?.rows.forEach((row) => {
      if (row.shareId != null) {
        map.set(row.shareId, row.sharePath ?? `#${row.shareId}`);
      }
    });
    return map;
  }, [shares.data]);

  // Bubble computedAt to the parent (toolbar consumes for as-of-label).
  if (kpis.data?.computedAt && onComputedAt) {
    onComputedAt(kpis.data.computedAt);
  }

  const showLoading = kpis.isLoading && !kpis.data;

  if (showLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }

  if (kpis.error) {
    return (
      <StorageErrorCard
        endpoint="kpis"
        error={kpis.error}
        onRetry={() => kpis.mutate()}
        isRetrying={kpis.isValidating}
      />
    );
  }

  const data = kpis.data!;
  const totalSize = data.totalSizeBytes;
  const largest = data.largestFolder;
  const optimized = data.mostOptimizedShare;
  const legacyPct = data.legacyCodecPercent;
  const zone = legacyZone(legacyPct);
  const ZoneIcon = ZONE_ICONS[zone];

  // Largest-folder deep-link target — only emitted when both share + path are
  // safe to URL-encode (orphan rows do not have a share so the deep-link is
  // muted into a read-only string).
  const largestHref =
    largest && largest.shareId != null
      ? `/${localeCode}/library?share=${largest.shareId}&pathPrefix=${encodeURIComponent(largest.path)}`
      : null;

  const optimizedName = optimized
    ? (sharesByIdLookup.get(optimized.shareId) ?? `#${optimized.shareId}`)
    : null;

  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4',
        kpis.isValidating && kpis.data ? 'opacity-90' : '',
      )}
    >
      <SimpleKpiCard
        label={t('totalSize.label')}
        value={totalSize > 0 ? formatBytes(totalSize, locale) : t('totalSize.empty')}
        hint={t('totalSize.tooltip', { bytes: totalSize })}
      />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('largestFolder.label')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {largest ? (
            largestHref ? (
              <Link
                href={largestHref}
                className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                aria-label={t('largestFolder.rowAria', { path: largest.path })}
              >
                <p className="truncate font-mono text-sm" title={largest.path}>
                  {largest.path}
                </p>
                <p className="mt-1 text-base font-semibold tabular-nums">
                  {formatBytes(largest.sizeBytes, locale)}
                </p>
              </Link>
            ) : (
              <>
                <p className="truncate font-mono text-sm" title={largest.path}>
                  {largest.path}
                </p>
                <p className="mt-1 text-base font-semibold tabular-nums">
                  {formatBytes(largest.sizeBytes, locale)}
                </p>
              </>
            )
          ) : (
            <p className="text-sm text-muted-foreground">{t('largestFolder.empty')}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2 flex-row items-start justify-between gap-2">
          <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('mostOptimizedShare.label')}
          </CardTitle>
          {/* Cross-share badge is ALWAYS visible per AC-3 — even if a share
              filter is active in the toolbar. */}
          <Badge variant="secondary" className="text-[10px] whitespace-nowrap">
            {t('mostOptimizedShare.crossShareNote')}
          </Badge>
        </CardHeader>
        <CardContent>
          {optimized && optimizedName ? (
            <>
              <p className="truncate font-mono text-sm" title={optimizedName}>
                {optimizedName}
              </p>
              <p className="mt-1 text-base font-semibold tabular-nums">
                {optimized.hevcPercent.toFixed(1)}%
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t('mostOptimizedShare.empty')}</p>
          )}
        </CardContent>
      </Card>

      <Card
        aria-label={t('legacyCodecPercent.aria', {
          pct: legacyPct.toFixed(1),
          zone: t(`legacyCodecPercent.threshold.${zone}`),
        })}
      >
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('legacyCodecPercent.label')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline gap-2">
            <p className={cn('text-2xl font-semibold tabular-nums font-mono', ZONE_TEXT[zone])}>
              {legacyPct.toFixed(1)}%
            </p>
            <div className={cn('flex items-center gap-1 text-xs font-medium', ZONE_TEXT[zone])}>
              <ZoneIcon className="size-4" aria-hidden="true" />
              <span>{t(`legacyCodecPercent.threshold.${zone}`)}</span>
            </div>
          </div>
          <div
            className="mt-3 h-2 w-full rounded-full bg-muted"
            role="presentation"
            aria-hidden="true"
          >
            <div
              className={cn('h-full rounded-full transition-all', ZONE_BAR[zone])}
              style={{ width: `${Math.min(100, Math.max(0, legacyPct))}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t(`legacyCodecPercent.tooltip.${zone}`)}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
