'use client';

// 15-02 T4: Top-folders table — server returns top-10 by sizeBytes for the
// requested depth. Row-click navigates to Library with both share and
// pathPrefix populated (AC-9). The 50k pre-aggregate cap (SR1) surfaces as
// a persistent banner above the table when `truncated === true`.

import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SectionHint } from '@/components/stats/charts/section-hint';
import { formatBytes, type FormatLocale } from '@/src/lib/format';
import { cn } from '@/lib/utils';

import { StorageErrorCard } from './storage-error-card';
import { useTopFolders, type StorageShare } from './use-storage-data';

interface Props {
  share: StorageShare;
  depth: number;
}

// Chrome URL-length safety net: practical browsers cap navigations around
// ~2k characters. We disable deep-link on rows whose encoded path would push
// the URL past this limit; D9 spec requested a tooltip + warn-log surface.
const URL_LENGTH_LIMIT = 2000;

export function StorageTopFoldersTable({ share, depth }: Props) {
  const localeCode = useLocale();
  const locale: FormatLocale = localeCode === 'de' ? 'de' : 'en';
  const t = useTranslations('storage.topFolders');
  const router = useRouter();
  const { data, error, isLoading, isValidating, mutate } = useTopFolders(share, depth);

  if (isLoading && !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-96" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <StorageErrorCard
        endpoint="top-folders"
        error={error}
        onRetry={() => mutate()}
        isRetrying={isValidating}
      />
    );
  }

  const rows = data!.rows;

  function navigateTo(row: { shareId: number | null; path: string }) {
    if (row.shareId == null) return;
    const href = `/${localeCode}/library?share=${row.shareId}&pathPrefix=${encodeURIComponent(row.path)}`;
    if (href.length > URL_LENGTH_LIMIT) {
      console.warn('storage_deeplink_path_too_long', { pathLength: row.path.length });
      return;
    }
    router.push(href);
  }

  return (
    <Card className={isValidating && data ? 'opacity-90' : ''}>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {data!.truncated && (
          <div
            role="status"
            className="mb-3 flex items-center gap-2 rounded-md border border-amber-500/60 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">{t('truncatedBadge')}</span>
            <SectionHint content={t('truncatedTooltip')} />
          </div>
        )}
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">{t('cols.rank')}</TableHead>
                <TableHead>{t('cols.path')}</TableHead>
                <TableHead className="text-right">{t('cols.size')}</TableHead>
                <TableHead className="text-right">{t('cols.fileCount')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => {
                const href =
                  row.shareId != null
                    ? `/${localeCode}/library?share=${row.shareId}&pathPrefix=${encodeURIComponent(row.path)}`
                    : null;
                const tooLong = href != null && href.length > URL_LENGTH_LIMIT;
                const clickable = href != null && !tooLong;
                return (
                  <TableRow
                    key={`${row.shareId ?? 'orphan'}::${row.path}::${i}`}
                    role={clickable ? 'button' : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    aria-label={clickable ? t('rowClickAria', { path: row.path }) : undefined}
                    title={tooLong ? t('pathTooLong') : undefined}
                    onClick={() => clickable && navigateTo(row)}
                    onKeyDown={(e) => {
                      if (!clickable) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        navigateTo(row);
                      }
                    }}
                    className={cn(
                      clickable
                        ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                        : tooLong
                          ? 'cursor-not-allowed opacity-60'
                          : 'text-muted-foreground italic',
                    )}
                  >
                    <TableCell className="font-mono tabular-nums text-xs">{i + 1}</TableCell>
                    <TableCell className="font-mono text-xs">{row.path}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatBytes(row.sizeBytes, locale)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {row.fileCount}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
