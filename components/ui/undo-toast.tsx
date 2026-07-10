'use client';

// 13-01a T4: UndoToast wrapper for ConfirmButton P2 (10s undo-window).
// audit SR5: countdown is wall-clock anchored to mountedAt — every tick
// re-anchors via (mountedAt + durationMs - Date.now()), so max drift = 1 tick
// instead of N×drift accumulation.

import { useEffect, useRef, useState } from 'react';
import { useTranslations as useT } from 'next-intl';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';

export type ShowUndoToastArgs = {
  message: string;
  undoLabel?: string;
  onUndo: () => void;
  durationMs?: number;
  ariaLive?: 'polite' | 'off';
};

export const UNDO_TOAST_DEFAULT_MS = 10000;

export function showUndoToast({
  message,
  undoLabel,
  onUndo,
  durationMs = UNDO_TOAST_DEFAULT_MS,
  ariaLive = 'polite',
}: ShowUndoToastArgs): string | number {
  return toast.custom(
    (id) => (
      <UndoToastContent
        toastId={id}
        message={message}
        undoLabel={undoLabel}
        onUndo={onUndo}
        durationMs={durationMs}
        ariaLive={ariaLive}
      />
    ),
    { duration: durationMs },
  );
}

type UndoToastContentProps = {
  toastId: string | number;
  message: string;
  undoLabel?: string;
  onUndo: () => void;
  durationMs: number;
  ariaLive: 'polite' | 'off';
};

function UndoToastContent({
  toastId,
  message,
  undoLabel,
  onUndo,
  durationMs,
  ariaLive,
}: UndoToastContentProps) {
  const t = useT();
  const reduced = usePrefersReducedMotion();

  const mountedAtRef = useRef<number | null>(null);
  if (mountedAtRef.current === null) mountedAtRef.current = Date.now();

  const [secondsRemaining, setSecondsRemaining] = useState(() =>
    Math.ceil(durationMs / 1000),
  );

  useEffect(() => {
    const tick = () => {
      const remaining = Math.max(
        0,
        (mountedAtRef.current ?? Date.now()) + durationMs - Date.now(),
      );
      setSecondsRemaining(Math.ceil(remaining / 1000));
    };
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [durationMs]);

  const resolvedUndoLabel = undoLabel ?? t('common.confirm.undo');
  const progressPct = Math.max(
    0,
    Math.min(100, ((secondsRemaining * 1000) / durationMs) * 100),
  );

  return (
    <div
      role="status"
      data-testid="undo-toast"
      className={cn(
        'flex w-full max-w-sm items-center gap-3 rounded-lg border border-border bg-background px-4 py-3 shadow-md',
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm text-foreground">{message}</span>
        {reduced ? (
          <span
            data-testid="undo-toast-countdown-text"
            aria-live={ariaLive}
            className="text-xs text-muted-foreground"
          >
            {t('common.confirm.undoCountdownAriaLabel', { seconds: secondsRemaining })}
          </span>
        ) : (
          <div className="relative h-1 overflow-hidden rounded-full bg-muted">
            <div
              data-testid="undo-toast-progress-bar"
              className="h-full bg-primary transition-[width] duration-200 ease-linear"
              style={{ width: `${progressPct}%` }}
              aria-hidden="true"
            />
            <span className="sr-only" aria-live={ariaLive}>
              {t('common.confirm.undoCountdownAriaLabel', { seconds: secondsRemaining })}
            </span>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          onUndo();
          toast.dismiss(toastId);
        }}
        className={cn(
          'inline-flex min-h-11 shrink-0 items-center justify-center rounded-md border border-border bg-secondary px-3 py-2 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        {resolvedUndoLabel}
      </button>
    </div>
  );
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return reduced;
}
