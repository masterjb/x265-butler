'use client';

// 04-03 → 13-01b T1: Library Retry migrated to ConfirmButton P2 (10s undo-toast).
// 13-01b S1 design-pass: P2 variant + RotateCcw idle icon + undo-toast body i18n
// leaf `library.retry.undo.toastBody`. submitLockRef defense-in-depth preserved.

import { useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { RotateCcw } from 'lucide-react';
import { ConfirmButton } from '@/components/ui/confirm-button';
import type { FileRow, FileStatus } from '@/src/lib/db/schema';

// 04-03 ELIGIBLE_STATES — UI-side mirror of the backend retry route
// (app/api/library/[id]/retry/route.ts). Server is authoritative; this set
// only governs button visibility.
export const ELIGIBLE_STATES: ReadonlySet<FileStatus> = new Set<FileStatus>([
  'failed',
  'interrupted',
  'done-larger',
]);

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

export function LibraryRetryAction({ file }: { file: FileRow }) {
  const t = useTranslations('library.retry');
  const router = useRouter();
  // 13-01b: submitLockRef defense-in-depth carry-forward from 04-03 audit S2.
  const submitLockRef = useRef(false);

  const handleConfirm = useCallback(async (): Promise<void> => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    try {
      const res = await fetchWithTimeout(`/api/library/${file.id}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) {
        toast.success(t('toast.success'));
        router.refresh();
        return;
      }
      if (res.status === 409) {
        // 'not_eligible' OR 'state_changed' — same UX (file in wrong state).
        toast.error(t('toast.notEligible'));
        return;
      }
      toast.error(t('toast.error'));
    } catch {
      toast.error(t('toast.error'));
    } finally {
      submitLockRef.current = false;
    }
  }, [file.id, router, t]);

  if (!ELIGIBLE_STATES.has(file.status)) return null;

  const filename = basename(file.path);

  return (
    <ConfirmButton
      variant="P2"
      onConfirm={handleConfirm}
      label={t('actions.retry')}
      successToastMessage={t('undo.toastBody', { filename })}
      className="shrink-0"
    >
      <RotateCcw className="size-3.5" aria-hidden="true" />
    </ConfirmButton>
  );
}
