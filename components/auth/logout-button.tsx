'use client';

// 05-02 T1: Logout button (responsive variants).
// Phase 5 Plan 05-02 — synchronous submitLockRef guard (carry-forward 04-03).
//
// onClick → POST /api/auth/logout via authFetch. On 204 → window.location.replace('/login')
// (full reload kills SSE + clears state). Idempotent — retry button on error.

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LogOut, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { authFetch, markLogoutClicked, AuthRedirectError } from '@/components/auth/auth-fetcher';

interface LogoutButtonProps {
  variant?: 'icon' | 'inline';
}

const FETCH_TIMEOUT_MS = 10_000;

export function LogoutButton({ variant = 'inline' }: LogoutButtonProps) {
  const t = useTranslations('topbar.user');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitLockRef = useRef(false);

  async function handleClick(): Promise<void> {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setIsSubmitting(true);
    markLogoutClicked();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await authFetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        cache: 'no-store',
      });
      clearTimeout(timeout);
      if (res.ok || res.status === 204) {
        // Full reload kills SSE subscriptions + clears in-memory state.
        window.location.replace('/login');
        return;
      }
      toast.error(t('logoutError'), {
        action: {
          label: t('logoutRetry'),
          onClick: () => void handleClick(),
        },
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof AuthRedirectError) return;
      toast.error(t('logoutError'), {
        action: {
          label: t('logoutRetry'),
          onClick: () => void handleClick(),
        },
      });
    } finally {
      submitLockRef.current = false;
      setIsSubmitting(false);
    }
  }

  if (variant === 'icon') {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              onMouseDown={() => markLogoutClicked()}
              onClick={handleClick}
              disabled={isSubmitting}
              aria-label={t('logoutAria')}
              aria-busy={isSubmitting}
            >
              {isSubmitting ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <LogOut className="size-5" aria-hidden="true" />
              )}
            </Button>
          }
        />
        <TooltipContent>{t('logout')}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="min-h-10 px-3"
      onMouseDown={() => markLogoutClicked()}
      onClick={handleClick}
      disabled={isSubmitting}
      aria-busy={isSubmitting}
    >
      {isSubmitting ? (
        <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
      ) : (
        <LogOut className="mr-2 size-4" aria-hidden="true" />
      )}
      {t('logout')}
    </Button>
  );
}
