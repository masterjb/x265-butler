// 15-01: GET /api/storage/codec-pie — codec distribution (current-state only).
//
// Body: codecs[] + note (Q2 fallback — pre-encode codec column not persisted)
// + effectiveFilters.share + computedAt + dataAsOf.

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

const ENDPOINT = 'codec-pie';
const NOTE = 'current-state codec only; pre-encode codec column not persisted (deferred)';

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
    const codecs = storageRepo().getCodecPie({ shareId: shareParam });
    logQueryExecuted(ctx, ENDPOINT, { share: shareParam, rowCount: codecs.length }, startedAt);
    return jsonResponse(
      {
        codecs,
        note: NOTE,
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
