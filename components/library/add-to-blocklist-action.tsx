'use client';

// 04-02 → 13-01b T1: Library Add-to-Blocklist migrated to ConfirmButton P1
// (1-click + plain success-toast). No popover, no countdown, no undo —
// blocklist insertion is a small reversible toggle handled via the Blocklist
// page; P1 fits the action.

import { useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Ban } from 'lucide-react';
import { ConfirmButton } from '@/components/ui/confirm-button';
import type { FileRow, FileStatus } from '@/src/lib/db/schema';

// 04-02 audit M4: ELIGIBLE_STATES tightened — 'queued' EXCLUDED (active job
// mid-flight; operator should cancel job first via existing 02-04 cancel UX).
// 'encoding', 'done-smaller', 'blocklisted' also excluded.
export const ELIGIBLE_STATES: ReadonlySet<FileStatus> = new Set<FileStatus>([
  'pending',
  'failed',
  'done-larger',
  'skipped-codec',
  'skipped-bitrate',
  'skipped-suffix',
  'skipped-tag',
  'skipped-sidecar',
  'interrupted',
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

export function AddToBlocklistAction({ file }: { file: FileRow }) {
  const t = useTranslations('blocklist');
  const router = useRouter();
  // 13-01b: submitLockRef defense-in-depth carry-forward from 04-02 audit.
  const submitLockRef = useRef(false);

  const handleConfirm = useCallback(async (): Promise<void> => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    try {
      const res = await fetchWithTimeout(`/api/library/${file.id}/blocklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'file' }),
      });
      if (!res.ok) {
        toast.error(t('error.addFailed'));
        return;
      }
      toast.success(t('added.toast'));
      router.refresh();
    } catch {
      toast.error(t('error.addFailed'));
    } finally {
      submitLockRef.current = false;
    }
  }, [file.id, router, t]);

  if (!ELIGIBLE_STATES.has(file.status)) return null;

  return (
    <ConfirmButton
      variant="P1"
      onConfirm={handleConfirm}
      label={t('actions.addToBlocklist')}
      className="shrink-0"
    >
      <Ban className="size-3.5" aria-hidden="true" />
    </ConfirmButton>
  );
}
