'use client';

import { CheckCircle, AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface Props {
  count: number;
  withinDays: number;
}

export function ExpiringSoonBadge({ count, withinDays }: Props) {
  const t = useTranslations('stats.charts');

  if (count === 0) {
    return (
      <div
        className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-sm text-muted-foreground"
        aria-label={t('expiringSoon.aria.expiringSoon', { count, withinDays })}
      >
        <CheckCircle className="h-4 w-4" aria-hidden="true" />
        <span className="font-mono tabular-nums">{count}</span>
        <span>{t('expiringSoon.noneSoon')}</span>
      </div>
    );
  }

  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-3 py-1 text-sm text-destructive"
      aria-label={t('expiringSoon.aria.expiringSoon', { count, withinDays })}
    >
      <AlertTriangle className="h-4 w-4" aria-hidden="true" />
      <span className="font-mono tabular-nums">{count}</span>
      <span>{t('expiringSoon.expiringSoon', { count, withinDays })}</span>
    </div>
  );
}
