// 15-01: GET /api/storage/kpis — Storage-Analyzer headline KPIs.
//
// Body: totalSizeBytes + largestFolder (depth=1 cross/share) + mostOptimizedShare
// (ALWAYS cross-share per A6) + legacyCodecPercent + computedAt + dataAsOf.
// Auth-gated; share=<unknown> reflect-supplied → 200 + canonical empty.

import { z } from 'zod';
import { shareRepo, storageRepo } from '@/src/lib/db';
import {
  authGate,
  buildStorageContext,
  errorBody,
  invalidQueryResponse,
  jsonResponse,
  logQueryExecuted,
  logShareUnknown,
} from '@/src/lib/api/storage-route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENDPOINT = 'kpis';

const querySchema = z.object({
  share: z
    .union([z.literal('all'), z.coerce.number().int().positive()])
    .optional()
    .catch('all'),
});

export async function GET(request: Request): Promise<Response> {
  const ctx = buildStorageContext(ENDPOINT);

  const denied = await authGate(request, ctx);
  if (denied) return denied;

  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    if (v !== '') raw[k] = v;
  });
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    return invalidQueryResponse(ctx, parsed.error.issues.map((i) => i.message).join('; '));
  }
  const shareParam: 'all' | number = parsed.data.share ?? 'all';

  if (typeof shareParam === 'number') {
    const known = shareRepo().listAll();
    if (!known.some((s) => s.id === shareParam)) {
      logShareUnknown(
        ctx,
        ENDPOINT,
        shareParam,
        known.map((s) => s.id),
      );
    }
  }

  const startedAt = Date.now();
  try {
    const kpis = storageRepo().getKpis({ shareId: shareParam });
    logQueryExecuted(ctx, ENDPOINT, { share: shareParam, rowCount: 1 }, startedAt);
    return jsonResponse(
      {
        ...kpis,
        effectiveFilters: { share: shareParam },
        computedAt: ctx.computedAt,
        dataAsOf: ctx.computedAt,
        requestId: ctx.requestId,
      },
      200,
    );
  } catch (err) {
    ctx.log.error({ err: err instanceof Error ? err.stack : String(err) }, 'storage_query_error');
    return jsonResponse(errorBody('internal_error', 'unexpected error', ctx.requestId), 500);
  }
}
