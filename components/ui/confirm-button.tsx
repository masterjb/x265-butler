'use client';

// 13-01a T3: tri-variant <ConfirmButton variant="P1|P2|P3" /> foundation library.
// T0 design-decisions (2026-05-13):
//   S1 = P3 cooldown visual: progress-bar CSS + reduced-motion text-fallback.
//   S2 = P3 armed state:    red destructive + label-flip + icon-flip (non-color redundancy per AC-9 SR1).
//   S3 = Cancel-position:   inline-next-to-primary, 8px gap.
//   S4 = UndoToast shape:   progress-bar bottom + countdown-text (in undo-toast.tsx).
//   S5 = Focus management:  preserve-focus (no scroll-into-view).
// Audit M3: ESC keydown is instance-scoped via buttonRef/cancelRef contains(activeElement).
// Audit M4: useState + manual dispatch wrapping Date.now() (state-machine reducer is 3-arg).
// Audit M5: timer-useEffects depend on [state.kind] only; one timer per state-entry.
// Audit SR3: cooldown primary-button disabled + pointer-events-none.
// Audit SR4: default size 'md' = h-11 (44px touch-target Constraint Z.103).

import { AlertTriangle, Shield, X } from 'lucide-react';
import { useTranslations as useT } from 'next-intl';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/utils';
import {
  AUTO_DISARM_MS,
  COOLDOWN_MS,
  initialState,
  reducer,
  type Event as StateEvent,
  type State,
} from '@/src/lib/ui/confirm-button-state-machine';
import { useDeferredAction } from '@/src/lib/ui/use-deferred-action';
import { showUndoToast } from '@/components/ui/undo-toast';
import { toast } from 'sonner';

const UNDO_DELAY_MS = 10000;
const RESET_GRACE_MS = 200;

export type ConfirmButtonVariant = 'P1' | 'P2' | 'P3';
export type ConfirmButtonSize = 'sm' | 'md' | 'lg';

export type ConfirmButtonProps = {
  variant: ConfirmButtonVariant;
  onConfirm: () => void | Promise<void>;
  onUndo?: () => void;
  label: string;
  undoLabel?: string;
  cancelLabel?: string;
  successToastMessage?: string;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  size?: ConfirmButtonSize;
  // 13-01b T4 (audit M4 Route-1): per-instance undo-window length for P2.
  // Default = UNDO_DELAY_MS (10000); applies to P2 only (no-op for P1/P3).
  // Both useDeferredAction(delayMs) and showUndoToast({ durationMs }) consume
  // this value so the countdown UI and the actual fire-timer stay in sync.
  undoDelayMs?: number;
};

const SIZE_CLASS: Record<ConfirmButtonSize, string> = {
  sm: 'h-9 min-h-9 px-3 text-sm',
  md: 'h-11 min-h-11 px-4 text-sm',
  lg: 'h-12 min-h-12 px-5 text-base',
};

const BASE_BUTTON =
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-border bg-secondary font-medium text-secondary-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60 disabled:pointer-events-none';

export function ConfirmButton(props: ConfirmButtonProps): React.ReactElement {
  if (props.variant === 'P1') return <ConfirmButtonP1 {...props} />;
  if (props.variant === 'P2') return <ConfirmButtonP2 {...props} />;
  return <ConfirmButtonP3 {...props} />;
}

function ConfirmButtonP1({
  onConfirm,
  label,
  children,
  className,
  disabled,
  size = 'md',
}: ConfirmButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => void onConfirm()}
      disabled={disabled}
      className={cn(BASE_BUTTON, SIZE_CLASS[size], className)}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

function ConfirmButtonP2({
  onConfirm,
  onUndo,
  label,
  undoLabel,
  successToastMessage,
  children,
  className,
  disabled,
  size = 'md',
  undoDelayMs,
}: ConfirmButtonProps): React.ReactElement {
  const t = useT();
  const toastIdRef = useRef<string | number | null>(null);
  // 13-01b T4: per-instance override; both timer and toast read the same value.
  const effectiveDelay = undoDelayMs ?? UNDO_DELAY_MS;

  const deferred = useDeferredAction<void>(async () => {
    toastIdRef.current = null;
    await onConfirm();
  }, effectiveDelay);

  const handleClick = useCallback(() => {
    if (disabled) return;
    const id = showUndoToast({
      message: successToastMessage ?? label,
      undoLabel: undoLabel ?? t('common.confirm.undo'),
      onUndo: () => {
        deferred.cancel();
        onUndo?.();
      },
      durationMs: effectiveDelay,
    });
    toastIdRef.current = id;
    deferred.schedule(undefined, {
      onFire: () => {
        if (toastIdRef.current !== null) {
          toast.dismiss(toastIdRef.current);
          toastIdRef.current = null;
        }
      },
    });
  }, [deferred, disabled, effectiveDelay, label, onUndo, successToastMessage, t, undoLabel]);

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className={cn(BASE_BUTTON, SIZE_CLASS[size], className)}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

function ConfirmButtonP3({
  onConfirm,
  label,
  cancelLabel,
  children,
  className,
  disabled,
  size = 'md',
}: ConfirmButtonProps): React.ReactElement {
  const t = useT();
  const [state, setState] = useState<State>(initialState);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;
  const reduced = usePrefersReducedMotion();

  const dispatch = useCallback((event: StateEvent) => {
    setState((s) => reducer(s, event, Date.now()));
  }, []);

  useEffect(() => { // M5 deps: [state.kind]
    if (state.kind !== 'cooldown') return;
    const t1 = setTimeout(() => dispatch({ type: 'ELAPSE_COOLDOWN' }), COOLDOWN_MS);
    return () => clearTimeout(t1);
  }, [state.kind, dispatch]);

  useEffect(() => { // M5 deps: [state.kind]
    if (state.kind !== 'armed') return;
    const t2 = setTimeout(() => dispatch({ type: 'ELAPSE_AUTODISARM' }), AUTO_DISARM_MS);
    return () => clearTimeout(t2);
  }, [state.kind, dispatch]);

  // Reset-after-grace + fire on entering 'fired'.
  useEffect(() => {
    if (state.kind === 'fired') {
      void onConfirmRef.current();
    }
    if (
      state.kind === 'fired' ||
      state.kind === 'aborted' ||
      state.kind === 'autoDisarmed'
    ) {
      const t3 = setTimeout(() => dispatch({ type: 'RESET' }), RESET_GRACE_MS);
      return () => clearTimeout(t3);
    }
  }, [state.kind, dispatch]);

  // M3: ESC keydown — instance-scoped via ref-contains(activeElement).
  useEffect(() => {
    if (state.kind !== 'armed' && state.kind !== 'cooldown') return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const active = document.activeElement;
      const inside =
        (buttonRef.current && active && buttonRef.current.contains(active)) ||
        (cancelRef.current && active && cancelRef.current.contains(active));
      if (inside) {
        dispatch({ type: 'ABORT' });
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [state.kind, dispatch]);

  const handlePrimaryClick = useCallback(() => {
    if (disabled) return;
    if (state.kind === 'idle') {
      dispatch({ type: 'ARM' });
      return;
    }
    if (state.kind === 'armed') {
      dispatch({ type: 'CONFIRM' });
    }
  }, [disabled, state.kind, dispatch]);

  const handleCancel = useCallback(() => {
    dispatch({ type: 'ABORT' });
  }, [dispatch]);

  // SR3: cooldown primary disabled — click event must not reach reducer.
  const primaryDisabled = disabled || state.kind === 'cooldown';
  const isArmed = state.kind === 'armed';
  const showCancel = state.kind === 'cooldown' || state.kind === 'armed';

  const armedLabel = t('common.confirm.armedAriaLabel');
  const cooldownAriaLabel = t('common.confirm.cooldownAriaLabel');
  const resolvedCancelLabel = cancelLabel ?? t('common.confirm.cancel');

  // S1: cooldown visual — progress bar (or text-fallback for reduced-motion).
  const cooldownVisual = state.kind === 'cooldown' && !reduced ? (
    <span
      data-testid="confirm-button-cooldown-progress"
      aria-hidden="true"
      className="absolute inset-x-0 bottom-0 h-0.5 origin-left animate-[shrink_3s_linear] bg-primary"
    />
  ) : null;

  const cooldownTextFallback = state.kind === 'cooldown' && reduced ? (
    <span data-testid="confirm-button-cooldown-text" className="ml-2 text-xs opacity-70">
      {cooldownAriaLabel}
    </span>
  ) : null;

  return (
    <div className="inline-flex items-center gap-2" data-state={state.kind}>
      <button
        ref={buttonRef}
        type="button"
        onClick={handlePrimaryClick}
        disabled={primaryDisabled}
        aria-disabled={primaryDisabled}
        aria-busy={state.kind === 'cooldown'}
        aria-pressed={isArmed}
        aria-label={
          isArmed ? armedLabel : state.kind === 'cooldown' ? cooldownAriaLabel : label
        }
        data-testid="confirm-button-primary"
        className={cn(
          BASE_BUTTON,
          SIZE_CLASS[size],
          'relative overflow-hidden',
          state.kind === 'cooldown' && 'opacity-60 cursor-not-allowed pointer-events-none',
          isArmed &&
            'border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90',
          className,
        )}
      >
        {isArmed ? (
          <AlertTriangle className="size-4" aria-hidden="true" />
        ) : (
          <>
            {children ?? <Shield className="size-4" aria-hidden="true" />}
          </>
        )}
        <span>{isArmed ? armedLabel : label}</span>
        {cooldownVisual}
        {cooldownTextFallback}
      </button>
      {showCancel ? (
        <button
          ref={cancelRef}
          type="button"
          onClick={handleCancel}
          data-testid="confirm-button-cancel"
          className={cn(
            BASE_BUTTON,
            SIZE_CLASS[size],
            'border-border bg-background hover:bg-muted',
          )}
        >
          <X className="size-4" aria-hidden="true" />
          <span>{resolvedCancelLabel}</span>
        </button>
      ) : null}
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
