'use client';

// Phase 21 Plan 21-02 — EncoderReplayRunner: POST /api/encoders/refresh.
//
// Compares BEFORE (initialPayload.encoders.detected + activeFromAuto) vs AFTER
// (refresh response) and renders a unified diff with +/- prefixes per
// /ui-ux-pro-max T0 D4=α. POSTs FLAT log-event payload (audit-M4 canonical
// shape: {added, removed, activeFromAutoChanged}).
// audit-M6: defensive nullish-coalescing on detected arrays.
// audit-SR3+SR4: AbortController + 15s timeout + unmount cleanup.
// audit-SR5: prefers-reduced-motion → text "Loading...".

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, RotateCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { DiagnosticsPayload } from '@/src/lib/diagnostics/types';
import { usePrefersReducedMotion } from './use-prefers-reduced-motion';

const REPLAY_TIMEOUT_MS = 15_000;

interface RefreshResponse {
  refreshed: boolean;
  detected?: string[];
  active?: string;
  resolution?: 'auto' | 'override' | 'fallback';
  requestedButUnavailable?: string;
}

interface DiffResult {
  added: string[];
  removed: string[];
  activeFromAutoChanged: boolean;
  beforeActive: string;
  afterActive: string;
}

function computeDiff(payload: DiagnosticsPayload, after: RefreshResponse): DiffResult {
  const beforeDetected = payload.encoders?.detected ?? [];
  const afterDetected = after.detected ?? [];
  const beforeActive = payload.encoders?.detected[0] ?? '';
  const afterActive = after.active ?? '';

  const beforeSet = new Set(beforeDetected);
  const afterSet = new Set(afterDetected);
  const added = afterDetected.filter((e) => !beforeSet.has(e));
  const removed = beforeDetected.filter((e) => !afterSet.has(e));
  const activeFromAutoChanged = beforeActive !== afterActive;

  return { added, removed, activeFromAutoChanged, beforeActive, afterActive };
}

async function postLogEvent(payload: {
  added: string[];
  removed: string[];
  activeFromAutoChanged: boolean;
}): Promise<void> {
  try {
    await fetch('/api/diagnostics/log-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'encoderReplayTriggered', payload }),
      keepalive: true,
    });
  } catch {
    // Best-effort; never block UX on audit-trail failure.
  }
}

export function EncoderReplayRunner({
  initialPayload,
  onPayload,
}: {
  initialPayload: DiagnosticsPayload;
  onPayload: (payload: DiagnosticsPayload) => void;
}) {
  const t = useTranslations('diagnostics');
  const [loading, setLoading] = useState(false);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const submitLockRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const reduceMotion = usePrefersReducedMotion();

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleClick = async () => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setLoading(true);

    const ac = new AbortController();
    abortRef.current = ac;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, REPLAY_TIMEOUT_MS);

    try {
      const res = await fetch('/api/encoders/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
      });
      if (!res.ok) {
        toast.error(`HTTP ${res.status}`);
        return;
      }
      const after = (await res.json()) as RefreshResponse;
      const d = computeDiff(initialPayload, after);
      const hasChange = d.added.length > 0 || d.removed.length > 0 || d.activeFromAutoChanged;

      void postLogEvent({
        added: d.added,
        removed: d.removed,
        activeFromAutoChanged: d.activeFromAutoChanged,
      });

      if (!hasChange) {
        setDiff(null);
        toast.success(t('encoderReplay.toastUnchanged'), { duration: 3000 });
        return;
      }

      setDiff(d);

      // Refresh page-level payload from /api/diagnostics so other sections
      // reflect the new encoder state.
      try {
        const refreshRes = await fetch('/api/diagnostics', { cache: 'no-store' });
        if (refreshRes.ok) {
          const next = (await refreshRes.json()) as DiagnosticsPayload;
          onPayload(next);
        }
      } catch {
        // ignore — diff still displays
      }
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        if (timedOut) toast.error(t('encoderReplay.toastTimeout'));
      } else {
        toast.error('network');
      }
    } finally {
      clearTimeout(timeout);
      setLoading(false);
      submitLockRef.current = false;
    }
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleClick}
        disabled={loading}
        aria-busy={loading || undefined}
        className="min-h-[44px] gap-2"
      >
        {loading && !reduceMotion ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <RotateCw className="size-4" aria-hidden="true" />
        )}
        <span>{loading ? t('loading') : t('encoderReplay.button')}</span>
      </Button>
      {diff && (
        <div className="w-full rounded border bg-muted/50 p-2 text-xs">
          <h4 className="mb-1 font-medium">{t('encoderReplay.diffTitle')}</h4>
          <ul className="space-y-0.5 font-mono">
            {diff.added.map((e) => (
              <li key={`+${e}`} className="text-green-600 dark:text-green-400">
                <span aria-label={t('encoderReplay.added')}>+</span> {e}
              </li>
            ))}
            {diff.removed.map((e) => (
              <li key={`-${e}`} className="text-red-600 dark:text-red-400">
                <span aria-label={t('encoderReplay.removed')}>-</span> {e}
              </li>
            ))}
            {diff.activeFromAutoChanged && (
              <li className="text-amber-700 dark:text-amber-300">
                <span aria-label={t('encoderReplay.changed')}>~</span> active:{' '}
                {diff.beforeActive || '—'} → {diff.afterActive || '—'}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
