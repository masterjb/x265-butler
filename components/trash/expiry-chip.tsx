'use client';

import { useTranslations, useLocale } from 'next-intl';
import { Clock, AlertTriangle, AlertOctagon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FormatLocale } from '@/src/lib/format';

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3_600;

export type ExpiryTier = 'safe' | 'soon' | 'urgent';

export function getExpiryTier(expiresAt: number, now: number): ExpiryTier {
  const remaining = expiresAt - now;
  if (remaining > 7 * SECONDS_PER_DAY) return 'safe';
  if (remaining >= SECONDS_PER_DAY) return 'soon';
  return 'urgent';
}

function formatExpiresAt(expiresAt: number, locale: FormatLocale): string {
  const tag = locale === 'de' ? 'de-DE' : 'en-US';
  return new Date(expiresAt * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  // simple ISO-like format; using Date.toLocaleString would vary by environment
  void tag;
}

export function ExpiryChip({
  expiresAt,
  retentionDays,
  now,
}: {
  expiresAt: number;
  retentionDays?: number;
  now?: number;
}) {
  const t = useTranslations('trash');
  const locale = useLocale() as FormatLocale;
  const currentNow = now ?? Math.floor(Date.now() / 1000);
  const tier = getExpiryTier(expiresAt, currentNow);
  const remaining = expiresAt - currentNow;

  const days = Math.floor(remaining / SECONDS_PER_DAY);
  const hours = Math.floor(remaining / SECONDS_PER_HOUR);

  let label: string;
  let Icon: typeof Clock;
  let chipClass: string;

  if (tier === 'urgent') {
    label = t('expiry.urgentLabel', { hours: Math.max(0, hours) });
    Icon = AlertOctagon;
    chipClass = 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300';
  } else if (tier === 'soon') {
    label = t('expiry.soonLabel', { days: Math.max(0, days) });
    Icon = AlertTriangle;
    chipClass = 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300';
  } else {
    label = t('expiry.safeLabel', { days: Math.max(0, days) });
    Icon = Clock;
    chipClass = 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';
  }

  const tooltipText = [
    formatExpiresAt(expiresAt, locale),
    retentionDays != null ? t('expiry.tooltipDetail', { retentionDays }) : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <span
      data-expiry-tier={tier}
      title={tooltipText}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        chipClass,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      {label}
    </span>
  );
}
