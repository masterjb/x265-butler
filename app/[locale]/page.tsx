import { redirect } from 'next/navigation';
import { fileRepo, settingRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

// Empty-DB gate for the first-run wizard. A populated DB lands on /dashboard.
// The catch branch falls back to /library so a broken DB doesn't push the
// user into Dashboard's KPI repo reads.
// Explicit nodejs runtime: the Server Component imports better-sqlite3
// via @/src/lib/db; without this export some build configs may attempt edge
// runtime → import crash on better-sqlite3.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function LocaleRoot({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  ensureServerInit();

  // Explicit 3-branch shape with a separate dbError flag. Without it a DB
  // error would fall through to the bottom branch, /dashboard, and cascade
  // into another statsRepo failure. The dbError boolean separates "no files
  // yet" from "cannot read DB" so the /library fallback fires only on the
  // latter.
  let isEmpty = false;
  let dbError = false;
  try {
    const fileCount = fileRepo().count();
    const onboardingDone = settingRepo().get('onboarding_completed') === 'true';
    isEmpty = fileCount === 0 && !onboardingDone;
  } catch (err) {
    dbError = true;
    logger.error(
      {
        action: 'onboarding_gate_db_error',
        err: err instanceof Error ? err.stack : String(err),
      },
      'root redirect: DB read failed — falling through to /library (Dashboard skipped because KPI repos require healthy DB)',
    );
  }

  if (isEmpty) {
    redirect(`/${locale}/onboarding`);
  } else if (dbError) {
    redirect(`/${locale}/library`);
  } else {
    redirect(`/${locale}/dashboard`);
  }
}
