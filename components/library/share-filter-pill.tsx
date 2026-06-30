'use client';

import { ChevronDown, Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { ShareRow } from '@/src/lib/db/schema';

// 14-03: share-axis filter pill for /library. Pattern decided in Task-2 design
// gate: shadcn DropdownMenu (Option A). Coexists with status-axis FilterBar by
// using a distinct "Share: <name>" label-prefix so operators can tell the
// scope-axis filter apart from the content-axis chip-row.

export type ShareActiveValue = number | 'all' | 'orphan';

export interface ShareFilterPillProps {
  shares: ShareRow[];
  orphanCount: number;
  active: ShareActiveValue;
  onChange: (next: ShareActiveValue) => void;
  /**
   * Optional callback that consumers (LibraryClient) wire to a shared
   * `aria-live="polite"` region so screen-reader announcements from
   * status-axis FilterBar + share-axis pill share ONE landmark.
   * Audit SR2 — prevents double-announce.
   */
  onAnnounce?: (message: string) => void;
}

export function ShareFilterPill({
  shares,
  orphanCount,
  active,
  onChange,
  onAnnounce,
}: ShareFilterPillProps) {
  const t = useTranslations('library.shareFilter');

  // AC-9 visibility rules.
  if (shares.length === 0) return null;
  if (shares.length === 1 && orphanCount === 0) return null;

  // M1: defensive lookup — if `active` is a numeric id NOT in shares[] (URL
  // hack `?share=99999` OR race-with-future-CRUD), `activeShare` falls back
  // to undefined and trigger renders "Share: All".
  const activeShare = typeof active === 'number' ? shares.find((s) => s.id === active) : undefined;
  const activeIsKnownId = typeof active === 'number' && !!activeShare;

  const triggerLabel =
    active === 'orphan'
      ? t('triggerLabelOrphan')
      : active === 'all' || !activeShare
        ? t('triggerLabelAll')
        : t('triggerLabel', { name: activeShare.name });

  // SR6: native tooltip carries the full untruncated name so operators can
  // hover a truncated label.
  const triggerTitle = activeShare?.name ?? '';

  function announce(next: ShareActiveValue) {
    if (!onAnnounce) return;
    if (next === 'all') {
      onAnnounce(t('announceChange', { type: 'all', name: '' }));
    } else if (next === 'orphan') {
      onAnnounce(t('announceChange', { type: 'orphan', name: '' }));
    } else {
      const row = shares.find((s) => s.id === next);
      onAnnounce(t('announceChange', { type: 'share', name: row?.name ?? '' }));
    }
  }

  function handleSelect(next: ShareActiveValue) {
    onChange(next);
    announce(next);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="default"
            aria-label={t('aria')}
            title={triggerTitle}
            className="min-h-[44px] gap-1.5 px-3"
          />
        }
      >
        {/* SR6: label-span is the ONLY truncated element; chevron sits OUTSIDE
            the span so it never gets clipped. max-width 12rem ≈ 192px keeps
            the trigger compact even at 375px viewport. */}
        <span className="inline-block max-w-[12rem] overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium">
          {triggerLabel}
        </span>
        <ChevronDown className="size-4 shrink-0 opacity-60" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[12rem]">
        <DropdownMenuItem
          aria-current={active === 'all' || !activeIsKnownId ? 'true' : undefined}
          onClick={() => handleSelect('all')}
          className="min-h-[44px]"
        >
          <span className="flex-1">{t('all')}</span>
          {(active === 'all' || !activeIsKnownId) && active !== 'orphan' && (
            <Check className="size-4" aria-hidden="true" />
          )}
        </DropdownMenuItem>
        {shares.map((s) => {
          const isActive = activeIsKnownId && activeShare?.id === s.id;
          return (
            <DropdownMenuItem
              key={s.id}
              aria-current={isActive ? 'true' : undefined}
              onClick={() => handleSelect(s.id)}
              className={cn('min-h-[44px]', isActive && 'bg-accent text-accent-foreground')}
            >
              <span className="flex-1 truncate" title={s.name}>
                {s.name}
              </span>
              {isActive && <Check className="size-4" aria-hidden="true" />}
            </DropdownMenuItem>
          );
        })}
        {orphanCount > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              aria-current={active === 'orphan' ? 'true' : undefined}
              onClick={() => handleSelect('orphan')}
              className={cn(
                'min-h-[44px]',
                active === 'orphan' && 'bg-accent text-accent-foreground',
              )}
            >
              <span className="flex-1">{t('orphan', { count: orphanCount })}</span>
              {active === 'orphan' && <Check className="size-4" aria-hidden="true" />}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
