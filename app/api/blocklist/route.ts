import crypto from 'node:crypto';
import { z } from 'zod';
import { blocklistRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
// GET /api/blocklist (paginated list).
// Same zod query parsing pattern as GET /api/trash (z.coerce.number()).

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  size: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(request: Request): Promise<Response> {
  // requireAuth gate.
  const { denied } = await gateAuth(request);
  if (denied) return denied;

  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse({ rows: [], total: 0, requestId: 'build' }, 200);
  }

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/blocklist' });

  try {
    const url = new URL(request.url);
    const raw: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      if (v !== '') raw[k] = v;
    });
    const parsed = querySchema.safeParse(raw);
    if (!parsed.success) {
      // 400 size_too_large surfaces explicit error code on the size field
      const sizeIssue = parsed.error.issues.find((i) => i.path[0] === 'size');
      const errorCode = sizeIssue ? 'size_too_large' : 'invalid_query';
      return jsonResponse({ error: errorCode, details: parsed.error.issues, requestId }, 400);
    }

    const { page, size } = parsed.data;
    const { rows, total } = blocklistRepo().list({ page, size });
    return jsonResponse({ rows, total, page, size, requestId }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/blocklist: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
