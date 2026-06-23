'use client';

// Phase 21 Plan 21-02 — RefreshButton for /diagnostics.
//
// Manual-only re-fetch per OQ3 (no polling/SSE/auto-refresh). submitLockRef
// synchronous guard per [[feedback-confirm-patterns]] P1.
// audit-SR3+SR4: AbortController + 10s timeout + unmount cleanup.
// audit-SR5: prefers-reduced-motion → text-only "Loading..." label.

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { DiagnosticsPayload } from '@/src/lib/diagnostics/types';
import { usePrefersReducedMotion } from './use-prefers-reduced-motion';

const REFRESH_TIMEOUT_MS = 10_000;

export function RefreshButton({ onPayload }: { onPayload: (payload: DiagnosticsPayload) => void }) {
  const t = useTranslations('diagnostics');
  const [loading, setLoading] = useState(false);
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
    const timeout = setTimeout(() => ac.abort(), REFRESH_TIMEOUT_MS);

    try {
      const res = await fetch('/api/diagnostics', { cache: 'no-store', signal: ac.signal });
      if (!res.ok) {
        toast.error(t('refreshError', { status: res.status }));
        return;
      }
      const payload = (await res.json()) as DiagnosticsPayload;
      onPayload(payload);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        if (ac.signal.aborted && !abortRef.current) return;
        toast.error(t('refreshTimeout'));
      } else {
        toast.error(t('refreshError', { status: 'network' }));
      }
    } finally {
      clearTimeout(timeout);
      setLoading(false);
      submitLockRef.current = false;
    }
  };

  const Icon = loading && !reduceMotion ? Loader2 : RefreshCw;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={loading}
      aria-busy={loading || undefined}
      className="min-h-[44px] gap-2"
    >
      <Icon
        className={`size-4 ${loading && !reduceMotion ? 'animate-spin' : ''}`}
        aria-hidden="true"
      />
      <span>{loading ? t('loading') : t('refresh')}</span>
    </Button>
  );
}
