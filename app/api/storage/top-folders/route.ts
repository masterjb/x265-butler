// 15-01: GET /api/storage/top-folders?depth=N&share=ID|all — top-10 folders
// by sizeBytes at the requested folder depth. Pre-aggregate row-cap (SR1)
// surfaces via `truncated:true` when worst-case scan hit 50_000 rows.

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

const ENDPOINT = 'top-folders';
const RESULT_LIMIT = 10;

const querySchema = z.object({
  share: z
    .union([z.literal('all'), z.coerce.number().int().positive()])
    .optional()
    .catch('all'),
  depth: z.coerce.number().int().min(1).max(5).default(2),
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
  const depth = parsed.data.depth;

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
    const result = storageRepo().getTopFolders({
      shareId: shareParam,
      depth,
      limit: RESULT_LIMIT,
    });
    logQueryExecuted(
      ctx,
      ENDPOINT,
      { share: shareParam, depth, rowCount: result.rows.length },
      startedAt,
    );
    return jsonResponse(
      {
        rows: result.rows,
        depth,
        share: shareParam,
        truncated: result.truncated,
        effectiveFilters: { share: shareParam, depth },
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
