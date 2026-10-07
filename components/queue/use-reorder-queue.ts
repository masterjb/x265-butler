'use client';

// Queue reorder: client hook owning the optimistic-mutation
// flow for the LEFT pane. Holds local state (orderedPending), dispatches the
// PATCH, manages submitLockRef + clientNonce + Undo toast + 409 rollback +
// network-error retry. UI components (pending-list-sortable) call
// reorder(jobId, beforeJobId) on drop and render `orderedPending` instead of
// the raw livePending list. Only the moved job and its new neighbour go over
// the wire, never the whole list.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { arrayMove } from '@dnd-kit/sortable';
import type { JobRow } from '@/src/lib/db/schema';
import { randomUuidV4 } from '@/src/lib/ui/random-uuid';

const UNDO_WINDOW_MS = 5000;
const UNDO_GATE_TIMEOUT_MS = 5000;

interface ReorderResult {
  ok: boolean;
  conflict?: number[];
  status?: number;
}

// One move: `jobId` goes in front of `beforeJobId` (null = to the end).
export interface Move {
  jobId: number;
  beforeJobId: number | null;
}

async function patchReorder(move: Move, clientNonce: string): Promise<ReorderResult> {
  const res = await fetch('/api/queue/reorder', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId: move.jobId, beforeJobId: move.beforeJobId, clientNonce }),
  });
  if (res.ok) return { ok: true, status: res.status };
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { conflictingJobIds?: number[] };
    return { ok: false, conflict: body.conflictingJobIds ?? [], status: 409 };
  }
  return { ok: false, status: res.status };
}

// A drag from index `fromIdx` to `toIdx` (dnd-kit arrayMove semantics) as one
// move: the dragged job goes in front of the job that follows it after the
// drop, or to the end when nothing follows.
export function moveForDrop(rows: JobRow[], fromIdx: number, toIdx: number): Move {
  const next = arrayMove(rows, fromIdx, toIdx);
  return { jobId: rows[fromIdx].id, beforeJobId: next[toIdx + 1]?.id ?? null };
}

// The job that follows `jobId` now (null when it is the last one), i.e. the
// neighbour that puts it back where it is.
function nextIdAfter(rows: JobRow[], jobId: number): number | null {
  const idx = rows.findIndex((r) => r.id === jobId);
  return idx >= 0 && idx + 1 < rows.length ? rows[idx + 1].id : null;
}

function applyMove(rows: JobRow[], move: Move): JobRow[] {
  const moved = rows.find((r) => r.id === move.jobId);
  if (!moved) return rows;
  const rest = rows.filter((r) => r.id !== move.jobId);
  const at = move.beforeJobId === null ? -1 : rest.findIndex((r) => r.id === move.beforeJobId);
  if (at < 0) return [...rest, moved];
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}

export interface UseReorderQueueOptions {
  initialPending: JobRow[];
  livePending: JobRow[];
  // Called after the server accepted a move. The server pins every job up to
  // the drop point, which the optimistic list does not know, so the caller
  // reloads the authoritative state (pins, count) here.
  onApplied?: () => void;
}

export interface UseReorderQueueResult {
  orderedPending: JobRow[];
  reorder(jobId: number, beforeJobId: number | null): void;
  isReordering: boolean;
}

export function useReorderQueue({
  initialPending,
  livePending,
  onApplied,
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
  // an Undo action defined at first render would look up the old neighbour in
  // the initial pending list instead of the post-optimistic list, and the
  // no-op short-circuit would suppress the Undo PATCH entirely.
  const orderedPendingRef = useRef<JobRow[]>(initialPending);
  orderedPendingRef.current = orderedPending;
  const onAppliedRef = useRef(onApplied);
  onAppliedRef.current = onApplied;

  // Re-merge: when no PATCH is in-flight, upstream livePending is truth.
  useEffect(() => {
    if (submitLockRef.current) return;
    setOrderedPending(livePending);
  }, [livePending]);

  // Undo needs the moved job and its old neighbour still queued.
  const isUndoDisabledFor = useCallback((undo: Move): boolean => {
    const liveQueuedIds = new Set(
      livePendingRef.current.filter((j) => j.status === 'queued').map((j) => j.id),
    );
    if (!liveQueuedIds.has(undo.jobId)) return true;
    return undo.beforeJobId !== null && !liveQueuedIds.has(undo.beforeJobId);
  }, []);

  // Every dispatch (initial OR retry-on-network-error) reuses the same
  // nonce so the server-side LRU dedup short-circuits if the original landed.
  // Undo generates a SEPARATE nonce — it is a new logical operation.
  async function dispatchOnce(
    move: Move,
    nonce: string,
    undo: Move,
    opts: { isUndo: boolean },
  ): Promise<void> {
    submitLockRef.current = true;
    setIsReordering(true);
    try {
      const result = await patchReorder(move, nonce);
      if (result.ok) {
        onAppliedRef.current?.();
        // Success — keep optimistic state. Show Undo toast unless this IS the undo.
        if (!opts.isUndo) {
          toast.success(t('toast.success'), {
            duration: UNDO_WINDOW_MS,
            action: {
              label: t('toast.undo'),
              onClick: () => {
                if (isUndoDisabledFor(undo)) {
                  toast.info(t('undo.disabled.tooltip'));
                  return;
                }
                // Undo gating — wait for any in-flight PATCH first.
                void runReorder(undo, { isUndo: true });
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
              void runReorder(move, { nonce, isUndo: opts.isUndo });
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
            void runReorder(move, { nonce, isUndo: opts.isUndo });
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
    move: Move,
    opts: { nonce?: string; isUndo?: boolean } = {},
  ): Promise<void> {
    // Undo (and any subsequent reorder) waits for any in-flight PATCH to
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
    // Short-circuit no-op (already in front of that neighbour) — read latest
    // state via ref to avoid stale closure.
    const currentPending = orderedPendingRef.current;
    const undo: Move = { jobId: move.jobId, beforeJobId: nextIdAfter(currentPending, move.jobId) };
    if (undo.beforeJobId === move.beforeJobId || move.jobId === move.beforeJobId) return;

    const nonce = opts.nonce ?? randomUuidV4();

    // Optimistic apply.
    setOrderedPending((prev) => applyMove(prev, move));

    const promise = dispatchOnce(move, nonce, undo, {
      isUndo: opts.isUndo === true,
    });
    inFlightRef.current = promise;
    await promise;
  }

  const reorder = useCallback((jobId: number, beforeJobId: number | null): void => {
    void runReorder({ jobId, beforeJobId });
  }, []);

  return { orderedPending, reorder, isReordering };
}
