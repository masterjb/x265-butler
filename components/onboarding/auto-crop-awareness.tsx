'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Crop } from 'lucide-react';
import { cn } from '@/lib/utils';

// 35-02 — Onboarding Auto-Crop Awareness surface. Mirrors AutoScanAwareness in
// structure (role=region, aria-labelledby, triple-channel: color + Lucide:Crop
// icon + text). Renders inside EncoderStep. Awareness-ONLY: it informs that
// auto-crop / black-bar removal exists in Settings; it toggles nothing and adds
// NO onboarding-draft state (D2 — draft FROZEN).
//
// AUDIT SR-2 (wizard-state preservation): the deep-link MUST open in a NEW tab
// (target="_blank" rel="noopener noreferrer"). AutoScanAwareness lands in
// QualityStep (near Finish) and stashes wizard state via onDeepLinkClick; this
// callout lands in EncoderStep (mid-wizard step 4) which has NO onDeepLinkClick
// stash wiring, so a SAME-TAB nav to /settings would destroy in-flight onboarding
// state (detection payload + draft). New-tab nav side-steps this entirely.

const TESTID = 'onboarding-autocrop-awareness';

export function AutoCropAwareness() {
  const t = useTranslations('onboarding');
  const locale = useLocale();

  return (
    <div
      data-testid={TESTID}
      role="region"
      aria-labelledby="autocrop-awareness-heading"
      className={cn('flex flex-col gap-3 rounded-lg border border-primary/20 bg-card p-4')}
    >
      <div className="flex items-center gap-2">
        <Crop aria-label={t('autoCrop.iconLabel')} className="h-5 w-5 shrink-0 text-primary" />
        <h2 id="autocrop-awareness-heading" className="text-sm font-semibold text-foreground">
          {t('autoCrop.heading')}
        </h2>
      </div>
      <p className="text-sm text-foreground">{t('autoCrop.body')}</p>
      <Link
        href={`/${locale}/settings#auto-crop`}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          'inline-flex h-11 items-center self-start rounded-md px-3 text-sm font-medium',
          'text-primary underline-offset-4 hover:underline',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        {t('autoCrop.deepLinkLabel')}
      </Link>
    </div>
  );
}
