// 13-01a T2: deferred-action hook for ConfirmButton P2 (undo-toast 10s pattern).
// audit M2: isPendingRef mirrors useState — visibility-listener reads ref, never closure.
// audit SR6: optional fireOnHidden opt-out per-callsite.
// audit SR7: optional onFire callback (set via schedule meta) for caller-side cleanup
// (e.g. toast.dismiss to avoid stale UndoToast UI after auto-fire-on-hidden).
// audit SR10: visibilitychange='visible' is no-op (no auto re-fire on tab return).

import { useCallback, useEffect, useRef, useState } from 'react';

export type ScheduleMeta = {
  onFire?: () => void;
};

export type UseDeferredActionOptions = {
  fireOnHidden?: boolean;
};

export type DeferredAction<T> = {
  schedule: (payload: T, meta?: ScheduleMeta) => void;
  cancel: () => void;
  fireNow: () => void;
  isPending: boolean;
};

export function useDeferredAction<T>(
  fn: (payload: T) => void | Promise<void>,
  delayMs: number,
  options: UseDeferredActionOptions = {},
): DeferredAction<T> {
  const fireOnHidden = options.fireOnHidden ?? true;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const payloadRef = useRef<T | null>(null);
  const metaRef = useRef<ScheduleMeta | null>(null);
  const isPendingRef = useRef(false);
  const mountedRef = useRef(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const [isPending, setIsPending] = useState(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const doFire = useCallback(() => {
    if (!isPendingRef.current) return;
    clearTimer();
    const payload = payloadRef.current as T;
    const meta = metaRef.current;
    payloadRef.current = null;
    metaRef.current = null;
    isPendingRef.current = false;
    if (mountedRef.current) setIsPending(false);
    if (meta?.onFire) {
      try {
        meta.onFire();
      } catch {
        // caller-side cleanup; never break fn-fire on toast-dismiss-failure
      }
    }
    void fnRef.current(payload);
  }, [clearTimer]);

  const schedule = useCallback(
    (payload: T, meta?: ScheduleMeta) => {
      clearTimer();
      payloadRef.current = payload;
      metaRef.current = meta ?? null;
      isPendingRef.current = true;
      if (mountedRef.current) setIsPending(true);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        doFire();
      }, delayMs);
    },
    [clearTimer, delayMs, doFire],
  );

  const cancel = useCallback(() => {
    clearTimer();
    payloadRef.current = null;
    metaRef.current = null;
    isPendingRef.current = false;
    if (mountedRef.current) setIsPending(false);
  }, [clearTimer]);

  const fireNow = useCallback(() => {
    doFire();
  }, [doFire]);

  useEffect(() => {
    if (!fireOnHidden) return;
    const handler = () => {
      if (document.visibilityState === 'hidden' && isPendingRef.current) {
        doFire();
      }
      // SR10: 'visible' → no-op; do not re-fire / re-schedule on tab return.
    };
    document.addEventListener('visibilitychange', handler);
    return () => {
      document.removeEventListener('visibilitychange', handler);
    };
  }, [fireOnHidden, doFire]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    [],
  );

  return { schedule, cancel, fireNow, isPending };
}
