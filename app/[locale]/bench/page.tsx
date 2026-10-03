import { setRequestLocale } from 'next-intl/server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ensureServerInit } from '@/src/lib/server-init';
import { benchRunRepo, benchComboRepo, settingRepo } from '@/src/lib/db';
import { requireAuth, authGuard } from '@/src/lib/auth/require-auth';
import { PageContainer } from '@/components/page-layout';
import { pickTop3 } from '@/src/lib/bench/pareto';
import { BenchClient } from './bench-client';
import type { BenchDefaults } from '@/components/bench/bench-defaults';
import type { TopBalancedSummary } from '@/components/bench/bench-history-table';

export const dynamic = 'force-dynamic';

const HISTORY_PAGE_SIZE = 50;

export default async function BenchPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  ensureServerInit();

  const h = await headers();
  const syntheticReq = new Request('https://butler/', {
    headers: { cookie: h.get('cookie') ?? '' },
  });
  const auth = await requireAuth(syntheticReq);
  const denied = authGuard(auth);
  if (denied) {
    redirect(`/${locale}/login?next=/${locale}/bench`);
  }

  const recentRuns = benchRunRepo().listRecent(HISTORY_PAGE_SIZE, 0);
  const historyTotalCount = benchRunRepo().countAll();

  const topBalancedByRunId: Record<number, TopBalancedSummary | null> = {};
  for (const run of recentRuns) {
    if (run.status !== 'complete') {
      topBalancedByRunId[run.id] = null;
      continue;
    }
    const summary = benchComboRepo().summarizeRun(run.id);
    const front = summary.filter((c) => c.is_pareto).sort((a, b) => a.sizeBytes - b.sizeBytes);
    const top3 = pickTop3(front);
    if (!top3) {
      topBalancedByRunId[run.id] = null;
      continue;
    }
    topBalancedByRunId[run.id] = {
      encoder: top3.balanced.encoder,
      preset: top3.balanced.preset,
      qualityValue: top3.balanced.native_quality_value.toString(),
      vmaf: top3.balanced.vmaf,
    };
  }

  const repo = settingRepo();
  // 11-06: 8 von 8 non-file Bench-Settings exposed (shared BenchDefaults type).
  const modeRaw = repo.get('bench_default_mode');
  const defaults: BenchDefaults = {
    mode: modeRaw === 'vmaf-anchored' ? 'vmaf-anchored' : 'native-sweep',
    encoders: (repo.get('bench_default_encoders') ?? 'libx265').split(','),
    presets: (repo.get('bench_default_presets') ?? 'veryfast,medium,slow').split(','),
    nativeValues: repo.get('bench_default_native_values') ?? '23,28',
    sampleCount: parseInt(repo.get('bench_sample_count') ?? '3', 10),
    sampleDurationSec: parseInt(repo.get('bench_sample_duration_seconds') ?? '20', 10),
    vmafModel: repo.get('bench_vmaf_model') ?? 'vmaf_v0.6.1',
    vmafBuckets: repo.get('bench_vmaf_buckets') ?? '95,92,88',
  };

  return (
    <PageContainer variant="data">
      <BenchClient
        initialRuns={recentRuns}
        defaults={defaults}
        locale={locale}
        historyTotalCount={historyTotalCount}
        topBalancedByRunId={topBalancedByRunId}
      />
    </PageContainer>
  );
}
