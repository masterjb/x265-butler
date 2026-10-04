'use client';

// 15-02 T5: shared empty-state for the Storage page. Three variants drive
// the headline, body and CTA. `noFilesForShare` intentionally has NO CTA
// (per AC-10 — operator already knows the context once they pick a share).

import Link from 'next/link';
import { FilterX, HardDriveDownload, ScanLine } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type StorageEmptyVariant = 'noShares' | 'noFiles' | 'noFilesForShare';

export interface StorageEmptyStateProps {
  variant: StorageEmptyVariant;
  locale: string;
}

const ICONS: Record<StorageEmptyVariant, typeof HardDriveDownload> = {
  noShares: HardDriveDownload,
  noFiles: ScanLine,
  noFilesForShare: FilterX,
};

const CTA_HREF: Record<StorageEmptyVariant, string | null> = {
  noShares: '/settings/paths',
  noFiles: '/scan',
  noFilesForShare: null,
};

export function StorageEmptyState({ variant, locale }: StorageEmptyStateProps) {
  const t = useTranslations(`storage.empty.${variant}`);
  const Icon = ICONS[variant];
  const ctaHref = CTA_HREF[variant];

  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <Icon className="size-12 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-lg font-semibold text-foreground">{t('headline')}</h3>
        <p className="max-w-md text-sm text-muted-foreground">{t('body')}</p>
        {ctaHref && (
          <Link
            href={`/${locale}${ctaHref}`}
            className={cn(buttonVariants({ variant: 'default' }), 'mt-2')}
          >
            {t('cta')}
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
