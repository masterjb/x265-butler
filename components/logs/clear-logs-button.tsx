'use client';

// 24-05 F7 T3: operator "Clear log" action in the container-log toolbar.
// Modeled on components/library/delete-action.tsx (submitLockRef +
// fetchWithTimeout) but uses ConfirmButton variant="P3" (arm→confirm, NO undo):
// clearing the in-memory ring is a one-way door (audit-M2), so P1's instant
// no-confirm click and P2's undo-toast would both misrepresent the action.
//
// The DELETE wipes the SHARED ring buffer — the same store feeding the
// Diagnostics recent-errors / slow-requests / slow-queries surfaces. That
// side-effect is surfaced in helper text (t('clear.warning')), not hidden.

import { useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { ConfirmButton } from '@/components/ui/confirm-button';

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

export function ClearLogsButton({ onCleared }: { onCleared: () => void }) {
  const t = useTranslations('logs');
  // submitLockRef defense-in-depth carry-forward from delete-action (24-04).
  const submitLockRef = useRef(false);

  const handleConfirm = useCallback(async (): Promise<void> => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    try {
      const res = await fetchWithTimeout('/api/logs', { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('clear.success'));
        onCleared();
        return;
      }
      toast.error(t('clear.error'));
    } catch {
      toast.error(t('clear.error'));
    } finally {
      submitLockRef.current = false;
    }
  }, [onCleared, t]);

  return (
    <div className="flex items-center gap-2">
      <ConfirmButton variant="P3" size="sm" onConfirm={handleConfirm} label={t('clear.label')}>
        <Trash2 className="size-3.5" aria-hidden="true" />
      </ConfirmButton>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
        {t('clear.warning')}
      </span>
    </div>
  );
}
