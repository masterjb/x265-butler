'use client';

// Phase 21 Plan 21-02 — shared Card-wrapper for diagnostics sections.
//
// /ui-ux-pro-max T0 D1=md: full-width <md, side-by-side grid >=md via parent
// layout. Section itself stays single-column to keep operator scan-path linear.

import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';

export function DiagnosticsSection({
  title,
  icon: Icon,
  children,
  actions,
  className,
}: {
  title: string;
  icon?: LucideIcon;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('w-full', className)}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          {Icon && <Icon className="size-4 text-muted-foreground" aria-hidden="true" />}
          <span>{title}</span>
        </CardTitle>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </CardHeader>
      <CardContent className="pt-0">{children}</CardContent>
    </Card>
  );
}
