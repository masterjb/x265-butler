'use client';

// 05-02 T1: Avatar circle with username initial.
// Phase 5 Plan 05-02 — audit M7 (NON-interactive; <div role="img"> not button —
// buttons that do nothing fail a11y heuristics).
//
// Tooltip on focus/hover via shadcn Tooltip wrapping the role=img div.
// Min 44×44 tap target via wrapper size-11. Initial uses Array.from() for
// Unicode-safe extraction ("Über" → "Ü").

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslations } from 'next-intl';

interface AvatarInitialProps {
  username: string | null;
}

export function AvatarInitial({ username }: AvatarInitialProps) {
  const t = useTranslations('topbar.user');
  const safe = username ?? '';
  const initial = Array.from(safe)[0]?.toUpperCase() ?? '?';
  const ariaLabel = t('tooltipUsername', { username: safe || '?' });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            role="img"
            aria-label={ariaLabel}
            tabIndex={0}
            data-testid="avatar-initial"
            className="flex size-11 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              aria-hidden="true"
              className="flex size-9 items-center justify-center rounded-full bg-muted font-sans text-sm font-semibold text-foreground"
            >
              {initial}
            </span>
          </div>
        }
      />
      <TooltipContent>{ariaLabel}</TooltipContent>
    </Tooltip>
  );
}
