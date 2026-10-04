'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { CirclePause, Gauge, Settings2 } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// 52-04 (AC-8): shown on the dashboard while the auto_encode master switch is
// OFF and files are waiting. Informational, not a warning: OFF is the fresh-
// install default and a legitimate choice, so it uses the primary-tinted
// callout (same surface as the onboarding AutoScanAwareness), not amber.
// Pure leaf: receives numbers as props, no server imports.

export function AutoEncodeOffCard({ pendingFiles }: { pendingFiles: number }) {
  const t = useTranslations('dashboard.autoEncodeOff');
  const locale = useLocale();

  return (
    <section
      data-testid="dashboard-auto-encode-off"
      role="status"
      aria-labelledby="auto-encode-off-heading"
      className="mb-6 flex flex-col gap-3 rounded-lg border border-primary/20 bg-card p-4 md:flex-row md:items-center md:justify-between"
    >
      <div className="flex items-start gap-3">
        <CirclePause aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="flex flex-col gap-1">
          <h2 id="auto-encode-off-heading" className="text-sm font-semibold text-foreground">
            {t('title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('body', { count: pendingFiles })}</p>
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row md:shrink-0">
        <Link
          href={`/${locale}/bench`}
          className={cn(buttonVariants({ variant: 'outline' }), 'h-11 gap-2 px-4 lg:h-9')}
        >
          <Gauge aria-hidden="true" />
          {t('benchLink')}
        </Link>
        <Link
          href={`/${locale}/settings#auto-encode`}
          className={cn(buttonVariants({ variant: 'default' }), 'h-11 gap-2 px-4 lg:h-9')}
        >
          <Settings2 aria-hidden="true" />
          {t('settingsLink')}
        </Link>
      </div>
    </section>
  );
}
