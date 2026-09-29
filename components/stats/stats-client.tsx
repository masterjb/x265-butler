'use client';

import path from 'path';
import { useMemo } from 'react';
import { Inbox } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { CodecDistributionCard } from '@/components/dashboard/codec-distribution-card';
import { PageHeader } from '@/components/page-layout';
import { BulletKpiCard } from '@/components/stats/charts/bullet-kpi-card';
import { CaveatKpiCard } from '@/components/stats/charts/caveat-kpi-card';
import { CssEncoderBar } from '@/components/stats/charts/css-encoder-bar';
import { ExpiringSoonBadge } from '@/components/stats/charts/expiring-soon-badge';
import { HorizontalBarList } from '@/components/stats/charts/horizontal-bar-list';
import { InlineSvgTimeline } from '@/components/stats/charts/inline-svg-timeline';
import { SectionHint } from '@/components/stats/charts/section-hint';
import { SimpleKpiCard } from '@/components/stats/charts/simple-kpi-card';
import { StackedBar } from '@/components/stats/charts/stacked-bar';
import { formatBytes, formatDuration, type FormatLocale } from '@/src/lib/format';
import type {
  TopSaverRow,
  EncoderPerfRow,
  StatsTrendPointFull,
  CodecDistribution,
} from '@/src/lib/db';

// B4: file.status → library.status i18n key (skip variants only)
const SKIP_STATUS_KEY: Record<string, string> = {
  'skipped-codec': 'skippedCodec',
  'skipped-bitrate': 'skippedBitrate',
  'skipped-suffix': 'skippedSuffix',
  'skipped-tag': 'skippedTag',
  'skipped-sidecar': 'skippedSidecar',
  'skipped-blocklist': 'skippedBlocklist',
};

// file.status → library.status i18n key (all statuses)
const FILE_STATUS_KEY: Record<string, string> = {
  pending: 'pending',
  queued: 'queued',
  encoding: 'encoding',
  'done-smaller': 'doneSmaller',
  'done-larger': 'doneLarger',
  'done-not-worth': 'doneNotWorth',
  'done-already-evaluated': 'doneAlreadyEvaluated',
  'skipped-codec': 'skippedCodec',
  'skipped-bitrate': 'skippedBitrate',
  'skipped-suffix': 'skippedSuffix',
  'skipped-tag': 'skippedTag',
  'skipped-sidecar': 'skippedSidecar',
  'skipped-blocklist': 'skippedBlocklist',
  failed: 'failed',
  blocklisted: 'blocklisted',
  interrupted: 'interrupted',
  vanished: 'vanished',
};

const FAIL_RATE_THRESHOLDS = { healthy: 0.05, attention: 0.1 };

interface StatsClientProps {
  initialData: {
    topSavers: TopSaverRow[];
    encoderPerf: EncoderPerfRow[];
    trend: StatsTrendPointFull[];
    codecDistribution: CodecDistribution | null;
    resolutionDist: { bucket: string; count: number }[];
    fileStatusDist: { status: string; count: number }[];
    bitrateDist: { bucket: string; count: number }[];
    encodeSpeedRatio: { avgSpeedRatio: number; sampleSize: number };
    failedJobRate: { failRate: number; sampleSize: number };
    avgQueueWait: { avgWaitSec: number; sampleSize: number };
    skipTypeBreakdown: { status: string; count: number }[];
    allTimeJobSummary: {
      done: number;
      failed: number;
      interrupted: number;
      cancelled: number;
      total: number;
    };
    currentTrashSize: { trashBytes: number; trashCount: number };
    expiringTrash: { count: number };
    netDiskFreed: number;
  } | null;
}

export function StatsClient({ initialData }: StatsClientProps) {
  const t = useTranslations('stats');
  const tc = useTranslations('stats.charts');
  const tStatus = useTranslations('library.status');
  const locale = useLocale() as FormatLocale;

  const topSavers = initialData?.topSavers ?? [];
  const encoderPerf = initialData?.encoderPerf ?? [];
  const trend = initialData?.trend ?? [];
  const resolutionDist = initialData?.resolutionDist ?? [];
  const fileStatusDist = initialData?.fileStatusDist ?? [];
  const bitrateDist = initialData?.bitrateDist ?? [];
  const encodeSpeedRatio = initialData?.encodeSpeedRatio ?? { avgSpeedRatio: 0, sampleSize: 0 };
  const failedJobRate = initialData?.failedJobRate ?? { failRate: 0, sampleSize: 0 };
  const avgQueueWait = initialData?.avgQueueWait ?? { avgWaitSec: 0, sampleSize: 0 };
  const skipTypeBreakdown = initialData?.skipTypeBreakdown ?? [];
  const allTimeJobSummary = initialData?.allTimeJobSummary ?? {
    done: 0,
    failed: 0,
    interrupted: 0,
    cancelled: 0,
    total: 0,
  };
  const currentTrashSize = initialData?.currentTrashSize ?? { trashBytes: 0, trashCount: 0 };
  const expiringTrash = initialData?.expiringTrash ?? { count: 0 };
  const netDiskFreed = initialData?.netDiskFreed ?? 0;

  const skipData = useMemo(
    () =>
      skipTypeBreakdown.map((row) => {
        const key = SKIP_STATUS_KEY[row.status];
        return {
          label: key ? tStatus(key as Parameters<typeof tStatus>[0]) : row.status,
          count: row.count,
        };
      }),
    [skipTypeBreakdown, tStatus],
  );

  const resDist = useMemo(
    () =>
      resolutionDist.map((r, i) => ({
        bucket: r.bucket,
        count: r.count,
        color: `var(--chart-${(i % 5) + 1})`,
      })),
    [resolutionDist],
  );

  const resTotal = resolutionDist.reduce((s, r) => s + r.count, 0);

  const fileStatusData = useMemo(
    () =>
      fileStatusDist.map((r, i) => {
        const key = FILE_STATUS_KEY[r.status];
        return {
          label: key ? tStatus(key as Parameters<typeof tStatus>[0]) : r.status,
          count: r.count,
          color: `var(--chart-${(i % 5) + 1})`,
        };
      }),
    [fileStatusDist, tStatus],
  );

  const bitrateData = useMemo(
    () =>
      bitrateDist.map((r, i) => ({
        label: r.bucket,
        count: r.count,
        color: `var(--chart-${(i % 5) + 1})`,
      })),
    [bitrateDist],
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('title')} />

      {/* 1: Pipeline Health */}
      <section aria-labelledby="stats-pipeline-heading">
        <h2 id="stats-pipeline-heading" className="mb-3 text-base font-semibold">
          {tc('pipelineHealth.title')}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <BulletKpiCard
            value={failedJobRate.failRate}
            sampleSize={failedJobRate.sampleSize}
            thresholds={FAIL_RATE_THRESHOLDS}
            titleKey="failedJobRate.title"
            hint={tc('failedJobRate.hint')}
          />
          <SimpleKpiCard
            value={
              encodeSpeedRatio.avgSpeedRatio > 0
                ? `${encodeSpeedRatio.avgSpeedRatio.toFixed(2)}×`
                : '—'
            }
            label={tc('encodeSpeedRatio.title')}
            subtext={tc('encodeSpeedRatio.subtitle')}
            sampleSize={encodeSpeedRatio.sampleSize}
            hint={tc('encodeSpeedRatio.hint')}
          />
          <SimpleKpiCard
            value={String(allTimeJobSummary.total)}
            label={tc('allTimeJobSummary.title')}
            subtext={`${tc('allTimeJobSummary.done')}: ${allTimeJobSummary.done} · ${tc('allTimeJobSummary.failed')}: ${allTimeJobSummary.failed}`}
            hint={tc('allTimeJobSummary.hint')}
          />
        </div>
      </section>

      {/* 2: Library Overview */}
      <section aria-labelledby="stats-library-heading">
        <h2 id="stats-library-heading" className="mb-3 text-base font-semibold">
          {tc('libraryOverview.title')}
        </h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-1.5">
                <CardTitle className="text-sm">{tc('resolutionDistribution.title')}</CardTitle>
                <SectionHint content={tc('resolutionDistribution.hint')} />
              </div>
            </CardHeader>
            <CardContent>
              <StackedBar
                data={resDist}
                total={resTotal}
                title={tc('resolutionDistribution.title')}
                emptyTitle={tc('resolutionDistribution.empty.title')}
                emptyBody={tc('resolutionDistribution.empty.body')}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-1.5">
                <CardTitle className="text-sm">{tc('bitrateDistribution.title')}</CardTitle>
                <SectionHint content={tc('bitrateDistribution.hint')} />
              </div>
            </CardHeader>
            <CardContent>
              <HorizontalBarList
                data={bitrateData}
                title={tc('bitrateDistribution.title')}
                emptyTitle={tc('resolutionDistribution.empty.title')}
                emptyBody={tc('resolutionDistribution.empty.body')}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-1.5">
                <CardTitle className="text-sm">{tc('fileStatusDistribution.title')}</CardTitle>
                <SectionHint content={tc('fileStatusDistribution.hint')} />
              </div>
            </CardHeader>
            <CardContent>
              <HorizontalBarList
                data={fileStatusData}
                title={tc('fileStatusDistribution.title')}
                emptyTitle={tc('fileStatusDistribution.empty.title')}
                emptyBody={tc('fileStatusDistribution.empty.body')}
              />
            </CardContent>
          </Card>
        </div>
      </section>

      {/* 2b: Codec Distribution (reuse existing card) */}
      <CodecDistributionCard
        stats={
          initialData ? { codecDistribution: initialData.codecDistribution ?? undefined } : null
        }
      />

      {/* 3: Skip Analysis */}
      <section aria-labelledby="stats-skip-heading">
        <h2 id="stats-skip-heading" className="mb-3 text-base font-semibold">
          {tc('skipAnalysis.title')}
        </h2>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-1.5">
              <CardTitle className="text-sm">{tc('skipTypeBreakdown.title')}</CardTitle>
              <SectionHint content={tc('skipTypeBreakdown.hint')} />
            </div>
          </CardHeader>
          <CardContent>
            <HorizontalBarList
              data={skipData}
              title={tc('skipTypeBreakdown.title')}
              emptyTitle={tc('skipTypeBreakdown.empty.title')}
              emptyBody={tc('skipTypeBreakdown.empty.body')}
              sortable
            />
          </CardContent>
        </Card>
      </section>

      {/* 4: Disk Recovery */}
      <section aria-labelledby="stats-disk-heading">
        <h2 id="stats-disk-heading" className="mb-3 text-base font-semibold">
          {tc('diskRecovery.title')}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SimpleKpiCard
            value={formatBytes(currentTrashSize.trashBytes, locale)}
            label={tc('currentTrashSize.title')}
            subtext={tc('currentTrashSize.subtitle')}
            hint={tc('currentTrashSize.hint')}
          />
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-1.5">
                <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {tc('expiringSoon.title')}
                </CardTitle>
                <SectionHint content={tc('expiringSoon.hint')} />
              </div>
            </CardHeader>
            <CardContent>
              <ExpiringSoonBadge count={expiringTrash.count} withinDays={7} />
            </CardContent>
          </Card>
          <CaveatKpiCard
            value={netDiskFreed}
            titleKey="netDiskFreed.title"
            tooltipKey="netDiskFreed.caveat.tooltip"
            formatValue={(v) => formatBytes(v, locale)}
          />
          <SimpleKpiCard
            value={avgQueueWait.avgWaitSec > 0 ? formatDuration(avgQueueWait.avgWaitSec) : '—'}
            label={tc('avgQueueWait.title')}
            subtext={tc('avgQueueWait.subtitle')}
            sampleSize={avgQueueWait.sampleSize}
            hint={tc('avgQueueWait.hint')}
          />
        </div>
      </section>

      {/* 5: Top Savers */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-1.5">
            <CardTitle>{t('topSavers.title')}</CardTitle>
            <SectionHint content={tc('topSavers.hint')} />
          </div>
          <p className="text-sm text-muted-foreground">{t('topSavers.subtitle')}</p>
        </CardHeader>
        <CardContent>
          {topSavers.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title={t('topSavers.empty.title')}
              body={t('topSavers.empty.body')}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="pb-2 pr-4 font-medium">
                      {t('topSavers.table.file')}
                    </th>
                    <th scope="col" className="pb-2 pr-4 font-medium">
                      {t('topSavers.table.saved')}
                    </th>
                    <th scope="col" className="pb-2 pr-4 font-medium">
                      {t('topSavers.table.savedPercent')}
                    </th>
                    <th scope="col" className="pb-2 pr-4 font-medium">
                      {t('topSavers.table.encoder')}
                    </th>
                    <th scope="col" className="pb-2 font-medium">
                      {t('topSavers.table.date')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {topSavers.map((row) => {
                    const href =
                      row.fileId != null ? `/${locale}/library?file=${row.fileId}` : null;
                    const rowContent = (
                      <>
                        <td className="py-2 pr-4 font-mono text-xs">
                          {row.filePath
                            ? path.posix.basename(row.filePath) || t('topSavers.table.fileMissing')
                            : t('topSavers.table.fileMissing')}
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs">
                          {formatBytes(row.savedBytes, locale)}
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs">{row.savedPercent}%</td>
                        <td className="py-2 pr-4">
                          {row.encoder ? (
                            <Badge variant="outline" className="font-mono text-xs">
                              {row.encoder}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-2 text-xs text-muted-foreground">
                          {row.finishedAt
                            ? new Date(row.finishedAt * 1000).toLocaleDateString(
                                locale === 'de' ? 'de-DE' : 'en-US',
                                { day: '2-digit', month: '2-digit', year: 'numeric' },
                              )
                            : '—'}
                        </td>
                      </>
                    );
                    return href ? (
                      <tr
                        key={row.jobId}
                        className="border-b last:border-0 cursor-pointer hover:bg-muted/50 transition-colors"
                      >
                        <td className="py-2 pr-4 font-mono text-xs">
                          <Link
                            href={href}
                            className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                            aria-label={
                              row.filePath
                                ? path.posix.basename(row.filePath)
                                : t('topSavers.table.fileMissing')
                            }
                          >
                            {row.filePath
                              ? path.posix.basename(row.filePath) ||
                                t('topSavers.table.fileMissing')
                              : t('topSavers.table.fileMissing')}
                          </Link>
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs">
                          {formatBytes(row.savedBytes, locale)}
                        </td>
                        <td className="py-2 pr-4 font-mono text-xs">{row.savedPercent}%</td>
                        <td className="py-2 pr-4">
                          {row.encoder ? (
                            <Badge variant="outline" className="font-mono text-xs">
                              {row.encoder}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-2 text-xs text-muted-foreground">
                          {row.finishedAt
                            ? new Date(row.finishedAt * 1000).toLocaleDateString(
                                locale === 'de' ? 'de-DE' : 'en-US',
                                { day: '2-digit', month: '2-digit', year: 'numeric' },
                              )
                            : '—'}
                        </td>
                      </tr>
                    ) : (
                      <tr key={row.jobId} className="border-b last:border-0">
                        {rowContent}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 6: Savings Timeline */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-1.5">
            <CardTitle>{t('timeline.title')}</CardTitle>
            <SectionHint content={tc('savingsTimeline.hint')} label={tc('sectionHint.aria')} />
          </div>
        </CardHeader>
        <CardContent>
          <InlineSvgTimeline data={trend} locale={locale} />
        </CardContent>
      </Card>

      {/* 7: Encoder Performance */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-1.5">
            <CardTitle>{t('encoderPerf.title')}</CardTitle>
            <SectionHint content={tc('encoderPerf.hint')} label={tc('sectionHint.aria')} />
          </div>
          <p className="text-sm text-muted-foreground">{t('encoderPerf.subtitle')}</p>
        </CardHeader>
        <CardContent>
          <CssEncoderBar rows={encoderPerf} locale={locale} />
        </CardContent>
      </Card>
    </div>
  );
}
