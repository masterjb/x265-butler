'use client';

// 03-04 Plan Task 2 — Dashboard Client Component (orchestrates 6 KPI + chart + cards).
// Audit M4: 'use client' first line.

import { useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/page-layout';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { SavingsTrendChart } from '@/components/dashboard/savings-trend-chart';
import { LiveQueueCard } from '@/components/dashboard/live-queue-card';
import { RecentActivity } from '@/components/dashboard/recent-activity';
import { SystemInfoCard } from '@/components/dashboard/system-info-card';
import type { RecentActivityRow } from '@/src/lib/db';

interface StatsShape {
  kpis: {
    totalSaved: number;
    filesProcessed: number;
    avgSavingsPercent: number;
    cumulativeThroughputPerDay: number;
    queueDepth: { pending: number; encoding: number };
    byEncoder: Record<string, { count: number; saved: number }>;
  };
  trend: { date: string; bytesIn: number; bytesOut: number; savings: number }[];
  recentActivity: RecentActivityRow[];
  system: {
    cpuCount: number;
    perEncoderLimits: Record<string, number>;
    ffmpegVersion: string | null;
    cachePoolPath: string | null;
    dbSizeBytes: number | null;
  };
}

interface QueueStatusShape {
  paused: boolean;
  activeJobs: number;
  pendingJobs: number;
  encodingJobs: number;
}

interface EncoderShape {
  detected: string[];
  active: string;
  resolution: 'auto' | 'override' | 'fallback';
  requestedButUnavailable?: string;
  devicePath?: string;
}

interface Props {
  initialStats: StatsShape | null;
  initialQueueStatus: QueueStatusShape | null;
  initialEncoders: EncoderShape | null;
  requestId: string;
}

const REFRESH_INTERVAL_MS = 30_000;

export function DashboardClient({ initialStats, initialQueueStatus, initialEncoders }: Props) {
  const t = useTranslations('dashboard');
  const router = useRouter();
  const [, startTransition] = useTransition();

  // Re-fetch via router.refresh every 30s — re-runs the Server Component
  // which re-runs direct repo reads (audit M5 — no client-side HTTP).
  useEffect(() => {
    const handle = setInterval(() => {
      startTransition(() => router.refresh());
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [router]);

  // Encoder state shape adapts to KpiCard's narrower input
  const encoderState = initialEncoders
    ? {
        active: initialEncoders.active,
        resolution: initialEncoders.resolution,
        requestedButUnavailable: initialEncoders.requestedButUnavailable,
      }
    : null;

  return (
    <>
      <PageHeader title={t('title')} subhead={t('subhead')} />
      {/* KPI row — responsive collapse 6→3→2→1 per dashboard.md §3 */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard kind="totalSaved" stats={initialStats} />
        <KpiCard kind="filesProcessed" stats={initialStats} />
        <KpiCard kind="avgSavings" stats={initialStats} />
        <KpiCard kind="activeEncoder" encoders={encoderState} />
        <KpiCard kind="queueDepth" stats={initialStats} />
        <KpiCard kind="throughput" stats={initialStats} />
      </section>

      {/* Middle row — chart 2/3 + Live Queue 1/3 on lg per dashboard.md §2 */}
      <section className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SavingsTrendChart stats={initialStats} />
        </div>
        <LiveQueueCard initialQueueStatus={initialQueueStatus} />
      </section>

      {/* Bottom row — Recent Activity + System Info */}
      <section className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RecentActivity stats={initialStats} />
        <SystemInfoCard stats={initialStats} encoders={initialEncoders} />
      </section>
    </>
  );
}
