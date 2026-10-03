// 15-01: GET /api/storage/shares-table — per-share aggregation row + orphan.
//
// Always cross-share (no `share` query-param). Orphan row (share_id IS NULL)
// appended last with SR3 pinned shape when orphan files exist.

import { storageRepo } from '@/src/lib/db';
import {
  authGate,
  buildStorageContext,
  errorBody,
  jsonResponse,
  logQueryExecuted,
} from '@/src/lib/api/storage-route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ENDPOINT = 'shares-table';

export async function GET(request: Request): Promise<Response> {
  const ctx = buildStorageContext(ENDPOINT);

  const denied = await authGate(request, ctx);
  if (denied) return denied;

  const startedAt = Date.now();
  try {
    const rows = storageRepo().getSharesTable();
    logQueryExecuted(ctx, ENDPOINT, { share: 'all', rowCount: rows.length }, startedAt);
    return jsonResponse(
      {
        rows,
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
