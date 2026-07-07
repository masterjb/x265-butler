'use client';

// 24-04 F6 T2: Library row-only "forget" delete. Modeled 1:1 on retry-action.tsx
// (ConfirmButton P2 10s undo-toast, submitLockRef defense-in-depth,
// fetchWithTimeout). Trash2 icon signals destructive intent. The DELETE removes
// only the DB row — the physical file is never touched (server is authoritative;
// this set only governs button visibility).

import { useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import { ConfirmButton } from '@/components/ui/confirm-button';
import type { FileRow, FileStatus } from '@/src/lib/db/schema';

// D4: eligible for ALL statuses EXCEPT the two active ones. Mirrors the
// backend guard (app/api/library/[id]/route.ts DELETE) + AC-6 visibility gate.
const ACTIVE_STATES: ReadonlySet<FileStatus> = new Set<FileStatus>(['queued', 'encoding']);

const FETCH_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

export function LibraryDeleteAction({ file }: { file: FileRow }) {
  const t = useTranslations('library.delete');
  const router = useRouter();
  // submitLockRef defense-in-depth carry-forward from retry-action (04-03 S2).
  const submitLockRef = useRef(false);

  const handleConfirm = useCallback(async (): Promise<void> => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    try {
      const res = await fetchWithTimeout(`/api/library/${file.id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('toast.success'));
        router.refresh();
        return;
      }
      if (res.status === 409) {
        // Branch on the server error code so the operator learns WHY.
        let code: string | undefined;
        try {
          code = ((await res.json()) as { error?: string }).error;
        } catch {
          // body parse failed — fall through to generic error toast.
        }
        if (code === 'delete_rejected_active_job') {
          toast.error(t('toast.activeJob'));
          return;
        }
        if (code === 'delete_blocked_bench_reference') {
          toast.error(t('toast.benchRef'));
          return;
        }
        toast.error(t('toast.error'));
        return;
      }
      toast.error(t('toast.error'));
    } catch {
      toast.error(t('toast.error'));
    } finally {
      submitLockRef.current = false;
    }
  }, [file.id, router, t]);

  if (ACTIVE_STATES.has(file.status)) return null;

  const filename = basename(file.path);

  return (
    <ConfirmButton
      variant="P2"
      onConfirm={handleConfirm}
      label={t('actions.delete')}
      successToastMessage={t('undo.toastBody', { filename })}
      className="shrink-0"
    >
      <Trash2 className="size-3.5" aria-hidden="true" />
    </ConfirmButton>
  );
}
