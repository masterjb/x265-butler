'use client';

// Phase 18 Plan 18-01 Task 6: Topbar driver-warnings bell.
//
// Pulls /api/notifications on mount + every 60s. Hidden (DOM-absent) when
// notifications.length === 0. Click → DropdownMenu listing each warning;
// click row → router.push deeplink + locale-prefix.
//
// Deviation from plan literal: plan spec'd shadcn <Popover> but no popover
// primitive exists in components/ui/ and plan boundary forbids new runtime
// deps. DropdownMenu (Radix) is the closest existing primitive; semantics
// (focus-trap, escape-close, keyboard-nav) match.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Bell, X } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface NotificationItem {
  id: string;
  source: string;
  severity: 'info' | 'warn';
  code: string;
  title: string;
  detail?: string;
  deeplink?: string;
  createdAt: number;
}

interface NotificationsResponse {
  notifications: NotificationItem[];
  count: number;
  severityCounts: { info: number; warn: number };
}

const POLL_INTERVAL_MS = 60_000;
const DISMISS_TTL_MS = 24 * 60 * 60 * 1000; // 24h snooze
export const DISMISSED_STORAGE_KEY = 'x265butler.notifications.dismissed';

type DismissedMap = Record<string, number>;

function readDismissed(): DismissedMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as DismissedMap;
  } catch {
    return {};
  }
}

function writeDismissed(value: DismissedMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // localStorage disabled / quota — non-fatal; in-memory state still applies
    // until next reload.
  }
}

export function NotificationBell() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [data, setData] = useState<NotificationsResponse | null>(null);
  const [dismissed, setDismissed] = useState<DismissedMap>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications', { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as NotificationsResponse;
      // Defensive normalize for partial/mocked responses (preserves
      // "DOM-absent on empty" contract instead of crashing on .length).
      setData({
        notifications: Array.isArray(body?.notifications) ? body.notifications : [],
        count: typeof body?.count === 'number' ? body.count : 0,
        severityCounts: body?.severityCounts ?? { info: 0, warn: 0 },
      });
    } catch {
      // Silent — bell is non-critical UI; transient fetch errors leave
      // previous state visible. No toast (avoids noise on every poll).
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    setDismissed(readDismissed());
  }, []);

  const handleDismiss = useCallback((code: string) => {
    setDismissed((prev) => {
      const next = { ...prev, [code]: Date.now() };
      writeDismissed(next);
      return next;
    });
  }, []);

  // Filter dismissed (24h-snooze) + recompute counts. Auto-revive when
  // dismissed-timestamp is older than TTL — operator re-evaluates condition.
  const visibleNotifications = useMemo(() => {
    if (!data) return [];
    const now = Date.now();
    return data.notifications.filter((n) => {
      const dismissedAt = dismissed[n.code];
      if (dismissedAt === undefined) return true;
      return now - dismissedAt > DISMISS_TTL_MS;
    });
  }, [data, dismissed]);

  if (!data || visibleNotifications.length === 0) return null;

  const visibleCount = visibleNotifications.length;
  const visibleWarnCount = visibleNotifications.filter((n) => n.severity === 'warn').length;
  const highestSeverity: 'info' | 'warn' = visibleWarnCount > 0 ? 'warn' : 'info';
  const badgeColor =
    highestSeverity === 'warn'
      ? 'bg-destructive text-destructive-foreground'
      : 'bg-amber-500 text-white dark:bg-amber-600';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('notification.bell.aria')}
        className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'relative h-9 w-9')}
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        <span
          className={cn(
            'absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums',
            badgeColor,
          )}
        >
          {visibleCount}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {t('notification.bell.title', { count: visibleCount })}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {visibleNotifications.map((n) => (
          <DropdownMenuItem
            key={n.id}
            className="flex flex-col items-start gap-0.5 py-2"
            onClick={() => {
              if (n.deeplink) router.push(`/${locale}${n.deeplink}`);
            }}
          >
            <span className="flex w-full items-center gap-2">
              <span
                aria-hidden="true"
                className={`h-2 w-2 rounded-full ${
                  n.severity === 'warn' ? 'bg-destructive' : 'bg-amber-500'
                }`}
              />
              <span className="flex-1 text-sm font-medium">{t(n.title)}</span>
              <button
                type="button"
                aria-label={t('notification.bell.dismissAria', { title: t(n.title) })}
                className="ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-60 hover:bg-accent hover:text-accent-foreground hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDismiss(n.code);
                }}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </span>
            {n.detail && <span className="pl-4 text-xs text-muted-foreground">{n.detail}</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
