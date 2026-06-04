'use client';

import { useTranslations } from 'next-intl';

export function SkipLink() {
  const t = useTranslations('app');
  return (
    <a
      href="#main"
      className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-background focus:px-4 focus:py-2 focus:text-foreground focus:ring-2 focus:ring-ring"
    >
      {t('skipLink')}
    </a>
  );
}
