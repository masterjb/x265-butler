import { setRequestLocale } from 'next-intl/server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ensureServerInit } from '@/src/lib/server-init';
import { benchRunRepo, benchComboRepo, fileRepo } from '@/src/lib/db';
import { requireAuth, authGuard } from '@/src/lib/auth/require-auth';
import { PageContainer } from '@/components/page-layout';
import { CompareClient, type CompareEntry } from './compare-client';

export const dynamic = 'force-dynamic';

export default async function BenchComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ ids?: string }>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  setRequestLocale(locale);
  ensureServerInit();

  const h = await headers();
  const idsRaw = sp.ids ?? '';
  const syntheticReq = new Request('https://butler/', {
    headers: { cookie: h.get('cookie') ?? '' },
  });
  const auth = await requireAuth(syntheticReq);
  const denied = authGuard(auth);
  if (denied) {
    const nextPath = `/${locale}/bench/compare?ids=${encodeURIComponent(idsRaw)}`;
    redirect(`/${locale}/login?next=${nextPath}`);
  }

  const rawIds = idsRaw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  const parsed = Array.from(new Set(rawIds));

  if (parsed.length < 2 || parsed.length > 3) {
    redirect(`/${locale}/bench?tab=history`);
  }

  const entries: CompareEntry[] = parsed.map((id) => {
    const run = benchRunRepo().findById(id);
    if (run === null) {
      return { id, run: null, summary: [] };
    }
    const summary = benchComboRepo().summarizeRun(id);
    return { id, run, summary };
  });

  const allFileIds = new Set<number>();
  for (const e of entries) {
    if (e.run !== null) {
      for (const fid of e.run.fileIds) allFileIds.add(fid);
    }
  }
  const files = fileRepo().listByIds([...allFileIds]);
  const fileSizeMap: Record<number, number> = Object.fromEntries(
    files.map((f) => [f.id, f.size_bytes]),
  );

  const missingIds = entries.filter((e) => e.run === null).map((e) => e.id);

  return (
    <PageContainer variant="data">
      <CompareClient
        entries={entries}
        missingIds={missingIds}
        fileSizeMap={fileSizeMap}
        locale={locale}
      />
    </PageContainer>
  );
}
