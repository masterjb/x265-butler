// 10-02 E-D1: PATCH /api/library/[id]/container-override
// Sets per-file container override (NULL = inherit global output_container).
// requireAuth pattern mirrors skip/retry routes. Body-cap 16 KiB.
import crypto from 'node:crypto';
import { fileRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_OVERRIDES = new Set(['mkv', 'mp4', 'match-source']);

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

export async function PATCH(req: Request, ctx: RouteContext): Promise<Response> {
  const __auth = await requireAuth(req);
  if (!__auth.ok) return authGuard(__auth)!;

  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse({ ok: true, reason: 'build-time-skip', requestId: 'build' }, 200);
  }

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/library/[id]/container-override' });

  const contentLengthHeader = req.headers.get('content-length');
  if (contentLengthHeader && parseInt(contentLengthHeader, 10) > 16384) {
    return jsonResponse({ error: 'body_too_large', requestId }, 413);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_json', requestId }, 400);
  }

  const rawValue = (body as Record<string, unknown>)?.value;
  // null = clear override (inherit global); string must be a valid override value.
  if (rawValue !== null && (typeof rawValue !== 'string' || !VALID_OVERRIDES.has(rawValue))) {
    return jsonResponse({ error: 'invalid_value', requestId }, 400);
  }
  const value = rawValue as 'mkv' | 'mp4' | 'match-source' | null;

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

    const updated = fileRepo().setContainerOverride(fileId, value);
    if (!updated) {
      return jsonResponse({ error: 'file_not_found', requestId }, 404);
    }

    log.info(
      { action: 'container_override_set', fileId, value },
      'per-file container override updated',
    );
    return jsonResponse({ ok: true, fileId, value, requestId }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/library/[id]/container-override: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
