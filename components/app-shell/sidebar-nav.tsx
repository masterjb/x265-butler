'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  LayoutDashboard,
  TrendingUp,
  BarChart3,
  HardDrive,
  Library,
  ListChecks,
  Trash2,
  Ban,
  Calculator,
  Settings,
  Wrench,
  FileText,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type NavItem = {
  href: string;
  icon: LucideIcon;
  labelKey:
    | 'dashboard'
    | 'stats'
    | 'bench'
    | 'storage'
    | 'library'
    | 'queue'
    | 'trash'
    | 'blocklist'
    | 'scanEstimate'
    | 'settings'
    | 'diagnostics'
    | 'logs';
};

export const NAV_ITEMS: readonly NavItem[] = [
  // Dashboard = home overview (KPIs + 30-day savings trend + live queue + recent
  // activity). Placed at top — primary destination for operators per Plan 03-04.
  { href: '/dashboard', icon: LayoutDashboard, labelKey: 'dashboard' },
  // 07-05: Stats page — Advanced Stats (Top Savers, Codec Distribution, Encoder Perf, Timeline).
  { href: '/stats', icon: TrendingUp, labelKey: 'stats' },
  // 11-02: Bench page — Pareto ScatterChart + Top-3 Recommendation Cards.
  { href: '/bench', icon: BarChart3, labelKey: 'bench' },
  // 15-02: Storage Analyzer — disk-space breakdown + per-share comparison +
  // top-folders deep-link into Library.
  { href: '/storage', icon: HardDrive, labelKey: 'storage' },
  { href: '/library', icon: Library, labelKey: 'library' },
  { href: '/queue', icon: ListChecks, labelKey: 'queue' },
  { href: '/trash', icon: Trash2, labelKey: 'trash' },
  // 04-02: blocklist nav link between Trash and Settings (alphabetical).
  { href: '/blocklist', icon: Ban, labelKey: 'blocklist' },
  // 13-04: Dry-Run / Estimate-Mode — Pre-encode preview, between Blocklist and
  // Settings. Cmd+K (13-03) consumes NAV_ITEMS automatically.
  { href: '/scan/estimate', icon: Calculator, labelKey: 'scanEstimate' },
  { href: '/settings', icon: Settings, labelKey: 'settings' },
  // 21-02: Diagnostics — operator self-diagnostic surface; consumes 21-01 backend.
  { href: '/diagnostics', icon: Wrench, labelKey: 'diagnostics' },
  { href: '/logs', icon: FileText, labelKey: 'logs' },
] as const;

function getLocaleFromPath(pathname: string): string {
  const seg = pathname.split('/')[1];
  return seg && /^[a-z]{2}$/.test(seg) ? seg : 'en';
}

export function SidebarNav({
  orientation = 'vertical',
  size = 'default',
}: {
  orientation?: 'vertical' | 'horizontal';
  /**
   * "default" → desktop sidebar density (~36px tap height, text-sm).
   * "lg"      → mobile bottom-sheet density (~64px tap height, text-base,
   *             chevron indicator, larger icons). Daumen-friendly.
   */
  size?: 'default' | 'lg';
}) {
  const pathname = usePathname();
  const locale = getLocaleFromPath(pathname);
  const t = useTranslations('nav');

  return (
    <ul
      className={cn(
        orientation === 'vertical' ? 'flex flex-col gap-1' : 'flex flex-row gap-1 overflow-x-auto',
      )}
    >
      {NAV_ITEMS.map((item) => {
        const href = `/${locale}${item.href}`;
        const active = pathname === href || pathname.startsWith(`${href}/`);
        const Icon = item.icon;
        return (
          <li key={item.href}>
            <Link
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center rounded-md font-medium transition-colors',
                'hover:bg-muted hover:text-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                size === 'lg'
                  ? 'gap-4 px-4 py-4 text-base min-h-[64px]'
                  : 'gap-3 px-3 py-2 text-sm',
                active
                  ? 'border-l-[3px] border-primary bg-muted text-primary'
                  : 'text-muted-foreground border-l-[3px] border-transparent',
              )}
            >
              <Icon
                className={cn('shrink-0', size === 'lg' ? 'size-6' : 'size-5')}
                aria-hidden="true"
              />
              <span className="flex-1">{t(item.labelKey)}</span>
              {size === 'lg' && (
                <ChevronRight className="size-5 text-muted-foreground" aria-hidden="true" />
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
