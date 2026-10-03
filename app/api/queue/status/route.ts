import crypto from 'node:crypto';
import { jobRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
// 32-02: import from the dependency-free pause-state module, NOT the encode barrel
// (barrel pulls the orchestrator's makeDefaultDeps db reads — audit SR-3).
import { isQueuePaused } from '@/src/lib/encode/pause-state';
import { queueCountsSnapshot } from '@/src/lib/queue/counts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/queue/status — UI bootstrap before EventSource connects.
// Mirrors the SSE `queue.updated` payload + paused flag.
export async function GET(request: Request): Promise<Response> {
  // 05-01 Plan T3: requireAuth gate.
  const { denied } = await gateAuth(request);
  if (denied) return denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/queue/status' });

  try {
    // audit-added M2: countByStatus('queued') is exact — replaces
    // listRecent(500).filter(...) which silently undercounts past 500 rows.
    // 48-03: all three numbers from ONE listActive pass + one countByStatus —
    // three repo calls become two, and the bootstrap value the topbar badge reads
    // now comes from the SAME computation as the live SSE value. That divergence
    // (a status COUNT here vs the active-row count on the wire) was the core of
    // the badge jump from 4 to 999 on the first event.
    // encodingJobs = exact count of jobs whose ffmpeg is in flight (status='encoding').
    // Distinct from activeJobs (which also includes 'queued') so the cancel-poll
    // fallback can ask "is anything still encoding?" without false-positive warns
    // when other queued jobs exist.
    const { activeJobs, encodingJobs, pendingJobs } = queueCountsSnapshot(jobRepo());
    // 05-09: hasEncodingJob still consumed by the Skip-confirm modal gate
    // (replaces 05-08 stop-confirm). Renamed semantic: UI uses this to decide
    // whether to show the "Active video will be cancelled" confirm dialog
    // before firing /api/queue/[jobId]/skip on the active row.
    const hasEncodingJob = encodingJobs > 0;
    // 32-02: paused field re-activated — reports the real in-memory pause flag
    // (isQueuePaused is the single getter shared with the orchestrator/watcher emit
    // + SSR page). rebootstrap consumes this so a fresh tab adopts the live state.
    return jsonResponse(
      { paused: isQueuePaused(), activeJobs, encodingJobs, hasEncodingJob, pendingJobs, requestId },
      200,
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/queue/status: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
