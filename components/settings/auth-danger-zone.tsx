'use client';

// 05-02 → 13-01b T6: Auth Danger zone migrated to ConfirmButton P3 inverted-
// cooldown (3s cooldown / 8s auto-disarm — Foundation defaults per User Q1).
// HIGH-risk one-way-door: submitLockRef + authFetch + AuthRedirectError +
// 10s fetch-timeout + window.location.replace are preserved INSIDE the
// consumer's onConfirm callback. ConfirmButton P3 owns the state-machine
// (idle → cooldown → armed → fired/aborted/autoDisarmed) + ESC instance-scope
// guard (13-01a audit M3) + SR3 cooldown-button-HTML-disabled + SR6 silent
// auto-disarm.

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertOctagon, UserX } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { authFetch, AuthRedirectError } from '@/components/auth/auth-fetcher';

const FETCH_TIMEOUT_MS = 10_000;

export function AuthDangerZone() {
  const t = useTranslations('settings.danger.disableAndDelete');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitLockRef = useRef(false);

  const handleConfirm = useCallback(async (): Promise<void> => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setIsSubmitting(true);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await authFetch('/api/auth/disable-and-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok || res.status === 204 || res.status === 200) {
        toast.success(t('success'));
        // Full reload to enter state A (auth disabled, user deleted).
        window.location.replace(window.location.pathname + (window.location.search || ''));
        return;
      }
      toast.error('Failed to disable + delete');
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof AuthRedirectError) return;
      toast.error('Failed to disable + delete');
    } finally {
      submitLockRef.current = false;
      setIsSubmitting(false);
    }
  }, [t]);

  return (
    <Card className="border-destructive/30 bg-destructive/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive-foreground">
          <AlertOctagon className="size-5 text-destructive" aria-hidden="true" />
          {t('label').replace('Disable + delete user', 'Danger zone')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{t('body')}</p>
        <div className="self-start">
          <ConfirmButton
            variant="P3"
            onConfirm={handleConfirm}
            label={t('label')}
            cancelLabel={t('cancel')}
            disabled={isSubmitting}
            className="border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            <UserX className="size-4" aria-hidden="true" />
          </ConfirmButton>
        </div>
      </CardContent>
    </Card>
  );
}
