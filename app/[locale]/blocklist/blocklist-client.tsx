'use client';

import { useCallback, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Info, ListX, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { AddPatternForm } from '@/components/blocklist/add-pattern-form';
import { RemoveEntryButton } from '@/components/blocklist/remove-entry-button';
import { Pagination } from '@/components/library/pagination';
import type { BlocklistRow } from '@/src/lib/db/schema';

// 04-02 blocklist page Client Component. Mirrors 02-04 Trash + 01-04 Library
// hybrid pattern. URL state for pagination via router.replace (no filters in v1).

// 22-03 T3: optional aggregation fields populated server-side from the 22-00
// blocklist_evaluation ring. Undefined on file-pinned rows.
export type BlocklistRowWithFile = BlocklistRow & {
  filePath: string | null;
  recentMatchCount?: number;
  derivedExtension?: string | null;
  extensionWarningHint?: boolean;
};

// DB stores reasons as 'operator' | 'auto-failure' | 'auto-skip'. i18n keys
// follow camelCase convention (S12 naming-convention test). Map at UI boundary.
function reasonKey(reason: string): string {
  if (reason === 'auto-failure') return 'autoFailure';
  if (reason === 'auto-skip') return 'autoSkip';
  return 'operator';
}

export function BlocklistClient({
  initialRows,
  initialTotal,
  initialPage,
  initialSize,
  dbErrored,
  scanExtensions = [],
}: {
  initialRows: BlocklistRowWithFile[];
  initialTotal: number;
  initialPage: number;
  initialSize: number;
  dbErrored: boolean;
  scanExtensions?: string[];
}) {
  const t = useTranslations('blocklist');
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [showAddPattern, setShowAddPattern] = useState(false);

  const handleAdded = useCallback(() => {
    setShowAddPattern(false);
    router.refresh();
  }, [router]);

  const handleRemoved = useCallback(() => {
    router.refresh();
  }, [router]);

  // 05-bonus: pagination URL state (Library-parity).
  const pageCount = initialTotal === 0 ? 0 : Math.ceil(initialTotal / initialSize);
  function pushUrl(updates: Partial<Record<'page' | 'size', string | null>>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v == null || v === '') params.delete(k);
      else params.set(k, v);
    }
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `?${qs}` : '?', { scroll: false });
    });
  }
  function onPageChange(next: number) {
    if (next < 1) return;
    pushUrl({ page: next === 1 ? null : String(next) });
  }
  function onSizeChange(next: number) {
    pushUrl({ size: next === 25 ? null : String(next), page: null });
  }

  if (dbErrored) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-2 p-8 text-center">
          <p className="text-base text-destructive">{t('error.dbError')}</p>
        </CardContent>
      </Card>
    );
  }

  if (initialTotal === 0 && !showAddPattern) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 p-12 text-center">
          <ListX className="size-12 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-xl font-semibold">{t('empty.headline')}</h2>
          <p className="max-w-md text-sm text-muted-foreground">{t('empty.body')}</p>
          <Button type="button" onClick={() => setShowAddPattern(true)}>
            <Plus className="mr-2 size-4" aria-hidden="true" />
            {t('addPattern.headline')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {showAddPattern ? (
        <AddPatternForm onAdded={handleAdded} onCancel={() => setShowAddPattern(false)} />
      ) : (
        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={() => setShowAddPattern(true)}>
            <Plus className="mr-2 size-4" aria-hidden="true" />
            {t('addPattern.headline')}
          </Button>
        </div>
      )}

      {/* Table on ≥md */}
      <Card className="hidden md:block">
        <CardContent className="p-0">
          <table className="w-full">
            <thead className="border-b bg-muted/40">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium uppercase">
                  {t('table.type')}
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium uppercase">
                  {t('table.displayValue')}
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium uppercase">
                  {t('table.recentMatches')}
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium uppercase">
                  {t('table.reason')}
                </th>
                <th className="px-4 py-2 text-right text-xs font-medium uppercase">
                  {t('table.actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {initialRows.map((row) => {
                const displayValue =
                  row.file_id !== null ? (row.filePath ?? `#${row.file_id}`) : row.path_pattern;
                return (
                  // ui-ux-pro-max D1: hover state on row clarifies which row will be acted on
                  <tr
                    key={row.id}
                    className="border-b transition-colors last:border-0 motion-safe:duration-150 hover:bg-muted/30"
                  >
                    <td className="px-4 py-2 text-sm">
                      {row.file_id !== null ? t('type.file') : t('type.pattern')}
                    </td>
                    {/* ui-ux-pro-max D3: font-mono only for patterns; file paths use regular text */}
                    <td
                      className={
                        row.file_id !== null
                          ? 'px-4 py-2 break-all text-xs'
                          : 'px-4 py-2 break-all font-mono text-xs'
                      }
                    >
                      {displayValue}
                    </td>
                    <td className="px-4 py-2 text-sm">
                      <RecentMatchesCell row={row} scanExtensions={scanExtensions} />
                    </td>
                    <td className="px-4 py-2 text-sm">{t(`reason.${reasonKey(row.reason)}`)}</td>
                    <td className="px-4 py-2 text-right">
                      <RemoveEntryButton entryId={row.id} onRemoved={handleRemoved} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* 05-bonus: pagination footer (Library-parity) — only when total > size. */}
      {initialTotal > initialSize && (
        <Pagination
          page={initialPage}
          size={initialSize}
          total={initialTotal}
          pageCount={pageCount}
          onPageChange={onPageChange}
          onSizeChange={onSizeChange}
        />
      )}

      {/* Card list on <md — ui-ux-pro-max A5: aria-label per Card identifies entry to SR users */}
      <div className="flex flex-col gap-2 md:hidden">
        {initialRows.map((row) => {
          const displayValue =
            row.file_id !== null ? (row.filePath ?? `#${row.file_id}`) : row.path_pattern;
          const typeLabel = row.file_id !== null ? t('type.file') : t('type.pattern');
          return (
            <Card key={row.id} aria-label={`${typeLabel}: ${displayValue}`}>
              <CardContent className="flex flex-col gap-2 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase text-muted-foreground">
                    {typeLabel}
                  </span>
                  <RemoveEntryButton entryId={row.id} onRemoved={handleRemoved} />
                </div>
                {/* ui-ux-pro-max D3: font-mono only for patterns */}
                {row.file_id !== null ? (
                  <span className="break-all text-xs">{displayValue}</span>
                ) : (
                  <code className="break-all font-mono text-xs">{displayValue}</code>
                )}
                <span className="text-xs text-muted-foreground">
                  {t(`reason.${reasonKey(row.reason)}`)}
                </span>
                {/* 22-03 T3: Recent-matches labeled line + warning-hint. */}
                <div className="flex items-center gap-2">
                  <span className="text-xs uppercase text-muted-foreground">
                    {t('card.recentMatchesLabel')}
                  </span>
                  <RecentMatchesCell row={row} scanExtensions={scanExtensions} />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// 22-03 T3: per-row cell — em-dash for file-pinned, count + Info-icon-tooltip
// for ZERO + extension-shape + uncovered, plain muted count otherwise.
function RecentMatchesCell({
  row,
  scanExtensions,
}: {
  row: BlocklistRowWithFile;
  scanExtensions: string[];
}) {
  const t = useTranslations('blocklist');
  if (row.file_id !== null) {
    return (
      <span aria-label={t('card.fileEntryDash')} className="text-muted-foreground">
        —
      </span>
    );
  }
  const count = row.recentMatchCount ?? 0;
  if (row.extensionWarningHint && row.derivedExtension) {
    return (
      <span className="inline-flex items-center gap-1">
        <span>{count}</span>
        <TooltipProvider delay={300}>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={t('recentMatches.ariaLabel')}
                  className="inline-flex items-center rounded focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-2 focus:ring-offset-background"
                />
              }
            >
              <Info className="size-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent side="top">
              {t('recentMatches.tooltip.neverMatched', {
                ext: row.derivedExtension,
                exts: scanExtensions.join(', '),
              })}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </span>
    );
  }
  return <span className="text-muted-foreground">{count}</span>;
}
