'use client';

import { useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Checkbox } from '@/components/ui/checkbox';
import { StatusChip, statusToI18nKey } from './status-chip';
import { EncodeNowAction } from './encode-now-action';
import { AddToBlocklistAction } from './add-to-blocklist-action';
import { LibraryRetryAction } from './retry-action';
import { LibraryDeleteAction } from './delete-action';
import { SkipAction } from './skip-action';
import type { FileRow, FileStatus } from '@/src/lib/db/schema';
import { formatBytes, formatBitrate, formatDuration, type FormatLocale } from '@/src/lib/format';
import type { LibraryTableSelection } from './library-table';

export function LibraryCardList({
  rows,
  onRowClick,
  rowRefs,
  selection,
}: {
  rows: FileRow[];
  onRowClick: (row: FileRow, target: HTMLElement) => void;
  rowRefs?: React.MutableRefObject<Map<number, HTMLElement>>;
  selection?: LibraryTableSelection;
}) {
  const t = useTranslations('library');
  const locale = useLocale() as FormatLocale;

  // audit-added S2 (02-04): optimistic override map for EncodeNowAction chip swap.
  const [optimisticOverrides, setOptimisticOverrides] = useState<Map<number, FileStatus>>(
    () => new Map(),
  );

  function handleOptimisticOverride(fileId: number, status: FileStatus | null) {
    setOptimisticOverrides((prev) => {
      const next = new Map(prev);
      if (status === null) next.delete(fileId);
      else next.set(fileId, status);
      return next;
    });
  }

  return (
    <>
      {selection && (
        <div className="mb-2 flex items-center gap-2 px-1">
          <Checkbox
            checked={selection.headerState === 'all'}
            indeterminate={selection.headerState === 'some'}
            onCheckedChange={() => selection.selectAllOnPage()}
            aria-label={t('selection.header.aria')}
            data-testid="library-bulk-select-all-cards"
          />
          <span className="text-xs text-muted-foreground">{t('selection.header.aria')}</span>
        </div>
      )}
      <ul className="flex flex-col gap-2">
        {rows.map((row) => {
          const displayStatus = optimisticOverrides.get(row.id) ?? row.status;
          return (
            <li key={row.id}>
              <div className="flex gap-3 rounded-lg border border-border bg-card p-3 transition-all duration-150 hover:bg-muted/50">
                {selection && (
                  <div
                    className="flex shrink-0 items-start pt-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Checkbox
                      checked={selection.isSelected(row.id)}
                      onCheckedChange={() => selection.toggle(row.id)}
                      aria-label={t('selection.row.aria', { filename: row.path })}
                      data-testid={`library-bulk-select-card-${row.id}`}
                    />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <button
                    type="button"
                    ref={(el) => {
                      if (!rowRefs) return;
                      if (el) rowRefs.current.set(row.id, el);
                      else rowRefs.current.delete(row.id);
                    }}
                    onClick={(e) => onRowClick(row, e.currentTarget)}
                    className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded min-h-[56px]"
                  >
                    <div className="flex items-baseline gap-1.5">
                      <span className="font-mono text-xs tabular-nums text-muted-foreground shrink-0 select-all">
                        #{row.id}
                      </span>
                      <span className="font-mono text-xs text-foreground line-clamp-2 break-all">
                        {row.path}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <StatusChip
                        status={displayStatus}
                        label={t(`status.${statusToI18nKey(displayStatus)}`)}
                      />
                      <span className="font-mono text-xs tabular-nums text-foreground">
                        {formatBytes(row.size_bytes, locale)}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {[
                        row.codec ?? '—',
                        row.bitrate != null ? formatBitrate(row.bitrate, locale) : '—',
                        row.duration_seconds != null ? formatDuration(row.duration_seconds) : '—',
                      ].join(' • ')}
                    </div>
                  </button>
                  {/* Row 4 footer: EncodeNowAction + AddToBlocklistAction + Retry (full-width on mobile) */}
                  <div className="mt-2 flex justify-end gap-1">
                    <EncodeNowAction file={row} onOptimisticOverride={handleOptimisticOverride} />
                    {/* 05-09 SkipAction renders only when file.status ∈ {queued,encoding}. */}
                    <SkipAction file={row} />
                    <AddToBlocklistAction file={row} />
                    <LibraryRetryAction file={row} />
                    <LibraryDeleteAction file={row} />
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
