'use client';

// 47-02 T2 — bench-run bulk purge, supplied as a SelectionBar child.
//
// Modeled on components/library/library-bulk-actions.tsx but DELIBERATELY
// self-contained (plan 47-02 decision J): the 3-path toast formatter below duplicates
// Library's private formatFailedDetail/toastResult rather than extracting them.
// Extracting would refactor a stable Library surface — and put its own bulk tests at
// risk — for ~30 lines of reuse and zero operator-visible gain. The duplication is a
// recorded trade, not an oversight; keep the two copies independent.
//
// P3, NOT P2: the purge is irreversible and bench_run has no trash tier (47-01 D1).

import { useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { bulkDeleteBenchRuns } from '@/src/lib/api/bench-client';

// AC-12 / decision N: same module-load kill-switch as the row action. Restart required.
const KILL = process.env.NEXT_PUBLIC_BENCH_DELETE_DISABLED === '1';

// AC-3b — same contract as bench-run-delete-action.tsx: bulkDeleteBenchRuns takes no
// AbortSignal and bench-client.ts is a DO-NOT-CHANGE boundary, so the only timeout
// available is a Promise.race here. The in-flight POST is NOT aborted and may still
// land server-side; a retry then reports the already-purged ids as `not_found`, which
// is truthful. Duplicated verbatim from bench-run-delete-action.tsx — keep in sync.
const PURGE_TIMEOUT_MS = 15_000;

const TIMED_OUT = Symbol('bulk-purge-timeout');

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

type FailedEntry = { id: number; reason: string };
type Translator = (key: string, values?: Record<string, string | number>) => string;

// Renders as JSX (one <div> per line): sonner collapses '\n' inside a string
// description onto one line and would hide the per-id detail.
function formatFailedDetail(failed: FailedEntry[], t: Translator): React.ReactNode {
  // Reason lookup goes through the GLOBAL bulk.failed.* namespace (decision K). The
  // route's closed union is not_found | active_run | active_pass2 | internal_error
  // (app/api/bench/bulk-delete/route.ts:45) — all four have copy, so no reason can
  // reach t() unmapped.
  const lines = failed.slice(0, 3).map((f) => `#${f.id}: ${t(`bulk.failed.${f.reason}`)}`);
  if (failed.length > 3) {
    lines.push(t('bulk.failed.more', { count: failed.length - 3 }));
  }
  return (
    <div className="flex flex-col gap-0.5">
      {lines.map((line, i) => (
        <span key={i}>{line}</span>
      ))}
    </div>
  );
}

export interface BenchBulkActionsProps {
  ids: number[];
  onDeleted: (deletedIds: number[]) => void;
  onAfter: () => void;
}

export function BenchBulkActions({ ids, onDeleted, onAfter }: BenchBulkActionsProps) {
  const t = useTranslations() as unknown as Translator;
  const router = useRouter();
  // audit SR3: P3 resets to idle ~200ms after firing (confirm-button.tsx:192-204), so
  // without this guard an operator can arm a second 500-id purge while the first still
  // holds the SQLite write lock. Library omits it on its bulk path; that is not a
  // reason to repeat the omission on an irreversible purge.
  const submitLockRef = useRef(false);

  const handleConfirm = useCallback(async (): Promise<void> => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    try {
      const res = await withPurgeTimeout(bulkDeleteBenchRuns(ids));
      if (res === TIMED_OUT) {
        toast.error(t('bench.bulk.delete.network_error'));
        return; // SR5: selection preserved.
      }
      if ('error' in res) {
        // Envelope-level failure (415/400/500) — NOT a per-id rejection; those only
        // ever arrive in `failed`. Selection preserved (AC-6).
        toast.error(t('bench.bulk.delete.network_error'));
        return;
      }

      const { successCount, failed } = res;
      // The envelope reports FAILURES, not successes, so the success set is computed.
      const failedIds = new Set(failed.map((f) => f.id));
      const deletedIds = ids.filter((id) => !failedIds.has(id));

      if (failed.length === 0) {
        toast.success(t('bench.bulk.delete.success', { count: successCount }));
      } else if (successCount === 0) {
        toast.error(t('bench.bulk.delete.all_failed', { count: failed.length }), {
          description: formatFailedDetail(failed, t),
        });
      } else {
        toast(t('bench.bulk.delete.partial', { ok: successCount, fail: failed.length }), {
          description: formatFailedDetail(failed, t),
        });
      }

      // SR5 parity with Library: clear + refresh ONLY on at-least-some-success. The
      // ENTIRE selection is cleared then, including the failed ids.
      if (successCount > 0) {
        onDeleted(deletedIds);
        onAfter();
        router.refresh();
      }
    } catch {
      toast.error(t('bench.bulk.delete.network_error'));
      // SR5: preserve selection on throw.
    } finally {
      submitLockRef.current = false;
    }
  }, [ids, onAfter, onDeleted, router, t]);

  if (KILL) return null;

  // Disabled only at zero. There is no above-cap branch: toggleSelect hard-caps the
  // selection at MAX_SELECT (500) === the route's MAX_BULK, so ids.length > 500 is
  // unreachable from the UI (decision L / audit M3).
  return (
    <ConfirmButton
      variant="P3"
      size="md"
      onConfirm={handleConfirm}
      label={t('bench.bulk.delete.label', { count: ids.length })}
      disabled={ids.length === 0}
    >
      <Trash2 className="size-4" aria-hidden="true" />
    </ConfirmButton>
  );
}
