'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Trash, AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

// 04-02: 2-step Cancel-style confirm pattern (mirrors 02-04 ActiveSlotCard).
// Click 1 → confirm-button visible 3s. Click 2 (within window) → DELETE fires.
// audit M6 carry-forward: AbortController(10s) on fetch.
//
// ui-ux-pro-max review (Plan 04-02):
//   A1 Esc cancels confirm window immediately + restores focus to trigger
//   A2 aria-live region announces confirm-state entry to screen readers
//   B1 min-h-[44px] touch target on mobile
//   C2 AlertTriangle icon in confirm state (color-not-only — icon distinguishes)
//   D5 motion-safe fade-in honors prefers-reduced-motion

const CONFIRM_WINDOW_MS = 3_000;
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

export function RemoveEntryButton({
  entryId,
  onRemoved,
}: {
  entryId: number;
  onRemoved: () => void;
}) {
  const t = useTranslations('blocklist');
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // ui-ux-pro-max A1: Esc cancels confirm window + restores focus to trigger.
  useEffect(() => {
    if (!confirming) return;
    const timeout = setTimeout(() => setConfirming(false), CONFIRM_WINDOW_MS);
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        setConfirming(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => {
      clearTimeout(timeout);
      document.removeEventListener('keydown', handleKey);
    };
  }, [confirming]);

  async function handleConfirm() {
    setSubmitting(true);
    try {
      const res = await fetchWithTimeout(`/api/library/${entryId}/blocklist`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        // 404+idempotent treated as success; other errors are real
        toast.error(t('error.removeFailed'));
        return;
      }
      // 200 OR 404+idempotent → success path
      toast.success(t('removed.toast'));
      onRemoved();
    } catch {
      toast.error(t('error.removeFailed'));
    } finally {
      setSubmitting(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <Button
        type="button"
        size="sm"
        variant="destructive"
        onClick={handleConfirm}
        disabled={submitting}
        aria-label={t('confirm.remove')}
        aria-live="polite"
        autoFocus
        className="min-h-[44px] motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150 md:min-h-0"
      >
        {submitting ? (
          <Loader2 className="mr-1 size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <AlertTriangle className="mr-1 size-3.5" aria-hidden="true" />
        )}
        {t('confirm.remove')}
      </Button>
    );
  }

  return (
    <Button
      ref={triggerRef}
      type="button"
      size="sm"
      variant="outline"
      onClick={() => setConfirming(true)}
      aria-label={t('actions.remove')}
      className="min-h-[44px] md:min-h-0"
    >
      <Trash className="mr-1 size-3.5" aria-hidden="true" />
      {t('actions.remove')}
    </Button>
  );
}
