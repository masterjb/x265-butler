'use client';

import { useTranslations, useLocale } from 'next-intl';
import { Trash2 } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/empty-state';
import { ExpiryChip } from './expiry-chip';
import { RestoreButton } from './restore-button';
import type { TrashEntryRow } from '@/src/lib/db/schema';
import { formatBytes, formatRelativeTime, type FormatLocale } from '@/src/lib/format';
import type { TrashTableSelection } from './trash-table';

export function TrashCardList({
  rows,
  onRemoveRow,
  onSummaryRefetch,
  selection,
}: {
  rows: TrashEntryRow[];
  onRemoveRow: (id: number) => void;
  onSummaryRefetch: () => void;
  selection?: TrashTableSelection;
}) {
  const t = useTranslations('trash');
  const locale = useLocale() as FormatLocale;
  const now = Math.floor(Date.now() / 1000);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Trash2}
        title={t('empty.headline')}
        hint={t('empty.helper', { retentionDays: 30 })}
      />
    );
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
            data-testid="trash-bulk-select-all-cards"
          />
          <span className="text-xs text-muted-foreground">{t('selection.header.aria')}</span>
        </div>
      )}
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.id}>
            <div className="flex gap-3 rounded-lg border border-border bg-card p-3">
              {selection && (
                <div className="flex shrink-0 items-start pt-1">
                  <Checkbox
                    checked={selection.isSelected(row.id)}
                    onCheckedChange={() => selection.toggle(row.id)}
                    aria-label={t('selection.row.aria', { filename: row.original_path })}
                    data-testid={`trash-bulk-select-card-${row.id}`}
                  />
                </div>
              )}
              <div className="flex-1 min-w-0">
                {/* Row 1: path */}
                <p className="font-mono text-xs text-foreground line-clamp-2 break-all">
                  {row.original_path}
                </p>
                {/* Row 2: size + expiry */}
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="font-mono text-xs tabular-nums">
                    {formatBytes(row.size_bytes, locale)}
                  </span>
                  <ExpiryChip expiresAt={row.expires_at} now={now} />
                </div>
                {/* Row 3: trashed time + restore */}
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTime(row.trashed_at, now, locale)}
                  </span>
                  <RestoreButton
                    entry={row}
                    onRemoveRow={onRemoveRow}
                    onSummaryRefetch={onSummaryRefetch}
                  />
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
