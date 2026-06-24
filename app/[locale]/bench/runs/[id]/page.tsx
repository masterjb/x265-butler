import { setRequestLocale } from 'next-intl/server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ensureServerInit } from '@/src/lib/server-init';
import { benchRunRepo, benchComboRepo, fileRepo } from '@/src/lib/db';
import { requireAuth, authGuard } from '@/src/lib/auth/require-auth';
import { PageContainer } from '@/components/page-layout';
import { RunDetailClient } from './run-detail-client';

export const dynamic = 'force-dynamic';

export default async function BenchRunDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  ensureServerInit();

  const h = await headers();
  const syntheticReq = new Request('https://butler/', {
    headers: { cookie: h.get('cookie') ?? '' },
  });
  const auth = await requireAuth(syntheticReq);
  const denied = authGuard(auth);
  if (denied) {
    redirect(`/${locale}/login?next=/${locale}/bench/runs/${id}`);
  }

  const runId = parseInt(id, 10);
  if (!Number.isFinite(runId) || runId <= 0) {
    return (
      <PageContainer variant="data">
        <RunDetailClient
          run={null}
          combos={[]}
          summary={[]}
          fileSizeMap={{}}
          hasPass2={false}
          locale={locale}
        />
      </PageContainer>
    );
  }

  const run = benchRunRepo().findById(runId);
  if (!run) {
    return (
      <PageContainer variant="data">
        <RunDetailClient
          run={null}
          combos={[]}
          summary={[]}
          fileSizeMap={{}}
          hasPass2={false}
          locale={locale}
        />
      </PageContainer>
    );
  }

  const combos = benchComboRepo().listByRun(runId);
  const summary = benchComboRepo().summarizeRun(runId);
  const files = fileRepo().listByIds(run.fileIds);
  const fileSizeMap: Record<number, number> = Object.fromEntries(
    files.map((f) => [f.id, f.size_bytes]),
  );
  const hasPass2 = combos.some((c) => c.pass2_completed_at !== null);

  return (
    <PageContainer variant="data">
      <RunDetailClient
        run={run}
        combos={combos}
        summary={summary}
        fileSizeMap={fileSizeMap}
        hasPass2={hasPass2}
        locale={locale}
      />
    </PageContainer>
  );
}
