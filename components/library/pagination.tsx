'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const PAGE_SIZE_OPTIONS = ['25', '50', '100', '200'] as const;

type Props = {
  page: number;
  size: number;
  total: number;
  pageCount: number;
  onPageChange: (next: number) => void;
  onSizeChange: (next: number) => void;
};

function buildPageList(current: number, last: number): (number | 'ellipsis')[] {
  if (last <= 7) return Array.from({ length: last }, (_, i) => i + 1);
  const pages: (number | 'ellipsis')[] = [1];
  if (current > 4) pages.push('ellipsis');
  const start = Math.max(2, current - 1);
  const end = Math.min(last - 1, current + 1);
  for (let i = start; i <= end; i++) pages.push(i);
  if (current < last - 3) pages.push('ellipsis');
  pages.push(last);
  return pages;
}

export function Pagination({ page, size, total, pageCount, onPageChange, onSizeChange }: Props) {
  const t = useTranslations('library');
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(total, page * size);

  // audit-added S5: Home/End jump to first/last page when focus is anywhere
  // on the pagination control.
  function onContainerKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Home') {
      e.preventDefault();
      onPageChange(1);
    } else if (e.key === 'End' && pageCount > 0) {
      e.preventDefault();
      onPageChange(pageCount);
    }
  }

  const pages = pageCount > 0 ? buildPageList(page, pageCount) : [];

  return (
    <div
      className="flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between"
      onKeyDown={onContainerKeyDown}
      role="navigation"
      aria-label={t('pagination.aria')}
    >
      <div className="text-xs text-muted-foreground tabular-nums">
        {t('pagination.showing', { from, to, total })}
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={t('pagination.prev')}
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft />
        </Button>
        <ul className="flex items-center gap-1">
          {pages.map((p, i) =>
            p === 'ellipsis' ? (
              <li key={`e-${i}`} className="px-2 text-muted-foreground">
                …
              </li>
            ) : (
              <li key={p}>
                <Button
                  type="button"
                  variant={p === page ? 'default' : 'ghost'}
                  size="sm"
                  aria-current={p === page ? 'page' : undefined}
                  onClick={() => onPageChange(p)}
                  className={cn('min-w-8 tabular-nums')}
                >
                  {p}
                </Button>
              </li>
            ),
          )}
        </ul>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={t('pagination.next')}
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight />
        </Button>
        <Select value={String(size)} onValueChange={(v) => onSizeChange(Number(v))}>
          <SelectTrigger size="sm" aria-label={t('pagination.pageSize')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
