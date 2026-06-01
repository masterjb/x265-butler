import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';
// audit-added M1 (02-04): dedicated /api/trash/summary endpoint resolves §9 vs Task 4
// contradiction — Trash Server Component fetches this instead of calling trashRepo.summary()
// directly, restoring the "Server Components fetch via /api/*" invariant.
import crypto from 'node:crypto';
import { trashRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

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

export async function GET(request: Request): Promise<Response> {
  // 05-01 Plan T3: requireAuth gate.
  const __auth = await requireAuth(request);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/trash/summary' });

  try {
    const { bytesReclaimed, count } = trashRepo().summary();
    return jsonResponse({ bytesReclaimed, count, requestId }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/trash/summary: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
