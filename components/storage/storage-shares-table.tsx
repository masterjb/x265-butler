'use client';

// 15-02 T4: Shares-comparison table — always cross-share per AC-6. Default
// sort is totalSizeBytes DESC; columns are click-toggle sortable. The
// largest-folder cell carries the deep-link into Library
// (?share=<id>&pathPrefix=<path>).

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp } from 'lucide-react';
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
import { formatBytes, type FormatLocale } from '@/src/lib/format';
import { cn } from '@/lib/utils';
import type { ShareTableRow } from '@/src/lib/db/repos/storage';

import { StorageErrorCard } from './storage-error-card';
import { useSharesTable } from './use-storage-data';

type SortKey = 'share' | 'totalSizeBytes' | 'hevcPercent' | 'savingsBytes';
type SortDir = 'asc' | 'desc';

export function StorageSharesTable() {
  const localeCode = useLocale();
  const locale: FormatLocale = localeCode === 'de' ? 'de' : 'en';
  const t = useTranslations('storage.sharesTable');
  const { data, error, isLoading, isValidating, mutate } = useSharesTable();

  const [sortKey, setSortKey] = useState<SortKey>('totalSizeBytes');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const rows = useMemo<ShareTableRow[]>(() => {
    if (!data) return [];
    const rowsCopy = [...data.rows];
    rowsCopy.sort((a, b) => {
      const sign = sortDir === 'asc' ? 1 : -1;
      switch (sortKey) {
        case 'share': {
          const av = a.sharePath ?? '';
          const bv = b.sharePath ?? '';
          return av.localeCompare(bv) * sign;
        }
        case 'totalSizeBytes':
          return (a.totalSizeBytes - b.totalSizeBytes) * sign;
        case 'hevcPercent':
          return (a.hevcPercent - b.hevcPercent) * sign;
        case 'savingsBytes':
          return (a.savingsBytes - b.savingsBytes) * sign;
        default:
          return 0;
      }
    });
    return rowsCopy;
  }, [data, sortKey, sortDir]);

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
        endpoint="shares-table"
        error={error}
        onRetry={() => mutate()}
        isRetrying={isValidating}
      />
    );
  }

  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
        </CardContent>
      </Card>
    );
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'share' ? 'asc' : 'desc');
    }
  }

  function sortIcon(key: SortKey) {
    if (sortKey !== key) return null;
    const Icon = sortDir === 'asc' ? ArrowUp : ArrowDown;
    return <Icon className="inline-block size-3 ml-1" aria-hidden="true" />;
  }

  function ariaSort(key: SortKey): React.AriaAttributes['aria-sort'] {
    if (sortKey !== key) return 'none';
    return sortDir === 'asc' ? 'ascending' : 'descending';
  }

  return (
    <Card className={isValidating && data ? 'opacity-90' : ''}>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead aria-sort={ariaSort('share')}>
                <button
                  type="button"
                  className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => toggleSort('share')}
                >
                  {t('cols.share')}
                  {sortIcon('share')}
                </button>
              </TableHead>
              <TableHead aria-sort={ariaSort('totalSizeBytes')} className="text-right">
                <button
                  type="button"
                  className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => toggleSort('totalSizeBytes')}
                >
                  {t('cols.totalSize')}
                  {sortIcon('totalSizeBytes')}
                </button>
              </TableHead>
              <TableHead aria-sort={ariaSort('hevcPercent')} className="text-right">
                <button
                  type="button"
                  className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => toggleSort('hevcPercent')}
                >
                  {t('cols.hevcPercent')}
                  {sortIcon('hevcPercent')}
                </button>
              </TableHead>
              <TableHead aria-sort={ariaSort('savingsBytes')} className="text-right">
                <button
                  type="button"
                  className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => toggleSort('savingsBytes')}
                >
                  {t('cols.savings')}
                  {sortIcon('savingsBytes')}
                </button>
              </TableHead>
              <TableHead>{t('cols.largestFolder')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const isOrphan = row.shareId == null;
              const largestHref =
                row.largestFolder && row.shareId != null
                  ? `/${localeCode}/library?share=${row.shareId}&pathPrefix=${encodeURIComponent(row.largestFolder.path)}`
                  : null;
              return (
                <TableRow
                  key={row.shareId ?? 'orphan'}
                  className={cn(isOrphan && 'italic text-muted-foreground')}
                >
                  <TableCell title={isOrphan ? t('orphanTooltip') : (row.sharePath ?? '')}>
                    {isOrphan ? t('orphan') : (row.sharePath ?? '—')}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatBytes(row.totalSizeBytes, locale)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {row.hevcPercent.toFixed(1)}%
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {row.savingsBytes > 0 ? formatBytes(row.savingsBytes, locale) : '—'}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {row.largestFolder ? (
                      largestHref ? (
                        <Link
                          href={largestHref}
                          className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                          aria-label={t('largestFolderAria', { path: row.largestFolder.path })}
                          title={row.largestFolder.path}
                        >
                          {row.largestFolder.path}
                        </Link>
                      ) : (
                        <span title={row.largestFolder.path}>{row.largestFolder.path}</span>
                      )
                    ) : (
                      '—'
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
