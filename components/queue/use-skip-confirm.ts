'use client';

// Skip-confirm hook, a fire-callback helper.
// The 2-step countdown state-machine is owned by ConfirmButton P2
// (components/ui/confirm-button.tsx). This hook just provides a shared POST +
// toast-success/error + 2-second SSE-fallback `router.refresh()`
// inside the fire-callback that ConfirmButton P2 schedules through
// useDeferredAction.
//
// Fallback: after POST 200, start a 2-second timer. If no SSE
// `job.cancelled` lands within 2s, force-invalidate router cache → triggers
// fresh data on next paint. Defends dropped-SSE stale UI.

import { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

const FALLBACK_REFRESH_MS = 2_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface UseSkipConfirmOptions {
  /** Path to POST against. Library row uses /api/library/{id}/skip; Queue row uses /api/queue/{jobId}/skip. */
  endpoint: string;
  /** Toast shown on success. */
  successToast: string;
  /** Toast shown on non-200 / network failure. */
  errorToast: string;
  /** Optional callback fired AFTER successful POST + before fallback timer. */
  onSuccess?: () => void;
}

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

export function useSkipConfirm(opts: UseSkipConfirmOptions): {
  fire: () => Promise<void>;
} {
  const router = useRouter();
  // submitLockRef: synchronous defense-in-depth guard against a double submit.
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
      const res = await fetchWithTimeout(opts.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (res.ok) {
        toast.success(opts.successToast);
        opts.onSuccess?.();
        // 2-second SSE fallback.
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
