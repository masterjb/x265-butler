'use client';

// 05-09 → 13-01b T3: Cancel-All confirm hook reduced to fire-callback helper.
// AlertDialog Modal + open/setOpen state + synchronous /api/queue/status
// refetch (audit S7) are GONE: ConfirmButton P2's click handler fires
// showUndoToast + schedule synchronously (audit M5), so an async pre-toast
// refetch is API-impossible without extending P2. The consumer instead reads
// SSE-fresh `useQueueCounts()` (≤2s stale per SSE refresh interval — accepted
// trade-off documented at AC-5).
//
// Preserved: Audit S4 2-second SSE-fallback `router.refresh()` after success.
// Preserved: submitLockRef defense-in-depth.

import { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

const FETCH_TIMEOUT_MS = 10_000;
const FALLBACK_REFRESH_MS = 2_000;

export interface UseCancelAllConfirmOptions {
  successToast: (counts: { skipped: number; cancelled: number }) => string;
  errorToast: string;
  onSuccess?: () => void;
}

async function fetchWithTimeout(input: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

export function useCancelAllConfirm(opts: UseCancelAllConfirmOptions): {
  fire: () => Promise<void>;
} {
  const router = useRouter();
  const submitLockRef = useRef(false);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
    };
  }, []);

  const fire = useCallback(async () => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    try {
      const res = await fetchWithTimeout('/api/queue/cancel-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (res.ok) {
        const data = (await res.json()) as { skipped: number; cancelled: number };
        toast.success(opts.successToast({ skipped: data.skipped, cancelled: data.cancelled }));
        opts.onSuccess?.();
        if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = setTimeout(() => {
          router.refresh();
        }, FALLBACK_REFRESH_MS);
      } else {
        toast.error(opts.errorToast);
      }
    } catch {
      toast.error(opts.errorToast);
    } finally {
      submitLockRef.current = false;
    }
  }, [opts, router]);

  return { fire };
}
