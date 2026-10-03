'use client';

// 15-02 T4: Codec-Pie — Recharts Pie + legend. The 15-01 `note` lives behind
// an Info-tooltip-icon next to the title (D6) so the chart itself stays
// uncluttered.

import { useLocale, useTranslations } from 'next-intl';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { SectionHint } from '@/components/stats/charts/section-hint';
import { formatBytes, type FormatLocale } from '@/src/lib/format';

import { StorageErrorCard } from './storage-error-card';
import { useCodecPie, type StorageShare } from './use-storage-data';

interface Props {
  share: StorageShare;
}

const PALETTE = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
];

export function StorageCodecPieChart({ share }: Props) {
  const localeCode = useLocale();
  const locale: FormatLocale = localeCode === 'de' ? 'de' : 'en';
  const t = useTranslations('storage.codecPie');
  const { data, error, isLoading, isValidating, mutate } = useCodecPie(share);

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
        endpoint="codec-pie"
        error={error}
        onRetry={() => mutate()}
        isRetrying={isValidating}
      />
    );
  }

  const codecs = data!.codecs;
  const isEmpty = codecs.length === 0;

  return (
    <Card className={isValidating && data ? 'opacity-90' : ''}>
      <CardHeader>
        <div className="flex items-center gap-1.5">
          <CardTitle>{t('title')}</CardTitle>
          <SectionHint content={data!.note} label={t('noteAria')} />
        </div>
      </CardHeader>
      <CardContent>
        {isEmpty ? (
          <p className="py-12 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={codecs}
                    dataKey="totalBytes"
                    nameKey="codec"
                    innerRadius={32}
                    outerRadius={70}
                    paddingAngle={2}
                  >
                    {codecs.map((c, i) => (
                      <Cell key={c.codec} fill={PALETTE[i % PALETTE.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value, _name, item) => {
                      const n = typeof value === 'number' ? value : Number(value);
                      const codec = (item as { payload?: { codec?: string } } | undefined)?.payload
                        ?.codec;
                      return [
                        formatBytes(Number.isFinite(n) ? n : 0, locale),
                        codec === 'unknown' ? t('unknown') : (codec ?? ''),
                      ];
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ul className="flex flex-col gap-1.5 text-sm" aria-label={t('legendAria')}>
              {codecs.map((c, i) => (
                <li key={c.codec} className="flex items-center gap-2">
                  <span
                    className="inline-block size-3 rounded-sm"
                    style={{ backgroundColor: PALETTE[i % PALETTE.length] }}
                    aria-hidden="true"
                  />
                  <span className="flex-1 font-mono">
                    {c.codec === 'unknown' ? t('unknown') : c.codec}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {t('legendValue', {
                      fileCount: c.fileCount,
                      bytes: formatBytes(c.totalBytes, locale),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
