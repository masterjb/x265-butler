'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
import { ActiveJobsBadge } from './active-jobs-badge';
import { CommandPaletteMount } from './command-palette-mount';
import { NotificationBell } from './notification-bell';
import { ThemeToggle } from './theme-toggle';
import { LangSwitch } from './lang-switch';
import { MobileNav } from './mobile-nav';
import { NAV_ITEMS } from './sidebar-nav';
import { UserCluster } from '@/components/auth/user-cluster';

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev';

function activeSectionKey(pathname: string): (typeof NAV_ITEMS)[number]['labelKey'] | null {
  // Strip locale prefix: /en/library → /library
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const route = `/${segments[1]}`;
  const match = NAV_ITEMS.find((item) => item.href === route);
  return match?.labelKey ?? null;
}

export function Topbar() {
  const tApp = useTranslations('app');
  const tNav = useTranslations('nav');
  const locale = useLocale();
  const pathname = usePathname();
  const sectionKey = activeSectionKey(pathname);

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border bg-background px-4 lg:h-16">
      <div className="flex items-center gap-2">
        {/* Mobile: show active section name (orientation cue, replaces bottom-nav indicator) */}
        {sectionKey && (
          <Link
            href={`/${locale}/library`}
            className="font-semibold text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
            aria-label={tApp('title')}
          >
            {tNav(sectionKey)}
          </Link>
        )}

        {/* Desktop: 32x32 logo + brand wordmark + version pill. post-05-10
            user-decision (B): logo lives in Topbar instead of Sidebar (single
            brand surface). Active-section indicator stays sidebar-only
            (aria-current highlight) per follow-up user-decision — Topbar
            breadcrumb removed to avoid duplication. */}
        <Link
          href={`/${locale}/dashboard`}
          className="hidden items-center gap-3 font-semibold text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:flex"
        >
          <Image
            src="/brand/Logo-512x512.png"
            width={32}
            height={32}
            alt=""
            priority
            className="rounded-sm"
          />
          <span className="flex items-baseline gap-3">
            {tApp('title')}
            <span
              className="font-mono text-xs font-normal tabular-nums text-muted-foreground"
              title={`v${APP_VERSION}`}
            >
              {APP_VERSION}
            </span>
          </span>
        </Link>
      </div>
      <div className="flex items-center gap-1">
        {/* 03-04: active-jobs badge — visible only when activeJobs > 0 */}
        <ActiveJobsBadge />
        {/* 13-03: Cmd+K command-palette trigger pill (lg-only) + global listener mount.
            18-02 reorder: Cmd+K precedes the NotificationBell per operator-feedback. */}
        <CommandPaletteMount />
        {/* 18-01: NotificationBell — visible only when driver-warnings present */}
        <NotificationBell />
        {/* 05-09: Pause/Stop affordance retired — Skip + Cancel-All-Queued
            replace it. ActiveJobsBadge stays as passive status indicator. */}
        <ThemeToggle />
        <LangSwitch />
        {/* 05-02: session-aware user cluster — null when authenticated=false
            (zero-regression byte-identical 1.4.0 markup). */}
        <UserCluster />
        {/* Mobile-only hamburger drawer trigger (last in row → closest to right edge).
            audit 01-04: ≥44px touch target on <lg, ~36px on ≥lg per page-override §10. */}
        <MobileNav />
      </div>
    </header>
  );
}
