'use client';

import { Languages } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter, usePathname } from 'next/navigation';
import { buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

const LOCALES = ['en', 'de'] as const;

export function LangSwitch() {
  const t = useTranslations('app.langSwitch');
  const router = useRouter();
  const pathname = usePathname();

  function switchLocale(target: string) {
    const segments = pathname.split('/');
    if (segments.length > 1 && LOCALES.includes(segments[1] as (typeof LOCALES)[number])) {
      segments[1] = target;
      router.push(segments.join('/') || `/${target}`);
    } else {
      router.push(`/${target}`);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('label')}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'icon' }),
          'h-11 w-11 lg:h-9 lg:w-9',
        )}
      >
        <Languages className="size-5" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => switchLocale('en')}>{t('en')}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => switchLocale('de')}>{t('de')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
