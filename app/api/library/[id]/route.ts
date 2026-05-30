import crypto from 'node:crypto';
import { fileRepo, jobRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';

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

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // 05-01 Plan T3: requireAuth gate.
  const __auth = await requireAuth(request);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/library/:id' });

  const { id: rawId } = await context.params;
  if (!/^\d+$/.test(rawId)) {
    return jsonResponse({ error: 'invalid_id', requestId }, 400);
  }
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) {
    return jsonResponse({ error: 'invalid_id', requestId }, 400);
  }

  try {
    const file = fileRepo().getById(id);
    if (!file) {
      return jsonResponse({ error: 'not_found', requestId }, 404);
    }
    // 12-03 inline-extend Route-1: surface latest job (REGARDLESS of status)
    // so the FileDetailPanel can display encoder + crf + preset_used for the
    // most recent attempt — including failed/cancelled. Operator-facing
    // audit-trail: a pinned preset that didn't make it through still surfaces
    // so the operator can diagnose "why is preset_used '—'?".
    const lastJob = jobRepo().findLatestByFileId(id) ?? null;
    return jsonResponse({ file, lastJob, requestId }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/library/:id: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
