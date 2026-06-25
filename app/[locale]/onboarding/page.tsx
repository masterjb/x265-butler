import { redirect } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { fileRepo, settingRepo, shareRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { PageContainer } from '@/components/page-layout';
import { OnboardingClient } from './onboarding-client';

// 03-05 Plan Task 2 — wizard Server Component.
// audit M7: explicit nodejs runtime — imports better-sqlite3 via @/src/lib/db.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function OnboardingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  ensureServerInit();

  // audit M3: DB-error safe fallback — wizard cannot self-recover from broken DB.
  // Read all state inside try{}; redirect() calls live OUTSIDE so the
  // NEXT_REDIRECT internal throw is not swallowed by the catch block.
  let onboardingDone = false;
  let fileCount = 0;
  let settings: {
    scan_root: string;
    min_size_mb: string;
    crf_libx265: string;
    crf_nvenc: string;
    crf_qsv: string;
    crf_vaapi: string;
  } | null = null;
  let dbErrored = false;
  // 20-01: server-side detection — pure DB-read (no fs IO at render-path).
  // Server-side invariant (audit M2): autoSkipPathsStep===true IMPLIES
  // placeholderSharePath is a non-null absolute path; computed jointly below.
  let autoSkipPathsStep = false;
  let placeholderSharePath: string | null = null;
  let placeholderShareId: number | null = null;
  try {
    onboardingDone = settingRepo().get('onboarding_completed') === 'true';
    if (!onboardingDone) {
      fileCount = fileRepo().count();
      // 14-04 (Plan 14-04 Task 7): scan_root + min_size_mb sourced from
      // shareRepo placeholder (14-01 backfill) instead of the retired
      // setting.* keys. When shareRepo is empty, fall back to '/media' / '50'
      // defaults so the wizard still pre-fills sensibly.
      const placeholderShare = shareRepo().listAll()[0];
      settings = {
        scan_root: placeholderShare?.path ?? '/media',
        min_size_mb: String(placeholderShare?.min_size_mb ?? 50),
        crf_libx265: settingRepo().get('crf_libx265') ?? '23',
        crf_nvenc: settingRepo().get('crf_nvenc') ?? '23',
        crf_qsv: settingRepo().get('crf_qsv') ?? '22',
        crf_vaapi: settingRepo().get('crf_vaapi') ?? '22',
      };
      if (
        placeholderShare !== undefined &&
        typeof placeholderShare.path === 'string' &&
        placeholderShare.path.length > 0 &&
        placeholderShare.path.startsWith('/')
      ) {
        autoSkipPathsStep = true;
        placeholderSharePath = placeholderShare.path;
        placeholderShareId = placeholderShare.id;
      }
    }
  } catch (err) {
    logger.error(
      {
        action: 'wizard_page_db_error',
        err: err instanceof Error ? err.stack : String(err),
      },
      '/onboarding: DB read failed — falling through to /library',
    );
    dbErrored = true;
  }

  if (dbErrored || onboardingDone) {
    // CONTEXT §3: short-circuit when already done; M3: safe fallback on DB error.
    redirect(`/${locale}/library`);
  }

  // audit S4: wizard_entered audit-trail — incident reconstruction
  // ("operator says wizard never appeared") needs a log line per render.
  // 20-01 (audit S1+S10): enriched with autoSkipPathsStep + share_id +
  // placeholderSharePath — single source of truth, easier correlation.
  logger.info(
    {
      action: 'wizard_entered',
      locale,
      fileCount,
      autoSkipPathsStep,
      share_id: placeholderShareId,
      placeholderSharePath,
    },
    'first-run wizard rendered',
  );

  return (
    <PageContainer variant="centered">
      <OnboardingClient
        initialSettings={settings!}
        locale={locale}
        autoSkipPathsStep={autoSkipPathsStep}
        placeholderSharePath={placeholderSharePath}
      />
    </PageContainer>
  );
}
