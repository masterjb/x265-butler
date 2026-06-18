'use client';

// 02-04: Single browser EventSource at App-Shell layer (one SSE connection
// survives Queue ↔ Library ↔ Trash navigation).
//
// Design decisions (binding per 02-04-CONTEXT.md §2 + §8):
// - useSyncExternalStore with selector functions for narrow re-render scoping
// - audit-M4: Page Visibility API rebootstrap after >60s background tab
// - audit-S1: EventSource opened with { withCredentials: true }
// - audit-S9: StrictMode-safe cleanup (closes EventSource before re-mount)
// - audit-S13: stale-closure invariant — subscribe callback is stable via
//   useCallback; getSnapshot returns reference-stable slices via selector cache
//
// Snapshot vs Subscribe separation:
//   subscribe: registers a callback that fires when ANY store slice changes;
//     MUST be stable (useCallback-wrapped at provider level) — do NOT capture
//     render-scoped state inside the callback.
//   getSnapshot: returns the current slice for a specific consumer; must be
//     referentially stable when the slice hasn't changed (selector cache).
//   Violating either invariant causes useSyncExternalStore to infinite-loop or
//     trigger spurious re-renders.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
// Type-only import — engine runtime (singleton) MUST stay server-only.
import type { EngineEvent } from '@/src/lib/encode/events';
import type { JobRow } from '@/src/lib/db/schema';
// 05-03 audit S9: shared SSE subscription hook closes 02-04 carry-forward —
// 401 mid-stream → markLogoutClicked + redirect once (no reconnect storm).
import { useSseSubscription } from '@/components/logs/use-sse-subscription';

// --- Store shape ---

export interface ActiveJob {
  jobId: number;
  fileId: number;
  /** outTimeMs from ffmpeg progress pipe (not percentage — needs file.duration to compute %) */
  outTimeMs: number | null;
  fps: number | null;
  totalSize: number | null;
  encoder: string | null;
}

export interface QueueCounts {
  activeJobs: number;
  pendingJobs: number;
}

// 11-02: BenchRunState slice — tracks current bench run progress via SSE
// 11-02-FIX (UAT-001): + currentComboId / currentComboPct / currentComboOverallPct
//   for live per-combo progress bar. No cache: fresh subscriber sees pct=0 for ≤1s
//   (acceptable lag; per-combo cache would multiply memory by combo-count). Audit SR4.
export interface BenchRunState {
  runId: number | null;
  mode: string | null;
  status: 'idle' | 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  completedCombos: number;
  totalCombos: number;
  currentPhase: string | null;
  errorReason: string | null;
  currentComboId: number | null;
  currentComboPct: number; // 0-100, bar fill source (audit M2: NOT overallPct)
  currentComboOverallPct: number; // 0-100, informational only
}

const INITIAL_BENCH_RUN: BenchRunState = {
  runId: null,
  mode: null,
  status: 'idle',
  completedCombos: 0,
  totalCombos: 0,
  currentPhase: null,
  errorReason: null,
  currentComboId: null,
  currentComboPct: 0,
  currentComboOverallPct: 0,
};

// 11-03: Pass-2 per-combo lifecycle slice. Map keyed by comboId so multiple
// past verifications stay individually addressable; only one combo runs at a
// time (orchestrator pass2_busy lock).
export type Pass2ComboStatus = 'idle' | 'running' | 'complete' | 'failed' | 'cancelled';

export interface Pass2ComboState {
  runId: number;
  comboId: number;
  status: Pass2ComboStatus;
  overallPct: number;
  currentPhase: 'encode' | 'vmaf' | null;
  errorReason: string | null;
  // Verified metrics populated on bench.pass2_complete; null until then.
  vmaf: number | null;
  sizeBytes: number | null;
  encodeSec: number | null;
  completedAt: number | null;
}

interface EngineEventsStore {
  activeJob: ActiveJob | null;
  recentJobs: JobRow[];
  paused: boolean;
  counts: QueueCounts;
  disconnected: boolean;
  benchRun: BenchRunState;
  pass2: Record<number, Pass2ComboState>;
}

const INITIAL_STORE: EngineEventsStore = {
  activeJob: null,
  recentJobs: [],
  paused: false,
  counts: { activeJobs: 0, pendingJobs: 0 },
  disconnected: false,
  benchRun: INITIAL_BENCH_RUN,
  pass2: {},
};

// --- Selector cache for reference-stable slices ---

interface SelectorCache {
  activeJob: ActiveJob | null;
  recentJobs: JobRow[];
  paused: boolean;
  counts: QueueCounts;
  disconnected: boolean;
  benchRun: BenchRunState;
  pass2: Record<number, Pass2ComboState>;
}

// --- Internal store object (single per provider instance) ---

interface StoreInstance {
  getState(): EngineEventsStore;
  setState(updater: (prev: EngineEventsStore) => EngineEventsStore): void;
  subscribe(listener: () => void): () => void;
}

function createStore(initial: EngineEventsStore): StoreInstance {
  let state = initial;
  const listeners = new Set<() => void>();

  return {
    getState: () => state,
    setState(updater) {
      const next = updater(state);
      if (next !== state) {
        state = next;
        for (const l of listeners) l();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// --- Context ---

// 11-02: type alias for bench.combo_complete listener callbacks
type ComboCompleteEvent = Extract<
  import('@/src/lib/encode/events').EngineEvent,
  { type: 'bench.combo_complete' }
>;

interface EngineEventsContextValue {
  store: StoreInstance;
  selectorCache: React.MutableRefObject<SelectorCache>;
  comboListeners: React.MutableRefObject<Set<(ev: ComboCompleteEvent) => void>>;
}

const EngineEventsContext = createContext<EngineEventsContextValue | null>(null);

// --- Provider props ---

export interface EngineEventsProviderProps {
  children: React.ReactNode;
  initialPaused?: boolean;
  initialCounts?: QueueCounts;
}

const RECONNECT_BANNER_DELAY_MS = 5_000;
const VISIBILITY_REBOOTSTRAP_DELAY_MS = 60_000;

// --- Provider ---

export function EngineEventsProvider({
  children,
  initialPaused = false,
  initialCounts,
}: EngineEventsProviderProps) {
  const storeRef = useRef<StoreInstance | null>(null);

  if (!storeRef.current) {
    storeRef.current = createStore({
      ...INITIAL_STORE,
      paused: initialPaused,
      counts: initialCounts ?? INITIAL_STORE.counts,
    });
  }

  const store = storeRef.current;

  // Selector cache — reference-stable slices per consumer hook.
  // Updated only when corresponding slice changes (see useActiveJob etc.).
  const selectorCache = useRef<SelectorCache>({
    activeJob: store.getState().activeJob,
    recentJobs: store.getState().recentJobs,
    paused: store.getState().paused,
    counts: store.getState().counts,
    disconnected: store.getState().disconnected,
    benchRun: store.getState().benchRun,
    pass2: store.getState().pass2,
  });

  // 11-02: side-channel Set for high-frequency bench.combo_complete fan-out.
  // Lives outside the React render cycle; useBenchComboFeed adds/removes listeners.
  const comboListeners = useRef<Set<(ev: ComboCompleteEvent) => void>>(new Set());

  // --- SSE lifecycle (retrofitted onto shared useSseSubscription per 05-03 audit S9) ---
  //
  // 02-04 contract preserved byte-identical:
  //   - withCredentials=true (audit-S1 carry-forward)
  //   - onopen → rebootstrap + clear disconnected
  //   - onmessage → handleEngineEvent reducer
  //   - onerror → 5s timer → disconnected=true (RECONNECT_BANNER_DELAY_MS)
  //   - cleanup on unmount (StrictMode-safe via hook's internal cancel guard)
  // What's new: 05-03 audit S9 401-aware probe lives inside the hook — when a
  // 401 with auth_required mid-stream is detected, the hook redirects ONCE.

  const reconnectBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibilityTimerRef = useRef<number>(0);
  const openedAtRef = useRef<number>(0);

  const rebootstrap = useCallback(async () => {
    try {
      const res = await fetch('/api/queue/status');
      if (!res.ok) return;
      const data = (await res.json()) as {
        paused: boolean;
        activeJobs: number;
        pendingJobs: number;
      };
      store.setState((prev) => ({
        ...prev,
        paused: data.paused,
        counts: { activeJobs: data.activeJobs, pendingJobs: data.pendingJobs },
        disconnected: false,
      }));
    } catch {
      // best-effort
    }
  }, [store]);

  const handleOpen = useCallback(() => {
    openedAtRef.current = Date.now();
    if (reconnectBannerTimerRef.current) {
      clearTimeout(reconnectBannerTimerRef.current);
      reconnectBannerTimerRef.current = null;
    }
    store.setState((prev) => ({ ...prev, disconnected: false }));
    void rebootstrap();
  }, [store, rebootstrap]);

  const handleMessage = useCallback(
    (data: unknown) => {
      try {
        const event = data as EngineEvent;
        handleEngineEvent(event, store);
        // 11-02: fan-out bench.combo_complete to imperative listeners (outside React cycle)
        if (event.type === 'bench.combo_complete') {
          for (const cb of Array.from(comboListeners.current)) {
            cb(event as ComboCompleteEvent);
          }
        }
      } catch {
        // ignore malformed SSE
      }
    },
    [store, comboListeners],
  );

  const handleError = useCallback(() => {
    if (reconnectBannerTimerRef.current) return;
    const openedAt = openedAtRef.current;
    reconnectBannerTimerRef.current = setTimeout(() => {
      reconnectBannerTimerRef.current = null;
      const elapsed = Date.now() - openedAt;
      if (elapsed > RECONNECT_BANNER_DELAY_MS || openedAt === 0) {
        store.setState((prev) => ({ ...prev, disconnected: true }));
      }
    }, RECONNECT_BANNER_DELAY_MS);
  }, [store]);

  // audit-S1: withCredentials=true preserved.
  useSseSubscription({
    url: '/api/events',
    enabled: true,
    withCredentials: true,
    onOpen: handleOpen,
    onMessage: handleMessage,
    onError: handleError,
  });

  useEffect(() => {
    // audit-M4: Page Visibility API rebootstrap after >60s background.
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        const now = Date.now();
        if (now - visibilityTimerRef.current > VISIBILITY_REBOOTSTRAP_DELAY_MS) {
          void rebootstrap();
        }
      } else {
        visibilityTimerRef.current = Date.now();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      // 28-02 R7: this effect now owns ONLY the visibilitychange listener.
      // The reconnect-banner timer cleanup was decoupled into its own
      // mount-once effect below, so a future `rebootstrap` identity change
      // can never prematurely clear a live banner timer.
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [rebootstrap]);

  // 28-02 R7: dedicated mount-once unmount cleanup for the reconnect-banner
  // timer, decoupled from the visibility-listener effect above. Clears any
  // pending RECONNECT_BANNER_DELAY_MS timer on provider unmount so it cannot
  // fire a `disconnected: true` setState after the store is gone.
  useEffect(() => {
    return () => {
      if (reconnectBannerTimerRef.current) {
        clearTimeout(reconnectBannerTimerRef.current);
        reconnectBannerTimerRef.current = null;
      }
    };
  }, []);

  const ctxValue = React.useMemo<EngineEventsContextValue>(
    () => ({ store, selectorCache, comboListeners }),
    [store, selectorCache, comboListeners],
  );

  return <EngineEventsContext.Provider value={ctxValue}>{children}</EngineEventsContext.Provider>;
}

// --- Engine event reducer ---

function handleEngineEvent(event: EngineEvent, store: StoreInstance): void {
  store.setState((prev) => {
    switch (event.type) {
      case 'job.started':
        return {
          ...prev,
          activeJob: {
            jobId: event.jobId,
            fileId: event.fileId,
            outTimeMs: null,
            fps: null,
            totalSize: null,
            // 2026-04-27 hotfix: read encoder from SSE payload (was hardcoded
            // null — badge could never render). Orchestrator emits the
            // resolved encoder at dispatch time.
            encoder: event.encoder,
          },
        };
      case 'job.progress': {
        if (!prev.activeJob || prev.activeJob.jobId !== event.jobId) return prev;
        return {
          ...prev,
          activeJob: {
            ...prev.activeJob,
            outTimeMs: event.outTimeMs,
            fps: event.fps,
            totalSize: event.totalSize,
          },
        };
      }
      case 'job.completed':
      case 'job.failed':
      case 'job.cancelled':
        // 05-13 UAT-fix: identity-check before clearing. Skipping a QUEUED
        // job emits job.cancelled for that queued jobId — pre-fix this
        // wiped the activeJob unconditionally, freezing the encoding job's
        // progress bar in idle until natural completion (job.progress events
        // were silently dropped by the early-return at case 'job.progress').
        // Fix: only clear when the event's jobId matches the current active
        // job's identity. Pre-existing 02-04 design bug surfaced by 05-13 UAT.
        if (prev.activeJob && prev.activeJob.jobId !== event.jobId) {
          return prev;
        }
        return { ...prev, activeJob: null };
      case 'queue.updated':
        return {
          ...prev,
          counts: { activeJobs: event.activeJobs, pendingJobs: event.pendingJobs },
          paused: event.paused,
        };
      // 11-02: bench event cases
      case 'bench.queued':
        return {
          ...prev,
          benchRun: {
            ...INITIAL_BENCH_RUN,
            runId: event.runId,
            mode: event.mode,
            status: 'queued',
            completedCombos: 0,
            totalCombos: event.comboCount,
            currentPhase: null,
            errorReason: null,
          },
        };
      case 'bench.started':
        if (prev.benchRun.runId !== event.runId) return prev;
        return { ...prev, benchRun: { ...prev.benchRun, status: 'running' } };
      case 'bench.combo_progress': {
        // 11-02-FIX (UAT-001) audit M4: null-runId race tolerance.
        // bench.combo_progress can arrive before bench.queued/started due to SSE
        // buffer ordering; accept null-runId state and latch ev.runId. Reject only
        // when state.runId is non-null and differs.
        if (prev.benchRun.runId !== null && prev.benchRun.runId !== event.runId) return prev;
        return {
          ...prev,
          benchRun: {
            ...prev.benchRun,
            runId: prev.benchRun.runId ?? event.runId,
            currentComboId: event.comboId,
            currentComboPct: event.phasePct, // audit M2: bar source
            currentComboOverallPct: event.overallPct,
            currentPhase: event.phase, // overrides bench.progress currentPhase
          },
        };
      }
      case 'bench.progress':
        if (prev.benchRun.runId !== event.runId) return prev;
        return {
          ...prev,
          benchRun: {
            ...prev.benchRun,
            completedCombos: event.completedCombos,
            totalCombos: event.totalCombos,
            currentPhase: event.currentPhase,
          },
        };
      case 'bench.combo_complete':
        // No state mutation — fan-out happens in handleMessage via comboListeners
        return prev;
      // 11-02-FIX: combo-state reset on terminal events (audit M3 clean handoff).
      case 'bench.completed':
        if (prev.benchRun.runId !== event.runId) return prev;
        return {
          ...prev,
          benchRun: {
            ...prev.benchRun,
            status: 'complete',
            completedCombos: prev.benchRun.totalCombos,
            currentComboId: null,
            currentComboPct: 0,
            currentComboOverallPct: 0,
          },
        };
      case 'bench.failed':
        if (prev.benchRun.runId !== event.runId) return prev;
        return {
          ...prev,
          benchRun: {
            ...prev.benchRun,
            status: 'failed',
            errorReason: event.errorReason,
            currentComboId: null,
            currentComboPct: 0,
            currentComboOverallPct: 0,
          },
        };
      case 'bench.cancelled':
        if (prev.benchRun.runId !== event.runId) return prev;
        return {
          ...prev,
          benchRun: {
            ...prev.benchRun,
            status: 'cancelled',
            currentComboId: null,
            currentComboPct: 0,
            currentComboOverallPct: 0,
          },
        };
      // 11-03: Pass-2 lifecycle reducer cases.
      case 'bench.pass2_started':
        return {
          ...prev,
          pass2: {
            ...prev.pass2,
            [event.comboId]: {
              runId: event.runId,
              comboId: event.comboId,
              status: 'running',
              overallPct: 0,
              currentPhase: 'encode',
              errorReason: null,
              vmaf: null,
              sizeBytes: null,
              encodeSec: null,
              completedAt: null,
            },
          },
        };
      case 'bench.pass2_progress': {
        const existing = prev.pass2[event.comboId];
        if (!existing) return prev;
        return {
          ...prev,
          pass2: {
            ...prev.pass2,
            [event.comboId]: {
              ...existing,
              overallPct: event.overallPct,
              currentPhase: event.currentPhase,
            },
          },
        };
      }
      case 'bench.pass2_complete':
        return {
          ...prev,
          pass2: {
            ...prev.pass2,
            [event.comboId]: {
              runId: event.runId,
              comboId: event.comboId,
              status: 'complete',
              overallPct: 100,
              currentPhase: null,
              errorReason: null,
              vmaf: event.vmaf,
              sizeBytes: event.sizeBytes,
              encodeSec: event.encodeSec,
              completedAt: event.completedAt,
            },
          },
        };
      case 'bench.pass2_failed': {
        const existing = prev.pass2[event.comboId];
        // 'cancelled' is surfaced as a distinct status to allow operator restart
        const isCancel = event.errorReason === 'cancelled';
        return {
          ...prev,
          pass2: {
            ...prev.pass2,
            [event.comboId]: {
              runId: event.runId,
              comboId: event.comboId,
              status: isCancel ? 'cancelled' : 'failed',
              overallPct: existing?.overallPct ?? 0,
              currentPhase: null,
              errorReason: isCancel ? null : event.errorReason,
              vmaf: null,
              sizeBytes: null,
              encodeSec: null,
              completedAt: null,
            },
          },
        };
      }
      default:
        return prev;
    }
  });
}

// --- Hooks ---

function useEngineEventsContext(): EngineEventsContextValue {
  const ctx = useContext(EngineEventsContext);
  if (!ctx) throw new Error('useEngineEvents: must be inside <EngineEventsProvider>');
  return ctx;
}

// Narrow hook: only re-renders when activeJob changes reference.
export function useActiveJob(): ActiveJob | null {
  const { store, selectorCache } = useEngineEventsContext();

  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);

  const getSnapshot = useCallback(() => {
    const s = store.getState();
    if (s.activeJob !== selectorCache.current.activeJob) {
      selectorCache.current = { ...selectorCache.current, activeJob: s.activeJob };
    }
    return selectorCache.current.activeJob;
  }, [store, selectorCache]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Narrow hook: only re-renders when recentJobs changes reference.
export function useRecentJobs(): JobRow[] {
  const { store, selectorCache } = useEngineEventsContext();

  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);

  const getSnapshot = useCallback(() => {
    const s = store.getState();
    if (s.recentJobs !== selectorCache.current.recentJobs) {
      selectorCache.current = { ...selectorCache.current, recentJobs: s.recentJobs };
    }
    return selectorCache.current.recentJobs;
  }, [store, selectorCache]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Narrow hook: only re-renders when paused changes.
export function usePausedState(): boolean {
  const { store, selectorCache } = useEngineEventsContext();

  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);

  const getSnapshot = useCallback(() => {
    const s = store.getState();
    if (s.paused !== selectorCache.current.paused) {
      selectorCache.current = { ...selectorCache.current, paused: s.paused };
    }
    return selectorCache.current.paused;
  }, [store, selectorCache]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Narrow hook: only re-renders when counts change reference.
export function useQueueCounts(): QueueCounts {
  const { store, selectorCache } = useEngineEventsContext();

  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);

  const getSnapshot = useCallback(() => {
    const s = store.getState();
    if (s.counts !== selectorCache.current.counts) {
      selectorCache.current = { ...selectorCache.current, counts: s.counts };
    }
    return selectorCache.current.counts;
  }, [store, selectorCache]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Narrow hook: only re-renders when disconnected changes.
export function useEngineEventsDisconnected(): boolean {
  const { store, selectorCache } = useEngineEventsContext();

  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);

  const getSnapshot = useCallback(() => {
    const s = store.getState();
    if (s.disconnected !== selectorCache.current.disconnected) {
      selectorCache.current = { ...selectorCache.current, disconnected: s.disconnected };
    }
    return selectorCache.current.disconnected;
  }, [store, selectorCache]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Convenience hook returning all slices — for components that need multiple.
export function useEngineEvents() {
  return {
    activeJob: useActiveJob(),
    recentJobs: useRecentJobs(),
    paused: usePausedState(),
    queueCounts: useQueueCounts(),
    disconnected: useEngineEventsDisconnected(),
  };
}

// 11-02: Narrow hook — only re-renders when benchRun slice changes reference.
export function useBenchRunState(): BenchRunState {
  const { store, selectorCache } = useEngineEventsContext();

  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);

  const getSnapshot = useCallback(() => {
    const s = store.getState();
    if (s.benchRun !== selectorCache.current.benchRun) {
      selectorCache.current = { ...selectorCache.current, benchRun: s.benchRun };
    }
    return selectorCache.current.benchRun;
  }, [store, selectorCache]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// 11-02: Imperative subscriber for high-frequency bench.combo_complete events.
// Registered via useEffect with cleanup — prevents listener leaks across navigations.
export function useBenchComboFeed(
  runId: number | null,
  onCombo: (ev: ComboCompleteEvent) => void,
): void {
  const { comboListeners } = useEngineEventsContext();

  useEffect(() => {
    if (runId === null) return;
    const cb = (ev: ComboCompleteEvent) => {
      if (ev.runId !== runId) return;
      onCombo(ev);
    };
    comboListeners.current.add(cb);
    return () => {
      comboListeners.current.delete(cb);
    };
  }, [runId, onCombo, comboListeners]);
}

// 11-03: Pass-2 slice hook — re-renders only when pass2 map reference changes.
export function useBenchPass2Map(): Record<number, Pass2ComboState> {
  const { store, selectorCache } = useEngineEventsContext();

  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);

  const getSnapshot = useCallback(() => {
    const s = store.getState();
    if (s.pass2 !== selectorCache.current.pass2) {
      selectorCache.current = { ...selectorCache.current, pass2: s.pass2 };
    }
    return selectorCache.current.pass2;
  }, [store, selectorCache]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// Test-only: expose the internal store setter for resetting state in tests.
export function __forTests_getEngineEventsStore(ctx: EngineEventsContextValue): StoreInstance {
  return ctx.store;
}
