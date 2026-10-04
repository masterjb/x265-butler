'use client';

// 32-02: queue pause/resume control. Pause-after-current — pausing stops NEW
// dispatch in the orchestrator while the running encode finishes; resuming restarts
// dispatch immediately. Reversible (P0) → NO ConfirmButton, direct onClick.
//
// SSE-authoritative: the button label is driven by usePausedState() (the live
// queue.updated.paused slice), NOT local optimistic state. The POST flips the
// in-memory flag server-side; the resulting queue.updated event flips the hook.
// An in-flight ref lock guards against double-submit while the POST is pending.

import { useRef } from 'react';
import { Pause, Play } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { usePausedState } from '@/src/lib/api/engine-events-client';

export function PauseToggleButton() {
  const t = useTranslations('queue.pause');
  const paused = usePausedState();
  const inFlight = useRef(false);

  async function handleClick() {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const endpoint = paused ? '/api/queue/resume' : '/api/queue/pause';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        toast.error(t('toast.error'));
      }
      // On success: do nothing — the SSE queue.updated reducer flips usePausedState
      // authoritatively (no optimistic local state to reconcile).
    } catch {
      toast.error(t('toast.error'));
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void handleClick()}
      aria-label={t('aria')}
      className="min-h-[44px] shrink-0 md:min-h-0"
    >
      {paused ? (
        <Play className="size-4" aria-hidden="true" />
      ) : (
        <Pause className="size-4" aria-hidden="true" />
      )}
      <span className="ml-1.5">{paused ? t('resume') : t('button')}</span>
    </Button>
  );
}
