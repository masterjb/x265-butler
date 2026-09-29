'use client';

// 50-04: the other half of AddToBlocklistAction. That button hides itself for
// `blocklisted` rows (its ELIGIBLE_STATES does not contain the status), so this
// one takes the freed slot — Ban ⇄ Undo2 in the same place is the toggle.
//
// WHY A BUTTON AND NOT A CLICKABLE CHIP (deviation from the ROADMAP wording
// "StatusChip blocklisted wird klickbar"): a chip is `px-2 py-0.5 text-xs` ≈
// 20px tall and would break Constraint Z.103 (≥44px touch target), which
// Phase 27 lifted the row actions from h-7 to h-11 to satisfy. ConfirmButton's
// default size 'md' is h-11. The chip stays a pure display element.
//
// Tier P2 (10s undo-toast) per feedback_confirm_patterns: removing a blocklist
// entry is reversible — AddToBlocklistAction reappears in this very slot — so
// the one-way-door P3 cooldown would be theatre, and P1's fire-immediately
// would be too eager for an operator-set state.
//
// ⚠ INHERITED P2 PROPERTY (M-6, not introduced here): useDeferredAction clears
// its timer in the unmount cleanup and does NOT fire. If this component
// unmounts inside the 10s window — closing the detail panel, changing filter or
// page, navigating away — the request is dropped SILENTLY. Hiding the tab fires
// it immediately instead (fireOnHidden). router.refresh() does not unmount.
// LibraryDeleteAction has carried the same property in the same panel since
// 24-04; a fix belongs in ConfirmButton, where it would reach every P2 caller.

import { useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Undo2 } from 'lucide-react';
import { ConfirmButton } from '@/components/ui/confirm-button';
import type { FileRow } from '@/src/lib/db/schema';

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

export function RemoveFromBlocklistAction({ file, entryId }: { file: FileRow; entryId?: number }) {
  const t = useTranslations('library.unblocklist');
  const router = useRouter();
  // submitLockRef defense-in-depth, carried forward from delete-action (24-04).
  const submitLockRef = useRef(false);

  const handleConfirm = useCallback(async (): Promise<void> => {
    if (entryId === undefined) return;
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    try {
      // The ENTRY id goes in the path, the FILE id in the query — not the other
      // way round. `:id` means blocklist_entry.id on DELETE and file.id on POST,
      // and the two AUTOINCREMENT spaces collide from the first row, so a
      // swapped pair would delete a stranger's entry. expectFileId makes the
      // server reject that with 409 instead of acting on it.
      const res = await fetchWithTimeout(
        `/api/library/${entryId}/blocklist?expectFileId=${file.id}`,
        { method: 'DELETE' },
      );
      // 404 means the entry is already gone — the outcome the operator asked
      // for. Mirrors components/blocklist/remove-entry-button.tsx.
      if (res.ok || res.status === 404) {
        toast.success(t('toast.success'));
        router.refresh();
        return;
      }
      toast.error(t('toast.error'));
    } catch {
      toast.error(t('toast.error'));
    } finally {
      submitLockRef.current = false;
    }
  }, [entryId, file.id, router, t]);

  // Both conditions, not one: the map has no key for a row blocked by a pattern
  // (there is no single entry to remove), and an entry can outlive the
  // `blocklisted` status — the route deliberately preserves a status it did not
  // set (status_preserve_on_unblocklist).
  if (file.status !== 'blocklisted' || entryId === undefined) return null;

  return (
    <ConfirmButton
      variant="P2"
      onConfirm={handleConfirm}
      label={t('button')}
      successToastMessage={t('undo.toastBody')}
      className="shrink-0"
    >
      <Undo2 className="size-3.5" aria-hidden="true" />
    </ConfirmButton>
  );
}
