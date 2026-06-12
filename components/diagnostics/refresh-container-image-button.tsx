'use client';

// 22-00 IMP-11 T0-decision D1 α: dedicated refresh-button for the
// container-image probe. Calls /api/diagnostics?refresh=1 which clears the
// boot-cached singleton, re-probes, and returns the fresh full payload.
// On HTTP 429 (audit-fix:SR2 rate-limit), toasts the i18n message silently.
//
// Pattern mirrors components/diagnostics/refresh-button.tsx — same Button
// shape, same AbortController + 10s timeout + unmount cleanup, same
// prefers-reduced-motion gate on the spinner.

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { DiagnosticsPayload } from '@/src/lib/diagnostics/types';
import { usePrefersReducedMotion } from './use-prefers-reduced-motion';

const REFRESH_TIMEOUT_MS = 10_000;

export function RefreshContainerImageButton({
  onPayload,
}: {
  onPayload: (payload: DiagnosticsPayload) => void;
}) {
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
      const res = await fetch('/api/diagnostics?refresh=1', {
        cache: 'no-store',
        signal: ac.signal,
      });
      if (res.status === 429) {
        toast.error(t('containerImage.refreshRateLimited'));
        return;
      }
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
      className="min-h-[36px] gap-2"
    >
      <Icon
        className={`size-3 ${loading && !reduceMotion ? 'animate-spin' : ''}`}
        aria-hidden="true"
      />
      <span>{loading ? t('loading') : t('containerImage.refreshLabel')}</span>
    </Button>
  );
}
