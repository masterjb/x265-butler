// Phase 21 Plan 21-03 T2 — action-cluster for 404/error surfaces.
//
// Server-Component-friendly: no 'use client', no state, no effects.
// 2-row layout:
//   row 1 (primary): caller-supplied heuristic-specific CTA (suggested-route
//          Link, Hard-Refresh hint, Onboarding starten, etc.)
//   row 2 (secondary): [Diagnostics] [Library] [Forum] + optional [Onboarding]
//          — consistent across every kind branch.
//
// Buttons are plain <a> tags with the existing buttonVariants() classes — the
// caller passes hrefs as plain strings so this component never depends on the
// next-intl `Link` (which would force a Client Component upstream).

import type { ReactNode } from 'react';
import { LayoutDashboard, Library, MessageSquare, Rocket } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ErrorActionClusterLabels {
  diagnostics: string;
  library: string;
  forum: string;
  onboarding: string;
}

export interface ErrorActionClusterProps {
  primaryAction?: ReactNode;
  diagnosticsHref: string;
  libraryHref: string;
  forumHref: string;
  onboardingHref?: string;
  labels: ErrorActionClusterLabels;
  // When true the secondary buttons render as plain <a> with target="_blank"
  // semantics consistent with next-intl Link. Forum link always opens new tab.
  className?: string;
}

const SECONDARY_BTN_CLASS = cn(
  buttonVariants({ variant: 'outline', size: 'lg' }),
  'min-h-[44px] flex-1 gap-2',
);

export function ErrorActionCluster({
  primaryAction,
  diagnosticsHref,
  libraryHref,
  forumHref,
  onboardingHref,
  labels,
  className,
}: ErrorActionClusterProps) {
  return (
    <div
      className={cn('mt-8 flex w-full max-w-2xl flex-col gap-3', className)}
      role="group"
      aria-label="error-action-cluster"
    >
      {primaryAction && (
        <div className="flex flex-wrap items-center justify-center gap-2">{primaryAction}</div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-center">
        <a
          href={diagnosticsHref}
          className={SECONDARY_BTN_CLASS}
          data-testid="action-diagnostics"
          aria-label={labels.diagnostics}
        >
          <LayoutDashboard className="size-4" aria-hidden="true" />
          <span>{labels.diagnostics}</span>
        </a>
        <a
          href={libraryHref}
          className={SECONDARY_BTN_CLASS}
          data-testid="action-library"
          aria-label={labels.library}
        >
          <Library className="size-4" aria-hidden="true" />
          <span>{labels.library}</span>
        </a>
        <a
          href={forumHref}
          target="_blank"
          rel="noopener noreferrer"
          className={SECONDARY_BTN_CLASS}
          data-testid="action-forum"
          aria-label={labels.forum}
        >
          <MessageSquare className="size-4" aria-hidden="true" />
          <span>{labels.forum}</span>
        </a>
        {onboardingHref && (
          <a
            href={onboardingHref}
            className={SECONDARY_BTN_CLASS}
            data-testid="action-onboarding"
            aria-label={labels.onboarding}
          >
            <Rocket className="size-4" aria-hidden="true" />
            <span>{labels.onboarding}</span>
          </a>
        )}
      </div>
    </div>
  );
}
