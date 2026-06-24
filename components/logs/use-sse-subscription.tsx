'use client';

// 05-03 T2.A: shared 401-aware SSE subscription hook (audit S9 closure).
// Phase 5 Plan 05-03 (Logs Viewer) — AC-8.
//
// Used by:
//   - src/lib/api/engine-events-client.tsx (02-04 EngineEventsProvider — retrofit)
//   - components/logs/log-viewer.tsx (NEW SSE consumer)
//
// Behavior:
//   - opens EventSource(url) when enabled=true; closes on unmount or enabled→false
//   - on 'error': probes fetch(url, HEAD) — if 401 + auth_required → markLogoutClicked + redirect ONCE
//   - other errors: exponential-backoff reconnect (1s..30s, jitter); never redirect
//   - module-scoped redirected flag — never redirect twice in one session

import { useCallback, useEffect, useRef, useState } from 'react';
import { markLogoutClicked } from '@/components/auth/auth-fetcher';

export type SseConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface UseSseSubscriptionOptions<T = unknown> {
  url: string;
  enabled?: boolean;
  withCredentials?: boolean;
  onOpen?: (event: Event) => void;
  onMessage?: (data: T, event: MessageEvent<string>) => void;
  onError?: (event: Event) => void;
  /** Optional fetch implementation for tests */
  fetchImpl?: typeof fetch;
}

export interface UseSseSubscriptionResult {
  connectionState: SseConnectionState;
  /** Manually close the stream (forwarded as enabled=false). */
  close: () => void;
}

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

let moduleScopedRedirected = false;

/** Test-only: reset module-scoped redirect flag. */
export function __resetForTesting(): void {
  moduleScopedRedirected = false;
}

export function useSseSubscription<T = unknown>(
  options: UseSseSubscriptionOptions<T>,
): UseSseSubscriptionResult {
  const {
    url,
    enabled = true,
    withCredentials = true,
    onOpen,
    onMessage,
    onError,
    fetchImpl,
  } = options;

  const [connectionState, setConnectionState] = useState<SseConnectionState>('idle');
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef<number>(INITIAL_BACKOFF_MS);
  const closedRef = useRef<boolean>(false);

  const onOpenRef = useRef(onOpen);
  const onMessageRef = useRef(onMessage);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onOpenRef.current = onOpen;
    onMessageRef.current = onMessage;
    onErrorRef.current = onError;
  }, [onOpen, onMessage, onError]);

  const cleanup = useCallback(() => {
    closedRef.current = true;
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const probeAuth = useCallback(
    async (probeUrl: string): Promise<'redirect' | 'reconnect'> => {
      if (moduleScopedRedirected) return 'redirect';
      const f = fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null);
      if (!f) return 'reconnect';
      try {
        const res = await f(probeUrl, { method: 'HEAD', credentials: 'include' });
        if (res.status !== 401) return 'reconnect';
        let errorCode: string | null = null;
        try {
          const cloned = res.clone();
          const body = (await cloned.json()) as { error_code?: string };
          errorCode = body?.error_code ?? null;
        } catch {
          errorCode = null;
        }
        if (errorCode !== 'auth_required') return 'reconnect';
        if (typeof window !== 'undefined') {
          moduleScopedRedirected = true;
          markLogoutClicked();
          const next = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.replace(`/login?expired=1&next=${next}`);
        }
        return 'redirect';
      } catch {
        return 'reconnect';
      }
    },
    [fetchImpl],
  );

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      cleanup();
      setConnectionState('closed');
      return;
    }

    closedRef.current = false;
    let cancelled = false;

    const open = (): void => {
      if (cancelled || closedRef.current) return;
      setConnectionState((prev) => (prev === 'open' ? 'open' : 'connecting'));
      const es = new EventSource(url, { withCredentials });
      esRef.current = es;

      es.onopen = (ev) => {
        if (cancelled || closedRef.current) return;
        backoffRef.current = INITIAL_BACKOFF_MS;
        setConnectionState('open');
        onOpenRef.current?.(ev);
      };

      es.onmessage = (ev: MessageEvent<string>) => {
        if (cancelled || closedRef.current) return;
        let data: T;
        try {
          data = JSON.parse(ev.data) as T;
        } catch {
          // pass raw string when not JSON
          data = ev.data as unknown as T;
        }
        onMessageRef.current?.(data, ev);
      };

      es.onerror = (ev) => {
        if (cancelled || closedRef.current) return;
        onErrorRef.current?.(ev);
        // Close the broken EventSource before probing — prevents reconnect storm.
        try {
          es.close();
        } catch {
          // already closed
        }
        if (esRef.current === es) esRef.current = null;
        setConnectionState('reconnecting');

        void probeAuth(url).then((decision) => {
          if (cancelled || closedRef.current) return;
          if (decision === 'redirect') {
            cleanup();
            setConnectionState('closed');
            return;
          }
          // Schedule reconnect with backoff + jitter.
          const jitter = Math.random() * 0.4 + 0.8; // 0.8..1.2x
          const delay = Math.min(backoffRef.current * jitter, MAX_BACKOFF_MS);
          backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            open();
          }, delay);
        });
      };
    };

    open();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [url, enabled, withCredentials, cleanup, probeAuth]);

  const close = useCallback(() => {
    cleanup();
    setConnectionState('closed');
  }, [cleanup]);

  return { connectionState, close };
}
