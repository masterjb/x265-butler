// 03-04 Plan Task 2 — Dashboard Server Component.
//
// Audit M5: Direct repo calls. NO HTTP self-fetch. NO header reads for
// self-routing. Each card-read is wrapped in try/catch returning null on
// failure (per-card error path per dashboard.md §10.4 + audit S12 pino warn).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { setRequestLocale } from 'next-intl/server';
import {
  computePerEncoderLimits,
  detectEncoders,
  getFfmpegVersionCached,
  ENCODER_IDS,
  type EncoderId,
} from '@/src/lib/encode';
import { getDbPath, jobRepo, settingRepo, statsRepo } from '@/src/lib/db';
import { ensureServerInit } from '@/src/lib/server-init';
import { logger } from '@/src/lib/logger';
import { PageContainer } from '@/components/page-layout';
import { DashboardClient } from './dashboard-client';

export const dynamic = 'force-dynamic';

// 22-01 IMP-1: slow_request threshold (ms). Module-const; operator-config deferred.
const SLOW_REQUEST_MS = 1000;

// 22-01 IMP-1: per-method timing accumulator passed into card-readers so the
// page-level slow_request breakdown matches Plan's named keys.
type TimingBag = Record<string, number>;

function safeStat(p: string): number | null {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

interface StatsBundle {
  kpis: {
    totalSaved: number;
    filesProcessed: number;
    avgSavingsPercent: number;
    cumulativeThroughputPerDay: number;
    queueDepth: { pending: number; encoding: number };
    byEncoder: Record<string, { count: number; saved: number }>;
  };
  trend: { date: string; bytesIn: number; bytesOut: number; savings: number }[];
  recentActivity: import('@/src/lib/db').RecentActivityRow[];
  system: {
    cpuCount: number;
    perEncoderLimits: Record<string, number>;
    ffmpegVersion: string | null;
    cachePoolPath: string | null;
    dbSizeBytes: number | null;
  };
}

async function readStatsAndSystem(requestId: string, bag: TimingBag): Promise<StatsBundle | null> {
  const log = logger.child({ requestId, route: '/dashboard:server', card: 'stats' });
  try {
    const now = Math.floor(Date.now() / 1000); // audit M1: single-now
    const repo = statsRepo();

    const t_k = performance.now();
    const kpisRaw = repo.getKpis(now);
    bag.kpis = performance.now() - t_k;

    const t_q = performance.now();
    const queueDepth = {
      pending: jobRepo().countByStatus('queued'),
      encoding: jobRepo().countByStatus('encoding'),
    };
    bag.queueDepth = performance.now() - t_q;

    const t_t = performance.now();
    const trend = repo.getTrend30d(now);
    bag.trend = performance.now() - t_t;

    const t_r = performance.now();
    const recentActivity = repo.getRecentActivity(10);
    bag.recentActivity = performance.now() - t_r;

    const t_s = performance.now();
    const limits = computePerEncoderLimits({
      concurrency: settingRepo().get('concurrency'),
      cpuCount: os.cpus().length,
    });
    const perEncoderLimits: Record<string, number> = { ...limits };
    const system = {
      cpuCount: os.cpus().length,
      perEncoderLimits,
      ffmpegVersion: getFfmpegVersionCached(), // audit M3 — cached, no spawn
      cachePoolPath: settingRepo().get('cache_pool_path') ?? null, // audit S6
      dbSizeBytes: safeStat(getDbPath()), // audit M2
    };
    bag.settingGet = (bag.settingGet ?? 0) + (performance.now() - t_s);

    return {
      kpis: { ...kpisRaw, queueDepth },
      trend,
      recentActivity,
      system,
    };
  } catch (err) {
    log.warn(
      { action: 'dashboard_card_error', err: err instanceof Error ? err.message : String(err) },
      'dashboard stats card error',
    );
    return null;
  }
}

interface QueueStatusBundle {
  paused: boolean;
  activeJobs: number;
  pendingJobs: number;
  encodingJobs: number;
}

async function readQueueStatus(
  requestId: string,
  bag: TimingBag,
): Promise<QueueStatusBundle | null> {
  const log = logger.child({ requestId, route: '/dashboard:server', card: 'queue' });
  try {
    const t_q = performance.now();
    const result = {
      // 05-09 Decision §2/§3: Pause retired — paused permanently false
      // (kept on the bundle shape for back-compat with DashboardClient until
      // its own consumer site is migrated).
      paused: false,
      activeJobs: jobRepo().listActive().length,
      encodingJobs: jobRepo().countByStatus('encoding'),
      pendingJobs: jobRepo().countByStatus('queued'),
    };
    bag.queueDepth = (bag.queueDepth ?? 0) + (performance.now() - t_q);
    return result;
  } catch (err) {
    log.warn(
      { action: 'dashboard_card_error', err: err instanceof Error ? err.message : String(err) },
      'dashboard queue card error',
    );
    return null;
  }
}

interface EncoderBundle {
  detected: EncoderId[];
  active: EncoderId;
  resolution: 'auto' | 'override' | 'fallback';
  requestedButUnavailable?: EncoderId;
  devicePath?: string;
}

async function readEncoders(requestId: string, bag: TimingBag): Promise<EncoderBundle | null> {
  const log = logger.child({ requestId, route: '/dashboard:server', card: 'encoders' });
  try {
    const t_d = performance.now();
    const det = await detectEncoders();
    bag.encoderDetect = performance.now() - t_d;

    const t_s = performance.now();
    const requestedRaw = settingRepo().get('encoder');
    bag.settingGet = (bag.settingGet ?? 0) + (performance.now() - t_s);

    const requested: EncoderId | 'auto' =
      !requestedRaw || requestedRaw === 'auto'
        ? 'auto'
        : (ENCODER_IDS as readonly string[]).includes(requestedRaw)
          ? (requestedRaw as EncoderId)
          : 'auto';
    let active: EncoderId;
    let resolution: 'auto' | 'override' | 'fallback';
    let requestedButUnavailable: EncoderId | undefined;
    if (requested === 'auto') {
      active = det.activeFromAuto;
      resolution = 'auto';
    } else if (det.detected.includes(requested)) {
      active = requested;
      resolution = 'override';
    } else {
      requestedButUnavailable = requested;
      active = 'libx265';
      resolution = 'fallback';
    }
    return {
      detected: det.detected,
      active,
      resolution,
      requestedButUnavailable,
      devicePath: det.vaapiDevice,
    };
  } catch (err) {
    log.warn(
      { action: 'dashboard_card_error', err: err instanceof Error ? err.message : String(err) },
      'dashboard encoders card error',
    );
    return null;
  }
}

export default async function DashboardPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  ensureServerInit();
  const requestId = crypto.randomUUID();

  // 22-01 IMP-1 (audit-SR4): timed Promise.all + slow_request emit.
  // Per-method timing accumulates into `bag`; page-level wraps Promise.all in
  // try/catch for error-path observability. Each readX still has internal
  // try/catch returning null (existing audit M5 contract preserved).
  const bag: TimingBag = {};
  const t0 = performance.now();
  let stats: StatsBundle | null;
  let queueStatus: QueueStatusBundle | null;
  let encoders: EncoderBundle | null;
  try {
    [stats, queueStatus, encoders] = await Promise.all([
      readStatsAndSystem(requestId, bag),
      readQueueStatus(requestId, bag),
      readEncoders(requestId, bag),
    ]);
  } catch (err) {
    const totalMs = performance.now() - t0;
    logger.warn(
      {
        action: 'slow_request_failed',
        route: '/dashboard',
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
        route: '/dashboard',
        durationMs: totalMs,
        breakdown: bag,
      },
      'slow_request',
    );
  }

  return (
    <PageContainer variant="data">
      <DashboardClient
        initialStats={stats}
        initialQueueStatus={queueStatus}
        initialEncoders={encoders}
        requestId={requestId}
      />
    </PageContainer>
  );
}
