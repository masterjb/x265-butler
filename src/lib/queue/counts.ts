// 48-03 (R3): the single place where the SSE/status queue count triple is built.
//
// Background: `listActive()` selects `WHERE status IN ('queued','encoding')`, so
// its row count is queued+encoding. Eight `queue.updated` emit sites reported that
// number as `activeJobs`, and six UI consumers rendered it under the label
// "active" / "encoding" — a user with encode_parallelism=4 and 995 waiting jobs
// read "999 active". The SQL is correct; only the UI label was wrong. This module
// exposes the encoding-only count alongside it so both readings are available
// from ONE pass over the same rows.
//
// Type-only imports on purpose: no runtime import of the `@/src/lib/db` barrel
// and no `encode` barrel (that one drags `makeDefaultDeps` DB reads along — see
// 32-02 audit SR-3 in app/api/queue/status/route.ts).
import type { JobRow } from '@/src/lib/db/schema';
import type { JobRepo } from '@/src/lib/db/repos/job';

export interface QueueCountsSnapshot {
  /** queued + encoding. Wire-compatible with the `activeJobs` field since 02-03. */
  activeJobs: number;
  /** ONLY status='encoding' — the number the UI displays as "encoding" (48-03). */
  encodingJobs: number;
  /** ONLY status='queued'. */
  pendingJobs: number;
}

// INVARIANT 1 — `pendingJobs` is deliberately NOT derived from `activeRows`, even
// though it could be. Reason: `activeJobs` and `pendingJobs` stay byte-identical
// to the pre-48-03 computation, so no existing test has to move its expected
// numbers (AC-2). The price: `encodingJobs + pendingJobs` may differ from
// `activeJobs` by 1 when a queued→encoding transition lands BETWEEN the two
// queries. That is inconsequential — the affected surfaces are a header string
// and a toast counter, and the drift is 1 instead of the ~1000 it was before.
//
// INVARIANT 2 — `encodingJobs <= activeJobs` holds structurally, because both
// numbers come from the SAME row array. A future caller that assembles them from
// two separate queries would break this silently; tests assert it explicitly.

/** Pure variant — use where the active rows are already in hand (AC-3). */
export function queueCountsFromRows(
  activeRows: JobRow[],
  pendingJobs: number,
): QueueCountsSnapshot {
  return {
    activeJobs: activeRows.length,
    encodingJobs: activeRows.filter((r) => r.status === 'encoding').length,
    pendingJobs,
  };
}

/**
 * Repo variant — calls `listActive()` exactly once and `countByStatus('queued')`
 * exactly once. `Pick<JobRepo, …>` rather than `JobRepo` so the existing test
 * mocks (`{ listActive: () => [], countByStatus: () => 0 }`) fit without a cast.
 */
export function queueCountsSnapshot(
  repo: Pick<JobRepo, 'listActive' | 'countByStatus'>,
): QueueCountsSnapshot {
  const activeRows = repo.listActive();
  const pendingJobs = repo.countByStatus('queued');
  return queueCountsFromRows(activeRows, pendingJobs);
}
