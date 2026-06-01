import { statsRepo } from '@/src/lib/db';
import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';
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

// GET /api/stats — dashboard aggregation endpoint.
// Returns cumulative savings, per-encoder breakdown, daily trend, top savers,
// and the 10-01 3-bucket savings analysis + efficiency rate.
export async function GET(request: Request): Promise<Response> {
  const __auth = await requireAuth(request);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  ensureServerInit();

  try {
    const repo = statsRepo();
    const now = Math.floor(Date.now() / 1000);
    const kpis = repo.getKpis(now);
    const dailyTrend = repo.getTrend30dFull(now);
    const topSavers = repo.getTopSavers(10);
    const savingsBuckets = repo.getSavingsBuckets();
    const efficiencyRate = repo.getEncodeEfficiencyRate();

    return jsonResponse(
      {
        cumulativeSavingsBytes: String(kpis.totalSaved),
        perEncoder: kpis.byEncoder,
        dailyTrend,
        topSavers,
        savingsBuckets,
        efficiencyRate,
      },
      200,
    );
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'internal_error' }, 500);
  }
}
