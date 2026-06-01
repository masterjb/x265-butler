import crypto from 'node:crypto';
import { z } from 'zod';
import { trashRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// audit-added S9: zod-parsed query params (replaces parseInt + Math.min which
// silently coerces NaN to defaults and accepts unknown keys).
const querySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    size: z.coerce.number().int().positive().max(200).default(50),
  })
  .strict();

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

// GET /api/trash?page=N&size=M — paginated trash listing.
export async function GET(request: Request): Promise<Response> {
  // 05-01 Plan T3: requireAuth gate.
  const __auth = await requireAuth(request);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/trash' });

  try {
    const url = new URL(request.url);
    const raw: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      if (v !== '') raw[k] = v;
    });
    const parsed = querySchema.safeParse(raw);
    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues }, 'invalid pagination');
      return jsonResponse(
        { error: 'invalid_pagination', details: parsed.error.issues, requestId },
        400,
      );
    }
    const { page, size } = parsed.data;

    const repo = trashRepo();
    const { rows } = repo.list({ page, size });
    const total = repo.count();
    const totalPages = total === 0 ? 1 : Math.ceil(total / size);

    return jsonResponse({ rows, page, size, total, totalPages, requestId }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/trash: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
