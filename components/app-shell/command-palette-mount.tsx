'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useCommandPalette } from '@/src/lib/ui/use-command-palette';
import { CommandPalette } from '@/components/ui/command-palette';

declare global {
  interface Navigator {
    userAgentData?: { platform?: string } | undefined;
  }
}

export function CommandPaletteMount() {
  const { open, setOpen } = useCommandPalette();
  const t = useTranslations('palette');
  const [isMac, setIsMac] = useState<boolean>(false);

  useEffect(() => {
    const ua = navigator.userAgentData?.platform ?? navigator.platform ?? '';
    setIsMac(/Mac|iPad|iPhone/.test(ua));
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('trigger_aria')}
        data-testid="command-palette-trigger"
        className="hidden h-9 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:inline-flex"
      >
        <span className="font-mono">{isMac ? '⌘K' : 'Ctrl K'}</span>
      </button>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </>
  );
}
