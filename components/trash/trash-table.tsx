'use client';

import { useTranslations, useLocale } from 'next-intl';
import { Trash2 } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/empty-state';
import { ExpiryChip } from './expiry-chip';
import { RestoreButton } from './restore-button';
import type { TrashEntryRow } from '@/src/lib/db/schema';
import { formatBytes, formatRelativeTime, type FormatLocale } from '@/src/lib/format';

// 13-02 T3: optional bulk-select prop. When undefined, no checkbox column renders.
export type TrashTableSelection = {
  isSelected: (id: number) => boolean;
  toggle: (id: number) => void;
  headerState: 'none' | 'some' | 'all';
  selectAllOnPage: () => void;
  visibleIds: readonly number[];
};

export function TrashTable({
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
    <Table>
      <TableHeader className="sticky top-0 z-10 bg-background">
        <TableRow>
          {selection && (
            <TableHead className="w-10 px-2">
              <Checkbox
                checked={selection.headerState === 'all'}
                indeterminate={selection.headerState === 'some'}
                onCheckedChange={() => selection.selectAllOnPage()}
                aria-label={t('selection.header.aria')}
                data-testid="trash-bulk-select-all"
              />
            </TableHead>
          )}
          <TableHead>{t('column.path')}</TableHead>
          <TableHead className="text-right">{t('column.size')}</TableHead>
          <TableHead>{t('column.trashed')}</TableHead>
          <TableHead>{t('column.expires')}</TableHead>
          <TableHead className="text-right">{t('column.actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id} className="transition-opacity duration-200">
            {selection && (
              <TableCell className="w-10 px-2 align-middle">
                <Checkbox
                  checked={selection.isSelected(row.id)}
                  onCheckedChange={() => selection.toggle(row.id)}
                  aria-label={t('selection.row.aria', { filename: row.original_path })}
                  data-testid={`trash-bulk-select-${row.id}`}
                />
              </TableCell>
            )}
            <TableCell
              className="font-mono text-xs max-w-[28rem] truncate"
              title={row.original_path}
            >
              {row.original_path}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatBytes(row.size_bytes, locale)}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {formatRelativeTime(row.trashed_at, now, locale)}
            </TableCell>
            <TableCell>
              <ExpiryChip expiresAt={row.expires_at} now={now} />
            </TableCell>
            <TableCell className="text-right">
              <RestoreButton
                entry={row}
                onRemoveRow={onRemoveRow}
                onSummaryRefetch={onSummaryRefetch}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
