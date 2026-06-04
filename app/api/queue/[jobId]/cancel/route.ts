import crypto from 'node:crypto';
import { jobRepo } from '@/src/lib/db';
import { skipActive } from '@/src/lib/encode';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * DELETE /api/queue/[jobId]/cancel
 *
 * @deprecated 05-09 Decision §1: use POST /api/queue/[jobId]/skip instead.
 * Removal scheduled for Milestone 2 — telemetry on `api_deprecated_endpoint_called`
 * audit-trail entries (audit S1) measures actual usage; if zero hits over a
 * representative window post-1.5 deploy the endpoint can be removed in a
 * one-commit cleanup.
 *
 * 05-09 audit S1 + AC-13: forwards to skipActive() (same semantic — file→
 * 'pending' on encoding/queued, idempotent on terminal). Original 02-03
 * `cancelJob` flow is replaced; file-status outcome is now 'pending' instead
 * of 'interrupted'.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const __auth = await requireAuth(request);
  if (!__auth.ok) return authGuard(__auth)!;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/queue/[jobId]/cancel' });

  try {
    const { jobId: jobIdStr } = await context.params;
    const jobId = Number.parseInt(jobIdStr, 10);
    if (!Number.isFinite(jobId) || jobId <= 0 || String(jobId) !== jobIdStr) {
      log.warn({ jobIdStr }, 'invalid jobId in path');
      return jsonResponse({ error: 'invalid_job_id', jobIdStr, requestId }, 400);
    }

    const actorId =
      __auth.mode === 'authenticated' ? (__auth.username ?? 'auth_disabled') : 'auth_disabled';

    // 05-09 audit S1: deprecation telemetry. Pino warn fires on EVERY hit so
    // operator log review can reconstruct usage. Quantifies whether endpoint
    // can be removed in a future plan (Decision §5).
    log.warn(
      {
        action: 'api_deprecated_endpoint_called',
        endpoint: '/api/queue/[jobId]/cancel',
        actorId,
        jobId,
      },
      'deprecated endpoint /api/queue/[jobId]/cancel hit — use /api/queue/[jobId]/skip',
    );

    const jobRow = jobRepo().findById(jobId);
    if (!jobRow) {
      log.info({ jobId }, 'job_not_found');
      return jsonResponse({ error: 'not_active', jobId, requestId }, 404);
    }

    const result = await skipActive(jobId, actorId);

    log.info(
      {
        action: 'cancel_via_skip',
        jobId,
        prevStatus: result.prevStatus,
        alreadyTerminal: result.alreadyTerminal,
      },
      'deprecated /cancel forwarded to skipActive',
    );
    return jsonResponse(
      {
        jobId,
        status: 'cancelling',
        pollUrl: '/api/queue/status',
        alreadyTerminal: result.alreadyTerminal,
        requestId,
      },
      202,
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/queue/[jobId]/cancel: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
