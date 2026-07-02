'use client';

// 05-02 T2: Auth toggle (Switch) with confirm-on-disable dialog.
// Phase 5 Plan 05-02 — AC-5 + audit M5 (accurate dialog text).

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface AuthToggleProps {
  initialEnabled: boolean;
  userExists: boolean;
}

export function AuthToggle({ initialEnabled, userExists }: AuthToggleProps) {
  const t = useTranslations('settings.auth.toggle');
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const submitLockRef = useRef(false);

  async function applyChange(newEnabled: boolean): Promise<void> {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setIsSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { auth_enabled: newEnabled ? 'true' : 'false' } }),
      });
      if (res.ok) {
        setEnabled(newEnabled);
        router.refresh();
      } else {
        toast.error('Failed to save');
      }
    } catch {
      toast.error('Failed to save');
    } finally {
      submitLockRef.current = false;
      setIsSaving(false);
    }
  }

  function handleToggle(checked: boolean): void {
    // Disabling requires confirmation when user exists (would lock dashboard open).
    if (!checked && enabled && userExists) {
      setConfirmOpen(true);
      return;
    }
    void applyChange(checked);
  }

  return (
    <>
      <div className="flex flex-row items-center justify-between gap-4 rounded-lg border border-border p-4">
        <div className="space-y-1">
          <p className="text-base font-medium">{t('label')}</p>
          <p className="text-sm text-muted-foreground">{t('helper')}</p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={handleToggle}
          disabled={isSaving}
          aria-label={t('label')}
        />
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('disableConfirm.title')}</DialogTitle>
            <DialogDescription>{t('disableConfirm.body')}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              autoFocus
              className="min-h-10"
            >
              {t('disableConfirm.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                void applyChange(false);
              }}
              className="min-h-10"
            >
              {t('disableConfirm.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
