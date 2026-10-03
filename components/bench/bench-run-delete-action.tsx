'use client';

// 47-02 T1 — row-level bench-run purge. Modeled 1:1 on
// components/library/delete-action.tsx (Trash2 + submitLockRef + timeout), but the
// variant is P3, NOT P2: a bench_run purge is IRREVERSIBLE and there is no trash
// tier for it (47-01 D1). The inverted-cooldown confirm IS the only safety margin —
// downgrading it to P2 or a plain button removes it with nothing left to catch a
// mis-click (plan 47-02 decision I / AC-8).
//
// The DELETE is consumed through the frozen 47-01 wrapper `purgeBenchRun`; do not
// hand-roll a fetch here (src/lib/api/bench-client.ts is a DO-NOT-CHANGE boundary).

import { useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { purgeBenchRun } from '@/src/lib/api/bench-client';
import type { BenchRunRow, BenchRunStatus } from '@/src/lib/db/schema';

// AC-12 / decision N: operator kill-switch. Module-load constant, read BEFORE any
// hook or state, so flipping it needs a container restart (NEXT_PUBLIC_* is
// build/start-baked). Escape hatch for a "it deleted the wrong run" report without
// reverting the commit and rebuilding the image.
const KILL = process.env.NEXT_PUBLIC_BENCH_DELETE_DISABLED === '1';

// AC-2 / decision G2: mirrors library/delete-action.tsx ACTIVE_STATES. The backend
// guard stays authoritative — this only governs affordance visibility. `active_pass2`
// is NOT client-gateable (the row carries no pass-2 state), so the 409 toast path in
// handleConfirm is required regardless.
const ACTIVE_STATUSES: ReadonlySet<BenchRunStatus> = new Set<BenchRunStatus>([
  'pending',
  'running',
]);

// AC-3b: the 47-01 wrappers take no AbortSignal and bench-client.ts is a boundary, so
// the only available timeout is a Promise.race in the component. Consequence, recorded
// deliberately: the in-flight DELETE is NOT aborted and may still land server-side. That
// is acceptable because the purge is terminal — an operator retry then answers
// 404 run_not_found → the "already gone, list is stale" toast, which is truthful.
const PURGE_TIMEOUT_MS = 15_000;

const TIMED_OUT = Symbol('purge-timeout');

// Duplicated verbatim in bench-bulk-actions.tsx: extracting it would mean a new shared
// module outside this plan's file set for ~12 lines. Keep the two copies in sync.
async function withPurgeTimeout<T>(p: Promise<T>): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), PURGE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface BenchRunDeleteActionProps {
  run: BenchRunRow;
  // Array form so the row action and the bulk action share ONE parent handler
  // (bench-history-table handleDeleted(ids: number[])).
  onDeleted: (runIds: number[]) => void;
}

export function BenchRunDeleteAction({ run, onDeleted }: BenchRunDeleteActionProps) {
  const t = useTranslations('bench.history.delete');
  const router = useRouter();
  // Defence in depth against a double-fire between arm and the request landing
  // (library precedent, 04-03 S2). Released in `finally` — which is exactly why the
  // timeout above matters: without it a hung request would hold the lock forever.
  const submitLockRef = useRef(false);

  const handleConfirm = useCallback(async (): Promise<void> => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    try {
      // AC-3 / audit M5: purgeBenchRun has NO internal try/catch — a network failure
      // rejects, and a non-JSON body (502 HTML from a proxy) makes res.json() throw.
      const res = await withPurgeTimeout(purgeBenchRun(run.id));
      if (res === TIMED_OUT) {
        toast.error(t('toast.error'));
        return;
      }
      if ('error' in res) {
        if (res.error === 'delete_rejected_active_run') {
          toast.error(t('toast.activeRun'));
        } else if (res.error === 'delete_rejected_active_pass2') {
          toast.error(t('toast.activePass2'));
        } else if (res.error === 'run_not_found') {
          toast.error(t('toast.notFound'));
        } else {
          toast.error(t('toast.error'));
        }
        // AC-3: the row stays in the table on EVERY rejection — no onDeleted call.
        return;
      }
      toast.success(t('toast.success', { id: run.id, count: res.combosDeleted }));
      onDeleted([run.id]);
      router.refresh();
    } catch {
      toast.error(t('toast.error'));
    } finally {
      submitLockRef.current = false;
    }
  }, [onDeleted, router, run.id, t]);

  if (KILL) return null;
  if (ACTIVE_STATUSES.has(run.status)) return null;

  // Decision M: the run identity rides in `label` — ConfirmButtonProps exposes no
  // aria-label passthrough and ConfirmButtonP3 sets aria-label itself, cycling
  // label → armed → cooldown copy. `label` is simultaneously the visible text, so one
  // key serves both the visible and the accessible name (AC-11, idle state).
  //
  // No local state by design: this component is unmounted by its own success path
  // (the parent drops the row), so a post-await setState here would warn on an
  // unmounted tree.
  return (
    <ConfirmButton
      variant="P3"
      size="sm"
      onConfirm={handleConfirm}
      label={t('label', { id: run.id })}
      className="shrink-0"
    >
      <Trash2 className="size-3.5" aria-hidden="true" />
    </ConfirmButton>
  );
}
