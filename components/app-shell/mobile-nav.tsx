'use client';

import { useState } from 'react';
import { Menu, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { BrandHeader } from './brand-header';
import { SidebarNav } from './sidebar-nav';

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev';

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const t = useTranslations('app');
  return (
    <Drawer open={open} onOpenChange={setOpen} direction="bottom">
      <DrawerTrigger
        aria-label={open ? t('closeNav') : t('openNav')}
        aria-expanded={open}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'icon' }),
          'h-11 w-11 lg:h-9 lg:w-9 lg:hidden',
        )}
      >
        {open ? (
          <X className="size-5" aria-hidden="true" />
        ) : (
          <Menu className="size-5" aria-hidden="true" />
        )}
      </DrawerTrigger>
      <DrawerContent className="p-0">
        <DrawerTitle className="sr-only">{t('openNav')}</DrawerTitle>
        {/*
          vaul renders its own pull-handle automatically inside DrawerContent
          when direction="bottom", and ties it to a real drag-to-close gesture
          (touch-drag on phone, mouse-drag on desktop).
          Closing on item-click is the standard mobile drawer pattern.
        */}
        <div onClick={() => setOpen(false)}>
          <BrandHeader />
          <nav className="p-3 pb-6">
            <SidebarNav orientation="vertical" size="lg" />
          </nav>
        </div>
        <div className="border-t border-border px-4 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <span
            className="font-mono text-xs font-normal tabular-nums text-muted-foreground"
            title={`v${APP_VERSION}`}
          >
            {APP_VERSION}
          </span>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
