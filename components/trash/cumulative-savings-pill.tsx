'use client';

import { HardDriveDownload } from 'lucide-react';
import { useTranslations, useLocale } from 'next-intl';
import { formatBytes, type FormatLocale } from '@/src/lib/format';

export function CumulativeSavingsPill({
  bytesReclaimed,
  count,
}: {
  bytesReclaimed: number;
  count: number;
}) {
  const t = useTranslations('trash');
  const locale = useLocale() as FormatLocale;

  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-3 py-1 text-sm text-muted-foreground">
      <HardDriveDownload className="size-4 shrink-0" aria-hidden="true" />
      <span className="tabular-nums">
        {t('summary.reclaimed', {
          bytesReclaimed: formatBytes(bytesReclaimed, locale),
          count,
        })}
      </span>
    </div>
  );
}
