import { statsRepo } from '@/src/lib/db';
import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
import { ensureServerInit } from '@/src/lib/server-init';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/stats — dashboard aggregation endpoint.
// Returns cumulative savings, per-encoder breakdown, daily trend, top savers,
// and the 10-01 3-bucket savings analysis + efficiency rate.
export async function GET(request: Request): Promise<Response> {
  const { denied } = await gateAuth(request);
  if (denied) return denied;

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
