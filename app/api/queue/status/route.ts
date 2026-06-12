import crypto from 'node:crypto';
import { jobRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
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
    const activeJobs = jobRepo().listActive().length;
    const pendingJobs = jobRepo().countByStatus('queued');
    // encodingJobs = exact count of jobs whose ffmpeg is in flight (status='encoding').
    // Distinct from activeJobs (which also includes 'queued') so the cancel-poll
    // fallback can ask "is anything still encoding?" without false-positive warns
    // when other queued jobs exist.
    const encodingJobs = jobRepo().countByStatus('encoding');
    // 05-09: hasEncodingJob still consumed by the Skip-confirm modal gate
    // (replaces 05-08 stop-confirm). Renamed semantic: UI uses this to decide
    // whether to show the "Active video will be cancelled" confirm dialog
    // before firing /api/queue/[jobId]/skip on the active row.
    const hasEncodingJob = encodingJobs > 0;
    // 05-09 Decision §2/§3: paused field permanently false (Pause retired).
    return jsonResponse(
      { paused: false, activeJobs, encodingJobs, hasEncodingJob, pendingJobs, requestId },
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
