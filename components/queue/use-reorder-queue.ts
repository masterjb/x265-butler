'use client';

// Plan 05-12 (B3 Queue Reorder): client hook owning the optimistic-mutation
// flow for the LEFT pane. Holds local state (orderedPending), dispatches the
// PATCH, manages submitLockRef + clientNonce + Undo toast + 409 rollback +
// network-error retry. UI components (pending-list-sortable) call reorder()
// on drop and render `orderedPending` instead of the raw livePending list.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { JobRow } from '@/src/lib/db/schema';

const UNDO_WINDOW_MS = 5000;
const UNDO_GATE_TIMEOUT_MS = 5000;

interface ReorderResult {
  ok: boolean;
  conflict?: number[];
  status?: number;
}

async function patchReorder(orderedJobIds: number[], clientNonce: string): Promise<ReorderResult> {
  const res = await fetch('/api/queue/reorder', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderedJobIds, clientNonce }),
  });
  if (res.ok) return { ok: true, status: res.status };
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { conflictingJobIds?: number[] };
    return { ok: false, conflict: body.conflictingJobIds ?? [], status: 409 };
  }
  return { ok: false, status: res.status };
}

function arraysEqualById(a: JobRow[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i]) return false;
  }
  return true;
}

function reorderById(rows: JobRow[], orderedJobIds: number[]): JobRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: JobRow[] = [];
  for (const id of orderedJobIds) {
    const r = byId.get(id);
    if (r) out.push(r);
  }
  return out;
}

export interface UseReorderQueueOptions {
  initialPending: JobRow[];
  livePending: JobRow[];
}

export interface UseReorderQueueResult {
  orderedPending: JobRow[];
  reorder(newOrderedJobIds: number[]): void;
  isReordering: boolean;
}

export function useReorderQueue({
  initialPending,
  livePending,
}: UseReorderQueueOptions): UseReorderQueueResult {
  const t = useTranslations('queue.reorder');
  const [orderedPending, setOrderedPending] = useState<JobRow[]>(initialPending);
  const [isReordering, setIsReordering] = useState(false);
  const submitLockRef = useRef(false);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const livePendingRef = useRef<JobRow[]>(livePending);
  livePendingRef.current = livePending;
  // orderedPendingRef tracks the latest state so runReorder + dispatchOnce
  // closures (kept stable across renders for stable callback identity) read
  // current state rather than the stale closure-captured value. Without this,
  // an Undo action defined at first render would compute priorIds against the
  // initial pending list instead of the post-optimistic list, and the
  // arraysEqualById short-circuit would suppress the Undo PATCH entirely.
  const orderedPendingRef = useRef<JobRow[]>(initialPending);
  orderedPendingRef.current = orderedPending;

  // S7 re-merge: when no PATCH is in-flight, upstream livePending is truth.
  useEffect(() => {
    if (submitLockRef.current) return;
    setOrderedPending(livePending);
  }, [livePending]);

  const isUndoDisabledFor = useCallback((priorIds: number[]): boolean => {
    const liveQueuedIds = new Set(
      livePendingRef.current.filter((j) => j.status === 'queued').map((j) => j.id),
    );
    return !priorIds.every((id) => liveQueuedIds.has(id));
  }, []);

  // M2: every dispatch (initial OR retry-on-network-error) reuses the same
  // nonce so the server-side LRU dedup short-circuits if the original landed.
  // Undo generates a SEPARATE nonce — it is a new logical operation.
  async function dispatchOnce(
    newOrderedJobIds: number[],
    nonce: string,
    priorIds: number[],
    opts: { isUndo: boolean },
  ): Promise<void> {
    submitLockRef.current = true;
    setIsReordering(true);
    try {
      const result = await patchReorder(newOrderedJobIds, nonce);
      if (result.ok) {
        // Success — keep optimistic state. Show Undo toast unless this IS the undo.
        if (!opts.isUndo) {
          toast.success(t('toast.success'), {
            duration: UNDO_WINDOW_MS,
            action: {
              label: t('toast.undo'),
              onClick: () => {
                if (isUndoDisabledFor(priorIds)) {
                  toast.info(t('undo.disabled.tooltip'));
                  return;
                }
                // M4: Undo gating — wait for any in-flight PATCH first.
                void runReorder(priorIds, { isUndo: true });
              },
            },
          });
        }
      } else if (result.status === 409) {
        // 409 conflict — revert to authoritative livePending snapshot.
        setOrderedPending(livePendingRef.current);
        toast.error(t('toast.conflict'));
      } else {
        // Network or other error — revert + retry option.
        setOrderedPending(livePendingRef.current);
        toast.error(t('toast.error'), {
          action: {
            label: t('toast.retry'),
            onClick: () => {
              // Single retry uses the SAME nonce so server-side dedup short-circuits
              // if the original actually landed.
              void runReorder(newOrderedJobIds, { nonce, isUndo: opts.isUndo });
            },
          },
        });
      }
    } catch {
      setOrderedPending(livePendingRef.current);
      toast.error(t('toast.error'), {
        action: {
          label: t('toast.retry'),
          onClick: () => {
            void runReorder(newOrderedJobIds, { nonce, isUndo: opts.isUndo });
          },
        },
      });
    } finally {
      submitLockRef.current = false;
      setIsReordering(false);
      inFlightRef.current = null;
    }
  }

  async function runReorder(
    newOrderedJobIds: number[],
    opts: { nonce?: string; isUndo?: boolean } = {},
  ): Promise<void> {
    // M4: Undo (and any subsequent reorder) waits for any in-flight PATCH to
    // resolve first — synchronous-lock pattern; sequential ordering preserved.
    if (inFlightRef.current) {
      try {
        await Promise.race([
          inFlightRef.current,
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('inflight_timeout')), UNDO_GATE_TIMEOUT_MS),
          ),
        ]);
      } catch {
        return;
      }
    }
    // S3 short-circuit no-op — read latest state via ref to avoid stale closure.
    const currentPending = orderedPendingRef.current;
    if (arraysEqualById(currentPending, newOrderedJobIds)) return;

    const priorIds = currentPending.map((j) => j.id);
    const nonce = opts.nonce ?? crypto.randomUUID();

    // Optimistic apply.
    setOrderedPending((prev) => reorderById(prev, newOrderedJobIds));

    const promise = dispatchOnce(newOrderedJobIds, nonce, priorIds, {
      isUndo: opts.isUndo === true,
    });
    inFlightRef.current = promise;
    await promise;
  }

  const reorder = useCallback((newOrderedJobIds: number[]): void => {
    void runReorder(newOrderedJobIds);
  }, []);

  return { orderedPending, reorder, isReordering };
}
