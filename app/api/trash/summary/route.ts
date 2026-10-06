import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
// Dedicated /api/trash/summary endpoint — the Trash Server Component fetches this
// instead of calling trashRepo.summary() directly, keeping the "Server Components
// fetch via /api/*" invariant.
import crypto from 'node:crypto';
import { trashRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  // requireAuth gate.
  const { denied } = await gateAuth(request);
  if (denied) return denied;

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
