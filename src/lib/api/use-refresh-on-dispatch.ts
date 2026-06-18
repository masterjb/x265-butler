import { useEffect, useRef } from 'react';

/**
 * 05-13 UAT-deviation: Queue page list-staleness on auto-dispatch.
 *
 * Pre-existing design gap from 02-04 (engine-events-client.tsx): the SSE
 * reducer maintains `activeJob` + `counts` + `paused` but NOT a `recentJobs[]`
 * snapshot. Queue page's `livePending` derives from `liveRecentJobs.filter`
 * which is therefore always empty → fallback to SSR `initialPending` snapshot.
 * When the orchestrator auto-dispatches the next queued job after a completion,
 * the orchestrator transitions the row queued → encoding (server-side), but the
 * client's `initialPending` is the SSR-rendered list from FIRST PAINT — stale.
 *
 * This hook fixes the user-visible symptom without architecting a full
 * recentJobs[] SSE reducer (which would carry larger blast radius). It watches
 * `liveActiveJob` (from the existing SSE reducer) and triggers a Next.js
 * `router.refresh()` whenever the active job's identity changes — including
 *   - null → jobId N (orchestrator just dispatched a job)
 *   - jobId N → jobId M (one job completed, next was dispatched)
 *   - jobId N → null (active job completed; queue is now idle)
 *
 * `router.refresh()` invalidates the Server Component tree and re-runs the
 * server fetch → fresh `initialPending` lands → `livePending` reflects the
 * new DB state. Next.js debounces internally; safe to call repeatedly.
 *
 * Failure modes covered:
 *   - Concurrent dispatch + completion → both events fire, refresh debounces
 *   - First mount (prev = undefined, current = null) → no refresh
 *   - SSE disconnect/reconnect → activeJob may transition through null;
 *     refresh fires, picking up any state changes the client missed
 */
export function useRefreshOnDispatch(
  liveActiveJob: { jobId: number } | null,
  router: { refresh: () => void },
): void {
  const prevJobIdRef = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const currentJobId = liveActiveJob?.jobId ?? null;
    const prevJobId = prevJobIdRef.current;
    // First mount → record state but DON'T refresh (SSR is already fresh).
    if (prevJobId === undefined) {
      prevJobIdRef.current = currentJobId;
      return;
    }
    if (prevJobId !== currentJobId) {
      prevJobIdRef.current = currentJobId;
      router.refresh();
    }
  }, [liveActiveJob, router]);
}

/**
 * 32-03 fix: queue LEFT-pane goes stale after an encoder switch (QSV→VAAPI).
 *
 * An encoder switch is a `PUT /api/settings` that never touches the queue, so
 * the active-job identity does NOT change → `useRefreshOnDispatch` never fires
 * → the SSR `initialPending` snapshot stays at first paint until a manual
 * reload. Engine re-init around a settings change blips the SSE connection;
 * a reconnect is the signal that the client may have missed state and the list
 * could be stale. Fire a `router.refresh()` on a reconnect (disconnected
 * true→false) to re-fetch the Server Component tree.
 *
 * First mount records state but does NOT refresh (SSR is already fresh). A
 * drop (false→true) and steady values do NOT refresh.
 *
 * KNOWN LIMITATION (audit SR-2): `disconnected` only flips `true` after
 * RECONNECT_BANNER_DELAY_MS (5s) in the provider's handleError timer
 * (engine-events-client.tsx). A sub-5s SSE blip never sets disconnected=true,
 * so this hook does NOT fire for it. The same-page fast case is covered by
 * `useRefreshOnVisibilityRegain` and SSR-on-navigation; the residual
 * foreground-tab + server-side-switch + <5s-blip edge stays stale-till-reload
 * (accepted — not the reported repro).
 */
export function useRefreshOnReconnect(
  disconnected: boolean,
  router: { refresh: () => void },
): void {
  const prevRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    const prev = prevRef.current;
    // First mount → record state but DON'T refresh (SSR is already fresh).
    if (prev === undefined) {
      prevRef.current = disconnected;
      return;
    }
    if (prev !== disconnected) {
      prevRef.current = disconnected;
      // Refresh ONLY on a reconnect (true → false), not on a drop.
      if (prev === true && disconnected === false) {
        router.refresh();
      }
    }
  }, [disconnected, router]);
}

/**
 * 32-03 fix (companion to useRefreshOnReconnect): operator switches the encoder
 * in another tab, then returns to the queue tab. The queue list needs a fresh
 * SSR fetch on tab-regain because nothing else triggers it for that flow.
 *
 * Registers a SECOND, independent `visibilitychange` listener on `document`
 * and fires `router.refresh()` on a hidden→visible transition only (never on
 * the initial visible mount).
 *
 * DELIBERATE DIVERGENCE (audit SR-1): the engine-events provider already has a
 * `visibilitychange` handler (engine-events-client.tsx:311-331) that gates its
 * count-rebootstrap behind VISIBILITY_REBOOTSTRAP_DELAY_MS (>60s background).
 * This hook is INTENTIONALLY UNGATED: the target bug is "operator switches the
 * encoder in another tab and returns within seconds" — a 60s gate would DEFEAT
 * the fix. The cost (a full SSR re-fetch of peekQueued(1000) on every regain)
 * is accepted because `router.refresh()` is Next-debounced and the queue route
 * is cheap. A future maintainer MUST NOT "harmonize" this hook with the
 * provider's 60s gate — doing so silently reintroduces 32-03. The provider's
 * own handler stays untouched; two parallel listeners on the same event is
 * intentional.
 */
export function useRefreshOnVisibilityRegain(router: { refresh: () => void }): void {
  const hiddenSinceRef = useRef(false);
  useEffect(() => {
    // SSR-safe: no document during server render.
    if (typeof document === 'undefined') return;
    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        hiddenSinceRef.current = true;
        return;
      }
      // → 'visible': refresh only if the tab was previously hidden.
      if (document.visibilityState === 'visible' && hiddenSinceRef.current) {
        hiddenSinceRef.current = false;
        router.refresh();
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [router]);
}
