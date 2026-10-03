'use client';

import { useTranslations } from 'next-intl';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { FileStatus } from '@/src/lib/db/schema';
import type { CountByStatus } from '@/src/lib/db/repos/file';
import { statusToI18nKey } from './status-chip';

type FilterValue = FileStatus | 'all';

const STATUS_ORDER: readonly FilterValue[] = [
  'all',
  'pending',
  'queued',
  'encoding',
  'done-smaller',
  'done-larger',
  // 05-13: 3-bucket verdict additions. Grouped near the other terminal
  // 'done-*' values so operators see the related buckets together.
  'done-not-worth',
  'done-already-evaluated',
  'failed',
  'skipped-codec',
  'skipped-bitrate',
  'skipped-suffix',
  'skipped-tag',
  'skipped-sidecar',
  'skipped-blocklist',
  'blocklisted',
  'interrupted',
  // 05-bonus: 'vanished' chip appears at the end. The visible filter in
  // FilterBar only renders chips with count > 0 OR currently active, so
  // operators in a healthy library never see the chip.
  'vanished',
];

export function FilterBar({
  active,
  counts,
  onChange,
}: {
  active: FilterValue;
  counts: CountByStatus;
  onChange: (next: FilterValue) => void;
}) {
  const t = useTranslations('library');

  // Hide buckets with zero rows except for the currently-active one and "all".
  const visible = STATUS_ORDER.filter(
    (s) => s === 'all' || s === active || (counts[s as FileStatus] ?? 0) > 0,
  );

  function labelFor(status: FilterValue): string {
    return status === 'all'
      ? t('filter.all')
      : t(`status.${statusToI18nKey(status as FileStatus)}`);
  }

  function countFor(status: FilterValue): number {
    return status === 'all' ? counts.all : (counts[status as FileStatus] ?? 0);
  }

  return (
    <>
      {/* Mobile (<md): native-style Select dropdown — avoids horizontal-scroll
          (ux-pro-max severity HIGH on overflow-x). All options sichtbar im
          one-tap-open menu, kompakt + screen-reader friendly. */}
      <div className="md:hidden" role="group" aria-label={t('filter.aria')}>
        <Select value={active} onValueChange={(v) => onChange(v as FilterValue)}>
          <SelectTrigger className="w-full h-11 text-sm" aria-label={t('filter.aria')}>
            <SelectValue>{`${labelFor(active)} (${countFor(active)})`}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {visible.map((status) => (
              <SelectItem
                key={status}
                value={status}
                className="min-h-[44px] py-3 pr-8 pl-3 text-base"
              >
                {labelFor(status)} ({countFor(status)})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Desktop (≥md): chip-bar with horizontal-scroll fallback at edge cases. */}
      <div
        className="hidden md:flex w-full items-center gap-2 overflow-x-auto pb-1"
        role="group"
        aria-label={t('filter.aria')}
      >
        {visible.map((status) => {
          const count = countFor(status);
          const isActive = active === status;
          return (
            <button
              key={status}
              type="button"
              role="radio"
              aria-checked={isActive}
              onClick={() => onChange(status)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors min-h-[32px]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <span>{labelFor(status)}</span>
              <span
                className={cn(
                  'tabular-nums',
                  isActive ? 'text-primary-foreground/80' : 'text-muted-foreground/70',
                )}
              >
                ({count})
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
