import crypto from 'node:crypto';
import { fileRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';
import { readSidecar, sidecarPathFor } from '@/src/lib/encode/sidecar';
import type { ContainerFallbackRecord } from '@/src/lib/encode/sidecar';

// GET /api/library/[id]/sidecar-summary
// Returns lightweight sidecar forensics for the FileDetailPanel.
// Currently exposes only containerFallback — extend as needed for future panels.

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

export async function GET(req: Request, ctx: RouteContext): Promise<Response> {
  const __auth = await requireAuth(req);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse({ containerFallback: null }, 200);
  }

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/library/[id]/sidecar-summary' });

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

    const sidecarPath = sidecarPathFor(file.path);
    const sidecar = await readSidecar(sidecarPath);

    let containerFallback: ContainerFallbackRecord | null = null;
    if (sidecar && sidecar.schema === 'x265-butler/v3' && sidecar.containerFallback) {
      containerFallback = sidecar.containerFallback;
    }

    return jsonResponse({ containerFallback }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/library/[id]/sidecar-summary GET: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
