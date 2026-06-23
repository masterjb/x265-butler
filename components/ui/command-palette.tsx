'use client';

import { useEffect, useMemo, useRef } from 'react';
import { Combobox } from '@base-ui/react/combobox';
import { useRouter, usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import { NAV_ITEMS } from '@/components/app-shell/sidebar-nav';
import { cn } from '@/lib/utils';

type NavItem = (typeof NAV_ITEMS)[number];

type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
};

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function makeFilter(tNav: (k: NavItem['labelKey']) => string) {
  return function diacriticsInsensitiveSubstringFilter(item: NavItem, query: string): boolean {
    if (!query) return true;
    return normalize(tNav(item.labelKey)).includes(normalize(query));
  };
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const t = useTranslations('palette');
  const tNav = useTranslations('nav');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const filterFn = useMemo(
    () => makeFilter((k: NavItem['labelKey']) => tNav(k)),
    [tNav],
  );

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const inputEl = inputRef.current;
    if (inputEl) {
      requestAnimationFrame(() => inputEl.focus());
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onOpenChange(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function') {
        prev.focus();
      }
    };
  }, [open, onOpenChange]);

  function handleSelect(item: NavItem) {
    if (!item.labelKey || !item.icon || !item.href) {
      console.error('[command-palette] NAV_ITEMS shape drift', item);
      return;
    }
    const target = `/${locale}${item.href}`;
    onOpenChange(false);
    if (pathname === target) return;
    router.push(target);
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('title')}
      className="fixed inset-0 z-50"
      data-testid="command-palette-root"
    >
      <button
        type="button"
        aria-label={t('close_aria')}
        onClick={() => onOpenChange(false)}
        className="fixed inset-0 z-0 w-full cursor-default bg-black/60 backdrop-blur-sm"
        data-testid="command-palette-backdrop"
        tabIndex={-1}
      />
      <div className="fixed inset-x-0 top-[8vh] z-10 mx-auto w-[90vw] max-w-[90vw] sm:top-[20vh] sm:w-full sm:max-w-2xl">
        <div
          className="overflow-hidden rounded-lg border border-border bg-popover shadow-xl"
          data-testid="command-palette-popup"
        >
          <Combobox.Root
            items={NAV_ITEMS as unknown as readonly NavItem[]}
            inline
            open
            // 13-04 build-fix: ComboboxRoot's TS type narrows to `boolean` —
            // `="always"` was 13-03's intent for keep-highlighted-on-filter
            // behavior but never compiled in production build (13-03 shipped
            // without verifying `next build`). Boolean shorthand keeps the
            // first-item highlight semantics that 13-03 relied on.
            autoHighlight
            filter={filterFn}
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <Combobox.Input
                ref={inputRef}
                placeholder={t('placeholder')}
                aria-label={t('title')}
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Combobox.List
              className="max-h-[60vh] overflow-y-auto p-1"
              data-testid="command-palette-list"
            >
              {(item: NavItem) => {
                if (!item?.labelKey || !item?.icon || !item?.href) {
                  console.error('[command-palette] NAV_ITEMS shape drift', item);
                  return null;
                }
                const Icon = item.icon;
                const target = `/${locale}${item.href}`;
                const active = pathname === target || pathname.startsWith(`${target}/`);
                return (
                  <Combobox.Item
                    key={item.href}
                    value={item}
                    onClick={() => handleSelect(item)}
                    className={cn(
                      'flex min-h-[44px] cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-sm',
                      'data-[highlighted]:bg-muted',
                      active && 'border-l-2 border-primary',
                    )}
                    data-testid={`command-palette-item-${item.labelKey}`}
                  >
                    <Icon
                      className="size-5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="flex-1 font-medium">{tNav(item.labelKey)}</span>
                    <span className="font-mono text-xs text-muted-foreground">{target}</span>
                  </Combobox.Item>
                );
              }}
            </Combobox.List>
            <Combobox.Empty
              className="px-3 py-6 text-center text-sm text-muted-foreground"
              data-testid="command-palette-empty"
            >
              {t('empty')}
            </Combobox.Empty>
          </Combobox.Root>
        </div>
      </div>
    </div>
  );
}
