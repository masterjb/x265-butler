// Phase 21 Plan 21-03 T2 — heuristic-callout card for 404/error surfaces.
//
// Server-Component-friendly: no 'use client', no state, no effects. Renders a
// centered card with icon + h1 title + body + optional primaryAction slot.
// secondaryCallout renders as an inset banner subordinated below the primary
// callout (option-alpha layout per T0).

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface HeuristicCalloutProps {
  icon: LucideIcon;
  title: string;
  body: string;
  primaryAction?: ReactNode;
  secondaryCallout?: {
    icon?: LucideIcon;
    title: string;
    body: string;
    action?: ReactNode;
  };
  // Optional `data-kind` attribute used by tests + analytics.
  kind?: string;
  className?: string;
}

export function HeuristicCallout({
  icon: Icon,
  title,
  body,
  primaryAction,
  secondaryCallout,
  kind,
  className,
}: HeuristicCalloutProps) {
  const SecondaryIcon = secondaryCallout?.icon;

  return (
    <section
      data-kind={kind}
      className={cn(
        'flex w-full flex-col items-center gap-5 px-6 py-12 text-center',
        'min-h-[50vh]',
        className,
      )}
      aria-labelledby="heuristic-callout-title"
    >
      <Icon
        className="size-16 text-muted-foreground md:size-20"
        aria-hidden="true"
        strokeWidth={1.5}
      />
      <h1
        id="heuristic-callout-title"
        className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl"
      >
        {title}
      </h1>
      <p className="max-w-prose text-base text-muted-foreground md:text-lg">{body}</p>
      {primaryAction && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{primaryAction}</div>
      )}

      {secondaryCallout && (
        <aside
          data-testid="secondary-callout"
          className={cn(
            'mt-6 w-full max-w-xl rounded-lg border border-border bg-muted/40 p-4',
            'flex flex-col items-center gap-2 text-center md:flex-row md:items-start md:text-left',
          )}
          aria-labelledby="secondary-callout-title"
        >
          {SecondaryIcon && (
            <SecondaryIcon
              className="size-5 shrink-0 text-muted-foreground"
              aria-hidden="true"
              strokeWidth={1.5}
            />
          )}
          <div className="flex flex-1 flex-col gap-1">
            <h2
              id="secondary-callout-title"
              className="text-sm font-medium text-foreground md:text-base"
            >
              {secondaryCallout.title}
            </h2>
            <p className="text-sm text-muted-foreground">{secondaryCallout.body}</p>
          </div>
          {secondaryCallout.action && (
            <div className="mt-2 md:mt-0 md:ml-auto">{secondaryCallout.action}</div>
          )}
        </aside>
      )}
    </section>
  );
}
