'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

// 16-03 — Onboarding Auto-Scan Awareness surface (route-callout-on-done).
// Renders inside QualityStep above the Finish CTA. Triple-channel encoding
// per AC-5: color (semantic primary) + Lucide:Zap icon + explicit text-label.
// Deep-link to /[locale]/settings#auto-scan-advanced — 20-02 flip to land on
// the advanced Collapsible directly (auto-open via hash-detection in
// AutoScanAdvanced). Wrapper-only per 16-03 AC-4 (M1) preserved.

const TESTID = 'onboarding-autoscan-awareness';

export function AutoScanAwareness({
  onDeepLinkClick,
}: {
  // 16-03 deep-link state-loss fix: parent stashes wizard state BEFORE
  // navigation away. Optional — surface remains usable without persistence
  // wiring (e.g. unit-test isolation).
  onDeepLinkClick?: () => void;
} = {}) {
  const t = useTranslations('onboarding');
  const locale = useLocale();

  return (
    <div
      data-testid={TESTID}
      role="region"
      aria-labelledby="autoscan-awareness-heading"
      className={cn('flex flex-col gap-3 rounded-lg border border-primary/20 bg-card p-4')}
    >
      <div className="flex items-center gap-2">
        <Zap aria-label={t('autoScan.iconLabel')} className="h-5 w-5 shrink-0 text-primary" />
        <h2 id="autoscan-awareness-heading" className="text-sm font-semibold text-foreground">
          {t('autoScan.heading')}
        </h2>
      </div>
      <ul className="flex flex-col gap-1.5 pl-7 text-sm text-foreground">
        <li className="list-disc">{t('autoScan.bodyAutoScanOn')}</li>
        <li className="list-disc">{t('autoScan.bodyBootScan')}</li>
        <li className="list-disc">{t('autoScan.bodyAdvancedOptions')}</li>
      </ul>
      <Link
        href={`/${locale}/settings#auto-scan-advanced`}
        onClick={onDeepLinkClick}
        className={cn(
          'inline-flex h-11 items-center self-start rounded-md px-3 text-sm font-medium',
          'text-primary underline-offset-4 hover:underline',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        {t('autoScan.deepLinkLabel')}
      </Link>
    </div>
  );
}
