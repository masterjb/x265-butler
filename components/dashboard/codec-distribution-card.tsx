'use client';

import { Receipt } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SectionHint } from '@/components/stats/charts/section-hint';
import { formatBytes, type FormatLocale } from '@/src/lib/format';
import type { CodecBucketKey, ContainerBucketKey, CodecDistribution } from '@/src/lib/db';

interface Props {
  stats: { codecDistribution?: CodecDistribution } | null;
}

const CODEC_COLORS: Record<CodecBucketKey, string> = {
  hevc: 'var(--chart-1)',
  h264: 'var(--chart-2)',
  av1: 'var(--chart-3)',
  vp9: 'var(--chart-4)',
  other: 'var(--chart-5)',
  unknown: 'var(--muted-foreground)',
};

const CONTAINER_COLORS: Record<ContainerBucketKey, string> = {
  mkv: 'var(--chart-1)',
  mp4: 'var(--chart-2)',
  other: 'var(--muted-foreground)',
};

export function CodecDistributionCard({ stats }: Props) {
  const t = useTranslations('dashboard.codecDistribution');
  const locale = useLocale() as FormatLocale;
  const dist = stats?.codecDistribution;

  if (!dist || dist.totalFiles === 0) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-1.5">
            <CardTitle>{t('title')}</CardTitle>
            <SectionHint content={t('hint')} />
          </div>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
          <Receipt className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
          <h3 className="text-lg font-semibold">{t('empty.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('empty.body')}</p>
        </CardContent>
      </Card>
    );
  }

  const hevcBucket = dist.codec.find((b) => b.bucket === 'hevc');
  const hevcPercent = hevcBucket ? Math.round((hevcBucket.count / dist.totalFiles) * 1000) / 10 : 0;
  const mkvBucket = dist.container.find((b) => b.bucket === 'mkv');
  const mkvPercent = mkvBucket ? Math.round((mkvBucket.count / dist.totalFiles) * 1000) / 10 : 0;

  const ariaParts = dist.codec.map((b) => {
    const pct = Math.round((b.count / dist.totalFiles) * 1000) / 10;
    return t('legendRow', { label: t(`bucket.${b.bucket}`), count: b.count, percent: pct });
  });
  const chartAria = t('chartAria', {
    breakdown: ariaParts.join(', '),
    totalFiles: dist.totalFiles,
    totalBytes: formatBytes(dist.totalBytes, locale),
  });

  const containerAria = dist.container
    .map((b) => {
      const pct = Math.round((b.count / dist.totalFiles) * 1000) / 10;
      return t('legendRow', { label: t(`container.${b.bucket}`), count: b.count, percent: pct });
    })
    .join(', ');

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-1.5">
          <CardTitle>{t('title')}</CardTitle>
          <SectionHint content={t('hint')} />
        </div>
        <p className="text-sm text-muted-foreground">
          {t('subtitle', { count: dist.totalFiles, bytes: formatBytes(dist.totalBytes, locale) })}
        </p>
      </CardHeader>
      <CardContent>
        {/* 4 KPI chips */}
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border bg-muted/50 px-3 py-2 text-center">
            <p className="font-mono text-2xl font-semibold tabular-nums">
              {dist.totalFiles.toLocaleString()}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('kpi.files')}</p>
          </div>
          <div className="rounded-lg border bg-muted/50 px-3 py-2 text-center">
            <p className="font-mono text-2xl font-semibold tabular-nums">
              {formatBytes(dist.totalBytes, locale)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('kpi.total')}</p>
          </div>
          <div className="rounded-lg border-l-4 border-l-[var(--chart-1)] bg-muted/50 px-3 py-2 text-center">
            <p className="font-mono text-2xl font-semibold tabular-nums">{hevcPercent}%</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('kpi.hevcShare')}</p>
          </div>
          <div className="rounded-lg border-l-4 border-l-[var(--chart-1)] bg-muted/50 px-3 py-2 text-center">
            <p className="font-mono text-2xl font-semibold tabular-nums">{mkvPercent}%</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('kpi.mkvShare')}</p>
          </div>
        </div>

        {/* HEVC callout (conditional — existing ICU key retained) */}
        {hevcBucket && hevcBucket.count > 0 ? (
          <div className="mb-5 rounded-md border-l-4 border-l-[var(--chart-1)] bg-muted/50 px-3 py-2 text-sm">
            {t('hevcCallout', { count: hevcBucket.count, percent: hevcPercent })}
          </div>
        ) : null}

        {/* Codec stacked bar */}
        <div className="mb-5">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('section.codecs')}
          </p>
          {/* audit-added SR2: focus-visible ring for keyboard users */}
          <div
            role="img"
            tabIndex={0}
            aria-label={chartAria}
            className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <div className="flex h-6 overflow-hidden rounded">
              {dist.codec.map((b) => {
                const pct = (b.count / dist.totalFiles) * 100;
                return (
                  <div
                    key={b.bucket}
                    style={{
                      width: `${pct}%`,
                      minWidth: pct > 0 ? '2px' : undefined,
                      backgroundColor: CODEC_COLORS[b.bucket],
                    }}
                    aria-hidden="true"
                  />
                );
              })}
            </div>
          </div>
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {dist.codec.map((b) => {
              const pct = Math.round((b.count / dist.totalFiles) * 1000) / 10;
              return (
                <li key={b.bucket} className="flex items-center gap-2">
                  <span
                    className="inline-block h-3 w-3 flex-shrink-0 rounded-sm"
                    style={{ backgroundColor: CODEC_COLORS[b.bucket] }}
                    aria-hidden="true"
                  />
                  <span className="font-medium">{t(`bucket.${b.bucket}`)}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {b.count} ({pct}%)
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Container stacked bar */}
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('section.containers')}
          </p>
          {/* audit-added SR2: focus-visible ring for keyboard users */}
          <div
            role="img"
            tabIndex={0}
            aria-label={containerAria}
            className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <div className="flex h-6 overflow-hidden rounded">
              {dist.container.map((b) => {
                const pct = (b.count / dist.totalFiles) * 100;
                return (
                  <div
                    key={b.bucket}
                    style={{
                      width: `${pct}%`,
                      minWidth: pct > 0 ? '2px' : undefined,
                      backgroundColor: CONTAINER_COLORS[b.bucket],
                    }}
                    aria-hidden="true"
                  />
                );
              })}
            </div>
          </div>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {dist.container.map((b) => {
              const pct = Math.round((b.count / dist.totalFiles) * 1000) / 10;
              return (
                <li key={b.bucket} className="flex items-center gap-2">
                  <span
                    className="inline-block h-3 w-3 flex-shrink-0 rounded-sm"
                    style={{ backgroundColor: CONTAINER_COLORS[b.bucket] }}
                    aria-hidden="true"
                  />
                  <span className="font-medium">{t(`container.${b.bucket}`)}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {b.count} ({pct}%)
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
