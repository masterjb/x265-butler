'use client';

// 15-02 T2: Storage Toolbar — Share-Filter-Pill reuse (14-03) +
// Depth-Selector (page-local) + as-of label that re-announces on SWR
// revalidate. Share-pill is hidden by its own visibility rules when there is
// only one share configured; the toolbar still renders so the depth-selector
// and as-of stay reachable.

import { useTranslations } from 'next-intl';

import { ShareFilterPill, type ShareActiveValue } from '@/components/library/share-filter-pill';
import { formatTime } from '@/src/lib/format';
import type { ShareRow } from '@/src/lib/db/schema';

import { DepthSelector, type DepthValue } from './depth-selector';

export interface StorageToolbarProps {
  shares: ShareRow[];
  orphanCount: number;
  share: ShareActiveValue;
  onShareChange: (next: ShareActiveValue) => void;
  depth: DepthValue;
  onDepthChange: (next: DepthValue) => void;
  computedAt: string | null;
}

export function StorageToolbar({
  shares,
  orphanCount,
  share,
  onShareChange,
  depth,
  onDepthChange,
  computedAt,
}: StorageToolbarProps) {
  const t = useTranslations('storage.toolbar');
  const asOfText = computedAt ? t('asOfLabel', { time: formatTime(computedAt) }) : t('asOfPending');

  return (
    <div className="flex flex-wrap items-center gap-3" role="toolbar" aria-label={t('toolbarAria')}>
      <ShareFilterPill
        shares={shares}
        orphanCount={orphanCount}
        active={share}
        onChange={onShareChange}
      />
      <DepthSelector value={depth} onChange={onDepthChange} />
      <span
        data-testid="as-of-label"
        aria-live="polite"
        className="ml-auto text-xs text-muted-foreground font-mono tabular-nums"
      >
        {asOfText}
      </span>
    </div>
  );
}
