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
