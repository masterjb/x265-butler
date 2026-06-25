// Phase 21 Plan 21-02 — /[locale]/diagnostics Server Component.
//
// audit-M2: Server-Component auth-mirror gate runs BEFORE assembleDiagnostics()
// AND BEFORE logger.info — otherwise gitHash + image-digest + mount-paths +
// recentErrors leak to unauthenticated browsers when auth_enabled='true'.
// Synthetic Request is built from next/headers cookies() since requireAuth
// expects a standard Request shape (cookie header → parseSessionCookie).

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { getTranslations } from 'next-intl/server';
import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';
import { assembleDiagnostics } from '@/src/lib/diagnostics/aggregator';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { DiagnosticsClient } from '@/components/diagnostics/diagnostics-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function buildSyntheticRequest(): Promise<Request> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  return new Request('http://internal/diagnostics-server-component', {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
}

export default async function DiagnosticsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  ensureServerInit();

  const syntheticReq = await buildSyntheticRequest();
  const auth = await requireAuth(syntheticReq);
  const denied = authGuard(auth);
  if (denied) {
    redirect(`/${locale}/login?next=/${locale}/diagnostics`);
  }

  const payload = await assembleDiagnostics();

  logger.info(
    {
      event: 'diagnosticsPageOpened',
      source: 'page-server-component',
      warningCount: payload.warnings.length,
      recentErrorCount: payload.recentErrors.length,
    },
    'diagnostics.page.opened',
  );

  const t = await getTranslations('diagnostics');

  return (
    <div className="container mx-auto max-w-6xl px-4 py-6 md:py-8">
      <header className="mb-6 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            {t('title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
      </header>
      <DiagnosticsClient initialPayload={payload} />
    </div>
  );
}
