// 13-02 T4 — Shared SelectionBar component for bulk-action surfaces (Library + Trash).
// Layout per T0 design-decisions:
//   S1 desktop-anchor: sticky-TOP (matches Filter-Bar + Bench-Apply-Toast precedent)
//   S2 mobile: compact 80px bottom-bar (single-row count + actions + clear)
//   S3 action-cluster: inline buttons (Parent supplies via children slot)
//   S5 max-cap: visual warning when count > maxCap; consumer disables action-buttons
//
// Per-page-only persistence (AC-9): Parent controls mount/unmount via {selectedCount > 0 && ...}.
// Component does not no-op internally — render contract is "if instantiated with count>=1, show".
// Defensive guard: count===0 returns null so misuse doesn't render an empty frame.

'use client';

import * as React from 'react';
import { X, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

const DEFAULT_MAX_CAP = 500;

export type SelectionBarProps = {
  count: number;
  onClear: () => void;
  children: React.ReactNode; // action-cluster supplied by Parent (P1/P2/P3 ConfirmButtons)
  maxCap?: number; // default 500
  countLabel: string; // pre-translated "N selected" copy from Parent
  clearLabel: string; // pre-translated "Clear selection" copy from Parent
  maxWarningLabel?: string; // optional pre-translated "X von max 500 — bitte um Y reduzieren"
  className?: string;
};

export function SelectionBar({
  count,
  onClear,
  children,
  maxCap = DEFAULT_MAX_CAP,
  countLabel,
  clearLabel,
  maxWarningLabel,
  className,
}: SelectionBarProps) {
  if (count <= 0) return null;
  const overCap = count > maxCap;

  return (
    <>
      {/* Desktop: sticky-TOP under Topbar. Hidden below md breakpoint. */}
      <div
        role="region"
        aria-label={countLabel}
        data-testid="selection-bar-desktop"
        className={cn(
          'sticky top-14 z-40 hidden md:flex',
          'h-14 w-full items-center gap-3 border-b bg-background/95 px-4 backdrop-blur',
          'shadow-sm',
          className,
        )}
      >
        <span className="text-sm font-medium">{countLabel}</span>
        {overCap && maxWarningLabel && (
          <span
            data-testid="selection-bar-max-warning-desktop"
            className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive"
          >
            <AlertTriangle className="size-3.5" aria-hidden="true" />
            {maxWarningLabel}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">{children}</div>
        <button
          type="button"
          onClick={onClear}
          aria-label={clearLabel}
          data-testid="selection-bar-clear-desktop"
          className="inline-flex h-11 min-h-11 items-center gap-2 rounded-md border bg-background px-4 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" aria-hidden="true" />
          {clearLabel}
        </button>
      </div>

      {/* Mobile: compact 80px fixed bottom-bar. Hidden at md+. */}
      <div
        role="region"
        aria-label={countLabel}
        data-testid="selection-bar-mobile"
        className={cn(
          'md:hidden fixed inset-x-0 bottom-0 z-40 flex h-20 items-center gap-2 border-t bg-background/95 px-3 backdrop-blur shadow-lg',
          className,
        )}
      >
        <div className="flex flex-col">
          <span className="text-sm font-medium leading-tight">{countLabel}</span>
          {overCap && maxWarningLabel && (
            <span
              data-testid="selection-bar-max-warning-mobile"
              className="inline-flex items-center gap-1 text-xs text-destructive"
            >
              <AlertTriangle className="size-3" aria-hidden="true" />
              {maxWarningLabel}
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">{children}</div>
        <button
          type="button"
          onClick={onClear}
          aria-label={clearLabel}
          data-testid="selection-bar-clear-mobile"
          className="inline-flex size-11 items-center justify-center rounded-md border bg-background hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </>
  );
}
