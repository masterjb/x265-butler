import crypto from 'node:crypto';
import { setRequestLocale } from 'next-intl/server';
import { statsRepo } from '@/src/lib/db';
import type {
  TopSaverRow,
  EncoderPerfRow,
  StatsTrendPointFull,
  CodecDistribution,
} from '@/src/lib/db';
import { ensureServerInit } from '@/src/lib/server-init';
import { logger } from '@/src/lib/logger';
import { PageContainer } from '@/components/page-layout';
import { StatsClient } from '@/components/stats/stats-client';

export const dynamic = 'force-dynamic';

// 22-01 IMP-1: slow_request threshold (ms). Module-const; operator-config deferred.
const SLOW_REQUEST_MS = 1000;

type TimingBag = Record<string, number>;

export interface StatsPageBundle {
  topSavers: TopSaverRow[];
  encoderPerf: EncoderPerfRow[];
  trend: StatsTrendPointFull[];
  codecDistribution: CodecDistribution | null;
  resolutionDist: { bucket: string; count: number }[];
  fileStatusDist: { status: string; count: number }[];
  bitrateDist: { bucket: string; count: number }[];
  encodeSpeedRatio: { avgSpeedRatio: number; sampleSize: number };
  failedJobRate: { failRate: number; sampleSize: number };
  avgQueueWait: { avgWaitSec: number; sampleSize: number };
  skipTypeBreakdown: { status: string; count: number }[];
  allTimeJobSummary: {
    done: number;
    failed: number;
    interrupted: number;
    cancelled: number;
    total: number;
  };
  currentTrashSize: { trashBytes: number; trashCount: number };
  expiringTrash: { count: number };
  netDiskFreed: number;
}

async function readStats(requestId: string, bag: TimingBag): Promise<StatsPageBundle | null> {
  const log = logger.child({ requestId, route: '/stats:server' });
  try {
    const now = Math.floor(Date.now() / 1000);
    const repo = statsRepo();

    // 22-01 IMP-1: per-method timing. audit-M4 contract: each breakdown-key
    // here maps 1:1 to a withQueryTiming wrap in T3 (`statsRepo.<key>`).
    const t_ts = performance.now();
    const topSavers = repo.getTopSavers(10);
    bag.topSavers = performance.now() - t_ts;

    const t_ep = performance.now();
    const encoderPerf = repo.getEncoderPerf();
    bag.encoderPerf = performance.now() - t_ep;

    const t_tr = performance.now();
    const trend = repo.getTrend30dFull(now);
    bag.trend = performance.now() - t_tr;

    const t_cd = performance.now();
    const codecDistribution = repo.getCodecDistribution();
    bag.codecDistribution = performance.now() - t_cd;

    // 08-05: 10 new repo calls
    const t_rd = performance.now();
    const resolutionDist = repo.getResolutionDistribution();
    bag.resolutionDist = performance.now() - t_rd;

    const t_fd = performance.now();
    const fileStatusDist = repo.getFileStatusDistribution();
    bag.fileStatusDist = performance.now() - t_fd;

    const t_bd = performance.now();
    const bitrateDist = repo.getBitrateDistribution();
    bag.bitrateDist = performance.now() - t_bd;

    const t_es = performance.now();
    const encodeSpeedRatio = repo.getEncodeSpeedRatio();
    bag.encodeSpeedRatio = performance.now() - t_es;

    const t_fr = performance.now();
    const failedJobRate = repo.getFailedJobRate();
    bag.failedJobRate = performance.now() - t_fr;

    const t_aw = performance.now();
    const avgQueueWait = repo.getAvgQueueWait();
    bag.avgQueueWait = performance.now() - t_aw;

    const t_st = performance.now();
    const skipTypeBreakdown = repo.getSkipTypeBreakdown();
    bag.skipTypeBreakdown = performance.now() - t_st;

    const t_aj = performance.now();
    const allTimeJobSummary = repo.getAllTimeJobSummary();
    bag.allTimeJobSummary = performance.now() - t_aj;

    const t_ct = performance.now();
    const currentTrashSize = repo.getCurrentTrashSize();
    bag.currentTrashSize = performance.now() - t_ct;

    const t_et = performance.now();
    const expiringTrash = repo.getExpiringTrash(7);
    bag.expiringTrash = performance.now() - t_et;

    // C4: net disk freed = total savings − bytes still held in trash
    const t_kp = performance.now();
    const kpis = repo.getKpis(now);
    bag.kpis = performance.now() - t_kp;

    const netDiskFreed = kpis.totalSaved - currentTrashSize.trashBytes;
    return {
      topSavers,
      encoderPerf,
      trend,
      codecDistribution,
      resolutionDist,
      fileStatusDist,
      bitrateDist,
      encodeSpeedRatio,
      failedJobRate,
      avgQueueWait,
      skipTypeBreakdown,
      allTimeJobSummary,
      currentTrashSize,
      expiringTrash,
      netDiskFreed,
    };
  } catch (err) {
    log.warn(
      { action: 'stats_page_error', err: err instanceof Error ? err.message : String(err) },
      'stats page read error',
    );
    return null;
  }
}

export default async function StatsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  ensureServerInit();
  const requestId = crypto.randomUUID();

  // 22-01 IMP-1 (audit-SR4): timed read + slow_request emit. Outer try/catch
  // for cross-layer error-path observability — readStats() has its own internal
  // try/catch returning null, so this rarely fires (defensive).
  const bag: TimingBag = {};
  const t0 = performance.now();
  let data: StatsPageBundle | null;
  try {
    data = await readStats(requestId, bag);
  } catch (err) {
    const totalMs = performance.now() - t0;
    logger.warn(
      {
        action: 'slow_request_failed',
        route: '/stats',
        durationMs: totalMs,
        errorName: err instanceof Error ? err.name : 'unknown',
      },
      'slow_request_failed',
    );
    throw err;
  }

  const totalMs = performance.now() - t0;
  if (totalMs > SLOW_REQUEST_MS) {
    logger.info(
      {
        action: 'slow_request',
        route: '/stats',
        durationMs: totalMs,
        breakdown: bag,
      },
      'slow_request',
    );
  }

  return (
    <PageContainer variant="data">
      <StatsClient initialData={data} />
    </PageContainer>
  );
}
