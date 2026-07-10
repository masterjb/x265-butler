'use client';

// 05-02 T2: Setup-form (state C only).
// Phase 5 Plan 05-02 — AC-6 + audit S4 (validatePasswordComplexity reuse).

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Eye, EyeOff, UserPlus, Loader2 } from 'lucide-react';
import { validatePasswordComplexity } from '@/src/lib/auth/password-complexity';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const FETCH_TIMEOUT_MS = 10_000;

export function SetupForm() {
  const t = useTranslations('settings.setup');
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitLockRef = useRef(false);
  const usernameRef = useRef<HTMLInputElement | null>(null);

  function clearErrors(): void {
    setUsernameError(null);
    setPasswordError(null);
    setConfirmError(null);
  }

  function validateConfirmOnBlur(): void {
    if (confirmPassword && confirmPassword !== password) {
      setConfirmError(t('error.passwordsDontMatch'));
    } else {
      setConfirmError(null);
    }
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitLockRef.current) return;
    clearErrors();

    // Local validation
    if (username.length < 3) {
      setUsernameError(t('error.usernameTooShort'));
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      setUsernameError(t('error.usernameInvalid'));
      return;
    }
    const complexity = validatePasswordComplexity(password);
    if (!complexity.ok) {
      setPasswordError(t('error.passwordTooWeak'));
      return;
    }
    if (password !== confirmPassword) {
      setConfirmError(t('error.passwordsDontMatch'));
      return;
    }

    submitLockRef.current = true;
    setIsSubmitting(true);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        toast.success(t('success'));
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error_code?: string };
      const code = body.error_code;
      if (res.status === 409 || code === 'setup_already_completed') {
        toast.success(t('success'));
        router.refresh();
        return;
      }
      if (code === 'password_too_weak') {
        setPasswordError(t('error.passwordTooWeak'));
      } else if (code === 'username_taken') {
        setUsernameError(t('error.usernameTaken'));
      } else if (code === 'username_invalid_chars') {
        setUsernameError(t('error.usernameInvalid'));
      } else if (code === 'username_too_short') {
        setUsernameError(t('error.usernameTooShort'));
      } else {
        toast.error('Failed to create account');
      }
    } catch {
      clearTimeout(timeout);
      toast.error('Failed to create account');
    } finally {
      submitLockRef.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('heading')}</CardTitle>
        <CardDescription>{t('field.password.helper')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <label htmlFor="setup-username" className="text-sm font-medium">
              {t('field.username.label')}
            </label>
            <Input
              id="setup-username"
              type="text"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t('field.username.placeholder')}
              ref={usernameRef}
              aria-invalid={!!usernameError}
              aria-describedby={usernameError ? 'setup-username-error' : 'setup-username-helper'}
              className="min-h-11"
            />
            <p id="setup-username-helper" className="text-sm text-muted-foreground">
              {t('field.username.helper')}
            </p>
            {usernameError && (
              <p id="setup-username-error" role="alert" className="text-sm text-destructive">
                {usernameError}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="setup-password" className="text-sm font-medium">
              {t('field.password.label')}
            </label>
            <div className="relative">
              <Input
                id="setup-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!passwordError}
                aria-describedby={passwordError ? 'setup-password-error' : undefined}
                className="min-h-11 pr-12"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? t('field.password.hide') : t('field.password.show')}
                className="absolute right-1 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {showPassword ? (
                  <EyeOff className="size-4" aria-hidden="true" />
                ) : (
                  <Eye className="size-4" aria-hidden="true" />
                )}
              </button>
            </div>
            {passwordError && (
              <p id="setup-password-error" role="alert" className="text-sm text-destructive">
                {passwordError}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="setup-confirm" className="text-sm font-medium">
              {t('field.confirmPassword.label')}
            </label>
            <div className="relative">
              <Input
                id="setup-confirm"
                type={showConfirm ? 'text' : 'password'}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onBlur={validateConfirmOnBlur}
                aria-invalid={!!confirmError}
                aria-describedby={confirmError ? 'setup-confirm-error' : undefined}
                className="min-h-11 pr-12"
              />
              <button
                type="button"
                onClick={() => setShowConfirm((v) => !v)}
                aria-label={showConfirm ? t('field.password.hide') : t('field.password.show')}
                className="absolute right-1 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {showConfirm ? (
                  <EyeOff className="size-4" aria-hidden="true" />
                ) : (
                  <Eye className="size-4" aria-hidden="true" />
                )}
              </button>
            </div>
            {confirmError && (
              <p id="setup-confirm-error" role="alert" className="text-sm text-destructive">
                {confirmError}
              </p>
            )}
          </div>
          <Button type="submit" disabled={isSubmitting} className="min-h-11">
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
                {t('action.submitting')}
              </>
            ) : (
              <>
                <UserPlus className="mr-2 size-4" aria-hidden="true" />
                {t('action.submit')}
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
