'use client';

// 05-02 T1: Login form Client Component.
// Phase 5 Plan 05-02 — AC-2 + AC-3 + AC-4.
//
// Synchronous submitLockRef guard (carry-forward 04-03). AbortController(10000ms).
// 401 → reset password + focus password. 429 → countdown + disable. ?expired=1
// fires toast on mount + URL cleanup. router.replace (NEVER push) keeps login
// out of browser history.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Eye, EyeOff, LogIn, Loader2, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';

interface LoginFormProps {
  next: string;
  expired: boolean;
}

const FETCH_TIMEOUT_MS = 10_000;
const RATE_LIMIT_FALLBACK_SEC = 60;

export function LoginForm({ next, expired }: LoginFormProps) {
  const router = useRouter();
  const t = useTranslations('login');
  const tToast = useTranslations('login.toast.expired');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [rateLimitUntil, setRateLimitUntil] = useState<number | null>(null);
  const [rateLimitNow, setRateLimitNow] = useState<number>(() => Math.floor(Date.now() / 1000));
  const submitLockRef = useRef(false);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  const expiredHandledRef = useRef(false);

  // Fire ?expired=1 toast once on mount, then clean URL.
  useEffect(() => {
    if (!expired || expiredHandledRef.current) return;
    expiredHandledRef.current = true;
    toast(
      <div className="flex items-start gap-2">
        <Clock className="size-4 shrink-0" aria-hidden="true" />
        <div>
          <div className="font-medium">{tToast('title')}</div>
          <div className="text-sm text-muted-foreground">{tToast('body')}</div>
        </div>
      </div>,
      { duration: 5000 },
    );
    // Clean URL — strip ?expired=1 (preserve ?next= via router.replace target).
    const url = new URL(window.location.href);
    url.searchParams.delete('expired');
    router.replace(url.pathname + (url.search || ''), { scroll: false });
  }, [expired, router, tToast]);

  // Countdown timer for rate-limit window.
  useEffect(() => {
    if (rateLimitUntil === null) return;
    const id = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      setRateLimitNow(now);
      if (now >= rateLimitUntil) {
        setRateLimitUntil(null);
      }
    }, 250);
    return () => clearInterval(id);
  }, [rateLimitUntil]);

  const rateLimitRemaining =
    rateLimitUntil !== null ? Math.max(0, rateLimitUntil - rateLimitNow) : 0;
  const isRateLimited = rateLimitRemaining > 0;

  function clearFieldErrors(): void {
    setUsernameError(null);
    setPasswordError(null);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitLockRef.current || isRateLimited) return;
    submitLockRef.current = true;
    setIsSubmitting(true);
    clearFieldErrors();

    // Client-side required-only check (server enforces complexity).
    if (!username) {
      setUsernameError(t('error.required'));
      submitLockRef.current = false;
      setIsSubmitting(false);
      return;
    }
    if (!password) {
      setPasswordError(t('error.required'));
      submitLockRef.current = false;
      setIsSubmitting(false);
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: controller.signal,
        cache: 'no-store',
      });
      clearTimeout(timeout);

      if (res.ok) {
        toast.success(t('toast.success'));
        // router.replace — NOT push. Don't pollute history with /login.
        router.replace(next);
        return;
      }

      let errorCode: string | null = null;
      try {
        const body = (await res.json()) as { error_code?: string };
        errorCode = body.error_code ?? null;
      } catch {
        errorCode = null;
      }

      if (res.status === 401 || errorCode === 'invalid_credentials') {
        toast.error(t('error.invalidCredentials'));
        setPassword('');
        // focus password field for retry
        requestAnimationFrame(() => passwordInputRef.current?.focus());
      } else if (res.status === 429 || errorCode === 'rate_limit_exceeded') {
        const retryAfter = parseInt(
          res.headers.get('Retry-After') ?? String(RATE_LIMIT_FALLBACK_SEC),
          10,
        );
        const seconds =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : RATE_LIMIT_FALLBACK_SEC;
        const now = Math.floor(Date.now() / 1000);
        setRateLimitUntil(now + seconds);
        setRateLimitNow(now);
        toast.error(t('error.rateLimited', { seconds }));
      } else {
        toast.error(t('error.serverError'));
      }
    } catch (err) {
      clearTimeout(timeout);
      if ((err as Error).name === 'AbortError') {
        toast.error(t('error.networkError'));
      } else {
        toast.error(t('error.networkError'));
      }
    } finally {
      submitLockRef.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <Card className="p-5 sm:p-6">
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="login-username" className="text-sm font-medium text-foreground">
            {t('field.username.label')}
          </label>
          <Input
            id="login-username"
            name="username"
            type="text"
            autoComplete="username"
            placeholder={t('field.username.placeholder')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={isSubmitting || isRateLimited}
            aria-invalid={!!usernameError}
            aria-describedby={usernameError ? 'login-username-error' : undefined}
            className="min-h-11"
            autoFocus
          />
          {usernameError && (
            <p id="login-username-error" role="alert" className="text-sm text-destructive">
              {usernameError}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <label htmlFor="login-password" className="text-sm font-medium text-foreground">
            {t('field.password.label')}
          </label>
          <div className="relative">
            <Input
              id="login-password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isSubmitting || isRateLimited}
              aria-invalid={!!passwordError}
              aria-describedby={passwordError ? 'login-password-error' : undefined}
              ref={passwordInputRef}
              className="min-h-11 pr-12"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              disabled={isSubmitting || isRateLimited}
              aria-label={showPassword ? t('field.password.hide') : t('field.password.show')}
              className="absolute right-1 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {showPassword ? (
                <EyeOff className="size-4" aria-hidden="true" />
              ) : (
                <Eye className="size-4" aria-hidden="true" />
              )}
            </button>
          </div>
          {passwordError && (
            <p id="login-password-error" role="alert" className="text-sm text-destructive">
              {passwordError}
            </p>
          )}
        </div>
        <Button
          type="submit"
          disabled={isSubmitting || isRateLimited}
          className="min-h-11 w-full"
          aria-busy={isSubmitting}
        >
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
              {t('action.submitting')}
            </>
          ) : isRateLimited ? (
            <span className="tabular-nums">
              {t('rateLimited.label', { seconds: rateLimitRemaining })}
            </span>
          ) : (
            <>
              <LogIn className="mr-2 size-4" aria-hidden="true" />
              {t('action.submit')}
            </>
          )}
        </Button>
      </form>
    </Card>
  );
}
