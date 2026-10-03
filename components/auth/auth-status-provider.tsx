'use client';

// 05-02 T1: AuthStatusProvider — SSR-seeded auth status context.
// Phase 5 Plan 05-02 (Auth UI) — audit M2 + S2.
//
// Layout (Server Component) computes initialStatus server-side via
// getServerAuthStatus() and passes it as a prop. Client consumers read
// synchronously via useAuthStatus(). NO mount-time fetch when provider is
// wired correctly. Re-fetch fires only on document.visibilitychange events
// (login-in-other-tab detection) OR explicit invalidate() call.
//
// Single-subscription pattern via useSyncExternalStore (carry-forward 02-04
// EngineEventsProvider) — prevents per-component fetch storms.

import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

export interface AuthStatusValue {
  authEnabled: boolean;
  setupCompleted: boolean;
  authenticated: boolean;
  username: string | null;
}

interface Subscriber {
  (): void;
}

interface Store {
  snapshot: AuthStatusValue;
  subscribers: Set<Subscriber>;
  inflight: Promise<void> | null;
}

function createStore(initial: AuthStatusValue): Store {
  return {
    snapshot: initial,
    subscribers: new Set(),
    inflight: null,
  };
}

function notify(store: Store): void {
  for (const sub of store.subscribers) sub();
}

async function refresh(store: Store): Promise<void> {
  if (store.inflight) return store.inflight;
  store.inflight = (async () => {
    try {
      const res = await fetch('/api/auth/status', { cache: 'no-store' });
      if (!res.ok) return;
      const json = (await res.json()) as AuthStatusValue;
      const next: AuthStatusValue = {
        authEnabled: !!json.authEnabled,
        setupCompleted: !!json.setupCompleted,
        authenticated: !!json.authenticated,
        username: json.username ?? null,
      };
      const prev = store.snapshot;
      if (
        prev.authEnabled !== next.authEnabled ||
        prev.setupCompleted !== next.setupCompleted ||
        prev.authenticated !== next.authenticated ||
        prev.username !== next.username
      ) {
        store.snapshot = next;
        notify(store);
      }
    } catch {
      // Network failure — keep last known good snapshot.
    } finally {
      store.inflight = null;
    }
  })();
  return store.inflight;
}

const Context = createContext<Store | null>(null);

interface ProviderProps {
  initialStatus: AuthStatusValue;
  children: ReactNode;
}

export function AuthStatusProvider({ initialStatus, children }: ProviderProps) {
  const storeRef = useRef<Store | null>(null);
  if (!storeRef.current) {
    storeRef.current = createStore(initialStatus);
  }
  const store = storeRef.current;

  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible') {
        void refresh(store);
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [store]);

  return <Context.Provider value={store}>{children}</Context.Provider>;
}

function subscribe(store: Store): (cb: Subscriber) => () => void {
  return (cb) => {
    store.subscribers.add(cb);
    return () => {
      store.subscribers.delete(cb);
    };
  };
}

const FALLBACK_SNAPSHOT: AuthStatusValue = {
  authEnabled: false,
  setupCompleted: false,
  authenticated: false,
  username: null,
};

export function useAuthStatus(): AuthStatusValue {
  const store = useContext(Context);
  // Defensive fallback per 05-02-PLAN T1.D — should never trigger when layout
  // wires AuthStatusProvider correctly. Emits a console warn for observability.
  const fallbackRef = useRef(false);
  useEffect(() => {
    if (!store && !fallbackRef.current) {
      fallbackRef.current = true;
      console.warn(
        '[auth] useAuthStatus called without AuthStatusProvider; using fallback snapshot',
      );
    }
  }, [store]);

  return useSyncExternalStore(
    store ? subscribe(store) : () => () => {},
    () => store?.snapshot ?? FALLBACK_SNAPSHOT,
    () => store?.snapshot ?? FALLBACK_SNAPSHOT,
  );
}

/**
 * Force a refresh of /api/auth/status. Call after explicit auth-state changes
 * (e.g., post-PUT /api/settings touching auth keys). When no provider is in
 * scope this is a no-op.
 */
export function invalidateAuthStatusFromClient(store: Store | null): void {
  if (!store) return;
  void refresh(store);
}
