// 32-02: POST /api/queue/pause — pause-after-current. Flips the in-memory
// orchestrator pause flag so NO new job is dispatched; the running encode finishes
// normally (unlike cancel-all, which aborts in-flight work). In-memory only — a
// container restart resumes. Mirrors cancel-all/route.ts hardening 1:1 (auth gate,
// 413 >16KB, 415 non-JSON, strict empty-body zod, single authoritative audit line).
import crypto from 'node:crypto';
import { z } from 'zod';
import { setQueuePaused } from '@/src/lib/encode';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({}).strict();

export async function POST(request: Request): Promise<Response> {
  const { denied, auth } = await gateAuth(request);
  if (denied) return denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/queue/pause' });

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
      auth.mode === 'authenticated' ? (auth.username ?? 'auth_disabled') : 'auth_disabled';

    // setQueuePaused is idempotent (no-op on unchanged). The route always returns
    // the post-state, so a double-pause returns 200 { paused: true } both times.
    setQueuePaused(true);

    // Single authoritative actor-attributed audit line (SR-2: the setter logs a
    // distinct queue_pause_state_changed breadcrumb, not queue_paused).
    log.info({ action: 'queue_paused', actorId }, 'queue paused');

    return jsonResponse({ paused: true, requestId }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/queue/pause: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
