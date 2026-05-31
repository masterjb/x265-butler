'use client';

// 15-02 T4: Size-Buckets-Chart — horizontal bar per bucket (D1 sign-off from
// /ui-ux-pro-max). Each bar represents the weighted byte-% of the bucket; we
// keep all 4 buckets even when DB is empty (SR4 canonical empty-state).

import { useLocale, useTranslations } from 'next-intl';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatBytes, type FormatLocale } from '@/src/lib/format';

import { StorageErrorCard } from './storage-error-card';
import { useBuckets, type StorageShare } from './use-storage-data';

interface Props {
  share: StorageShare;
}

type BucketLabel = '<100MB' | '100MB-1GB' | '1-10GB' | '10GB+';

const BUCKET_I18N_KEY: Record<BucketLabel, string> = {
  '<100MB': 'lt100MB',
  '100MB-1GB': '100MBto1GB',
  '1-10GB': '1to10GB',
  '10GB+': 'gt10GB',
};

export function StorageSizeBucketsChart({ share }: Props) {
  const localeCode = useLocale();
  const locale: FormatLocale = localeCode === 'de' ? 'de' : 'en';
  const t = useTranslations('storage.buckets');
  const { data, error, isLoading, isValidating, mutate } = useBuckets(share);

  if (isLoading && !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-64" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <StorageErrorCard
        endpoint="buckets"
        error={error}
        onRetry={() => mutate()}
        isRetrying={isValidating}
      />
    );
  }

  const buckets = data!.buckets;
  const totalBytes = buckets.reduce((sum, b) => sum + b.totalBytes, 0);

  return (
    <Card className={isValidating && data ? 'opacity-90' : ''}>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-3" aria-label={t('listAria')}>
          {buckets.map((b) => {
            const pct = totalBytes > 0 ? (b.totalBytes / totalBytes) * 100 : 0;
            return (
              <li key={b.label} className="grid grid-cols-[8rem_1fr_auto] items-center gap-3">
                <span className="font-mono text-xs text-muted-foreground">
                  {t(`bucket.${BUCKET_I18N_KEY[b.label as BucketLabel]}`)}
                </span>
                <div
                  className="relative h-5 overflow-hidden rounded bg-muted"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(pct)}
                  aria-label={t('barAria', {
                    bucket: t(`bucket.${BUCKET_I18N_KEY[b.label as BucketLabel]}`),
                    pct: pct.toFixed(1),
                  })}
                  title={t('tooltip', {
                    bucket: t(`bucket.${BUCKET_I18N_KEY[b.label as BucketLabel]}`),
                    fileCount: b.fileCount,
                    bytes: formatBytes(b.totalBytes, locale),
                  })}
                >
                  <div
                    className="h-full bg-[var(--chart-1)] transition-all"
                    style={{
                      width: `${Math.max(pct, totalBytes > 0 && b.totalBytes > 0 ? 1 : 0)}%`,
                    }}
                  />
                  <span className="absolute inset-0 flex items-center px-2 text-[11px] font-medium tabular-nums">
                    {pct.toFixed(1)}%
                  </span>
                </div>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {t('rowSummary', {
                    fileCount: b.fileCount,
                    bytes: formatBytes(b.totalBytes, locale),
                  })}
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
