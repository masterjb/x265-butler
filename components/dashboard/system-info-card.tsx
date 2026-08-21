'use client';

// 03-04 Plan Task 2 — System Info card per dashboard.md §7.
// Audit M4: 'use client' first line.
// Audit S6: cache_pool_path null/empty surfaces em-dash + aria-label "(not configured)".

import { useLocale, useTranslations } from 'next-intl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SectionHint } from '@/components/stats/charts/section-hint';
import { formatBytes, type FormatLocale } from '@/src/lib/format';

const EM_DASH = '—';

interface Props {
  stats: {
    system?: {
      cpuCount?: number | null;
      perEncoderLimits?: Record<string, number> | null;
      ffmpegVersion?: string | null;
      cachePoolPath?: string | null;
      dbSizeBytes?: number | null;
    } | null;
  } | null;
  encoders: { detected?: string[] } | null;
}

export function SystemInfoCard({ stats, encoders }: Props) {
  const t = useTranslations('dashboard.system');
  const locale = useLocale() as FormatLocale;
  const sys = stats?.system ?? null;

  const cachePoolDisplay =
    sys?.cachePoolPath && sys.cachePoolPath.trim() !== '' ? sys.cachePoolPath : EM_DASH;
  const cachePoolAria =
    cachePoolDisplay === EM_DASH
      ? locale === 'de'
        ? 'nicht konfiguriert'
        : 'not configured'
      : cachePoolDisplay;

  const detected = encoders?.detected ?? [];
  const detectedDisplay = detected.length > 0 ? detected.join(', ') : EM_DASH;

  const limits = sys?.perEncoderLimits;
  const limitsDisplay =
    limits && Object.keys(limits).length > 0
      ? Object.entries(limits)
          .map(([k, v]) => `${k}=${v}`)
          .join(' · ')
      : EM_DASH;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-1.5">
          <CardTitle>{t('title')}</CardTitle>
          <SectionHint content={t('hint')} />
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <dt className="text-muted-foreground">{t('cpuCount')}</dt>
          <dd className="font-mono tabular-nums">{sys?.cpuCount ?? EM_DASH}</dd>

          <dt className="text-muted-foreground">{t('ffmpegVersion')}</dt>
          <dd className="font-mono">{sys?.ffmpegVersion ?? EM_DASH}</dd>

          <dt className="text-muted-foreground">{t('detectedEncoders')}</dt>
          <dd className="font-mono text-xs">{detectedDisplay}</dd>

          <dt className="text-muted-foreground">{t('activeConcurrency')}</dt>
          <dd className="font-mono text-xs">{limitsDisplay}</dd>

          <dt className="text-muted-foreground">{t('cachePool')}</dt>
          <dd className="font-mono text-xs" aria-label={cachePoolAria}>
            {cachePoolDisplay}
          </dd>

          <dt className="text-muted-foreground">{t('dbSize')}</dt>
          <dd className="font-mono tabular-nums">
            {sys?.dbSizeBytes != null ? formatBytes(sys.dbSizeBytes, locale) : EM_DASH}
          </dd>
        </dl>
      </CardContent>
    </Card>
  );
}
