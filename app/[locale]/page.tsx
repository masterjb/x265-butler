import { redirect } from 'next/navigation';
import { fileRepo, settingRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

// 03-05 Plan Task 1 — empty-DB gate for first-run wizard.
// 05-10 Plan B6 — populated-DB happy-path now lands on /dashboard, not
// /library. The catch branch keeps the audit-M3 /library fallback so a
// broken DB doesn't push the user into Dashboard's KPI repo reads.
// audit M7: explicit nodejs runtime — Server Component imports better-sqlite3
// via @/src/lib/db; without this export some build configs may attempt edge
// runtime → import crash on better-sqlite3.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function LocaleRoot({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  ensureServerInit();

  // 05-10 audit M2: explicit 3-branch shape with separate dbError flag.
  // Pre-05-10 code used isEmpty=false default + no dbError tracking, so a DB
  // error silently fell through to whatever the bottom branch was. With the
  // bottom branch now being /dashboard, that would cascade into another
  // statsRepo failure. The dbError boolean separates "no files yet" from
  // "cannot read DB" so the M3 /library fallback fires only on the latter.
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
      'root redirect: DB read failed — falling through to /library (audit-M3 fallback; Dashboard skipped because KPI repos require healthy DB)',
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
