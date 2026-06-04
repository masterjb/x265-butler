// 05-09: POST /api/queue/cancel-all — mass-skip every active+queued row.
// Replaces /api/queue/stop (deleted) for the operator's "reset everything"
// intent. Active encodes are hard-cancelled; queued rows are zeroed; all
// underlying files transition back to 'pending' so the Library "wartend"
// state lets them be re-encoded later via Encode-now.
import crypto from 'node:crypto';
import { z } from 'zod';
import { cancelAllQueued } from '@/src/lib/encode';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({}).strict();

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  const __auth = await requireAuth(request);
  if (!__auth.ok) return authGuard(__auth)!;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/queue/cancel-all' });

  // Audit M6 (16KB Content-Length cap — Phase 5 SOC-2 hardening parity with
  // 05-01 audit M-pattern).
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader && parseInt(contentLengthHeader, 10) > 16384) {
    return jsonResponse({ error: 'body_too_large', requestId }, 413);
  }

  const contentType = (request.headers.get('content-type') ?? '').trim().toLowerCase();
  if (!contentType.startsWith('application/json')) {
    log.warn({ contentType }, 'unsupported content-type, rejecting with 415');
    return jsonResponse({ error: 'unsupported_media_type', requestId }, 415);
  }

  try {
    let bodyJson: unknown = {};
    const text = await request.text();
    if (text.trim().length > 0) {
      try {
        bodyJson = JSON.parse(text);
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'invalid JSON body');
        return jsonResponse({ error: 'invalid_body', details: 'malformed JSON', requestId }, 400);
      }
    }
    const parsed = bodySchema.safeParse(bodyJson);
    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues }, 'body schema validation failed');
      return jsonResponse({ error: 'invalid_body', details: parsed.error.issues, requestId }, 400);
    }

    const actorId =
      __auth.mode === 'authenticated' ? (__auth.username ?? 'auth_disabled') : 'auth_disabled';

    const result = await cancelAllQueued(actorId);

    // Audit S2 — orchestrator emits queue_cancel_all_empty when M=0+N=0.
    // Route does NOT mirror to keep audit-trail single-source. For non-empty
    // we emit a route-level audit-trail entry alongside.
    if (result.skipped > 0 || result.cancelled > 0) {
      log.info(
        {
          action: 'queue_cancelled_all',
          actorId,
          skipped: result.skipped,
          cancelled: result.cancelled,
        },
        'cancel-all request handled',
      );
    }

    return jsonResponse(
      {
        skipped: result.skipped,
        cancelled: result.cancelled,
        requestId,
      },
      200,
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/queue/cancel-all: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
