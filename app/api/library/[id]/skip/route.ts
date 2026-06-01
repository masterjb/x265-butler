// 05-09: POST /api/library/[id]/skip — file-id wrapper for the Library row
// Skip affordance. Looks up the active job for the file (status='queued' OR
// 'encoding') and forwards to orchestrator.skipActive(jobId). Eliminates the
// N+1 jobId lookup that would otherwise be required by the row-level UI.
//
// 05-09 plan deviation note: PLAN AC-3 says "POST /api/queue/[jobId]/skip is
// invoked via authFetch". The Library row does not have direct jobId access
// (only file.status reveals an active encode); this wrapper preserves the
// semantic by delegating to skipActive() server-side. Same audit-trail fires;
// same idempotent contract.
import crypto from 'node:crypto';
import { fileRepo, jobRepo } from '@/src/lib/db';
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

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  const __auth = await requireAuth(req);
  if (!__auth.ok) return authGuard(__auth)!;

  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse({ skipped: true, reason: 'build-time-skip', requestId: 'build' }, 200);
  }

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/library/[id]/skip' });

  // 05-09 audit M6 parity: 16KB Content-Length cap mirrors /api/queue/[jobId]/skip.
  const contentLengthHeader = req.headers.get('content-length');
  if (contentLengthHeader && parseInt(contentLengthHeader, 10) > 16384) {
    return jsonResponse({ error: 'body_too_large', requestId }, 413);
  }

  // Strict empty-body — same convention as 04-03 retry route.
  const bodyText = await req.text();
  if (bodyText.length > 0) {
    const trimmed = bodyText.trim();
    if (trimmed !== '' && trimmed !== '{}') {
      return jsonResponse({ error: 'unexpected_body', requestId }, 400);
    }
  }

  ensureServerInit();

  const params = await ctx.params;
  const fileId = parseInt(params.id, 10);
  if (!Number.isFinite(fileId) || fileId <= 0) {
    return jsonResponse({ error: 'invalid_file_id', requestId }, 400);
  }

  try {
    const file = fileRepo().getById(fileId);
    if (!file) {
      return jsonResponse({ error: 'file_not_found', requestId }, 404);
    }
    const activeJob = jobRepo().findByFileId(fileId);
    if (!activeJob || (activeJob.status !== 'queued' && activeJob.status !== 'encoding')) {
      return jsonResponse(
        { error: 'no_active_job', fileId, currentStatus: file.status, requestId },
        404,
      );
    }
    const actorId =
      __auth.mode === 'authenticated' ? (__auth.username ?? 'auth_disabled') : 'auth_disabled';
    const result = await skipActive(activeJob.id, actorId);
    log.info(
      {
        action: 'library_skip_forwarded',
        fileId,
        jobId: activeJob.id,
        actorId,
        prevStatus: result.prevStatus,
      },
      'Library row Skip forwarded to skipActive',
    );
    return jsonResponse(
      {
        skipped: true,
        fileId,
        jobId: activeJob.id,
        jobStatus: result.prevStatus,
        alreadyTerminal: result.alreadyTerminal,
        requestId,
      },
      200,
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/library/[id]/skip: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
