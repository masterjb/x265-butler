'use client';

// 05-03 T2.F: live status indicator for log viewer.
// Phase 5 Plan 05-03 — AC-6 + audit S8 (reduced-motion compliance).
//
// Three states with color + icon backup (color-not-only). Reduced-motion
// respected via `motion-safe:` Tailwind utilities — animations suppressed
// under prefers-reduced-motion: reduce.

import { CircleDot, Loader2, MinusCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

export type LiveStatus = 'live' | 'reconnecting' | 'static';

export function LiveStatusIndicator({
  status,
  className,
}: {
  status: LiveStatus;
  className?: string;
}) {
  const t = useTranslations('logs.perJob.viewer');
  const label =
    status === 'live'
      ? t('liveLabel')
      : status === 'reconnecting'
        ? t('reconnectingLabel')
        : t('staticLabel');

  const dotColor =
    status === 'live'
      ? 'bg-emerald-500'
      : status === 'reconnecting'
        ? 'bg-amber-500'
        : 'bg-muted-foreground';

  const Icon = status === 'live' ? CircleDot : status === 'reconnecting' ? Loader2 : MinusCircle;

  // audit S8: reduced-motion compliance — `motion-safe:` prefix means the
  // animation runs ONLY when the user has not requested reduced motion.
  const dotAnimation =
    status === 'live'
      ? 'motion-safe:animate-pulse'
      : status === 'reconnecting'
        ? 'motion-safe:animate-pulse'
        : '';
  const iconAnimation = status === 'reconnecting' ? 'motion-safe:animate-spin' : '';

  return (
    <span
      role="status"
      aria-label={label}
      className={cn('inline-flex items-center gap-2 text-xs', className)}
    >
      <span
        aria-hidden="true"
        data-state={status}
        className={cn('h-2 w-2 rounded-full', dotColor, dotAnimation)}
      />
      <Icon aria-hidden="true" className={cn('h-3 w-3 text-muted-foreground', iconAnimation)} />
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}
