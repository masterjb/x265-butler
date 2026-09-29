'use client';

// 24-03 (F2): Settings → Paths tab Cache card. Self-contained like AuthTab /
// PathsTabShares — owns its own dirty/save + PUT /api/settings { cache_pool_path }
// and does NOT join the cross-tab unsaved-changes AlertDialog (settings-client
// dirty lifecycle is untouched).
//
// Surfaces the DC-B resolution ("no silent magic" visibility invariant):
//   - read-only EFFECTIVE resolved path (font-mono) + resolution Badge (icon+text,
//     never colour-only per WCAG color-not-only)
//   - editable override input (empty → auto-detect)
//   - amber space-advisory ONLY when resolution === 'config-fallback'
//   - Save → PUT; on success router.refresh() so effective path + badge re-resolve.

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, HardDrive, FolderCog, UserCog } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export type CacheResolution = 'user-override' | 'mnt-cache' | 'config-fallback';

export interface CachePathCardProps {
  effectivePath: string;
  resolution: CacheResolution;
  settingValue: string | null;
  advisory: 'config-fallback-space' | null;
}

// Per-resolution badge: icon + text (WCAG color-not-only). variant chosen so the
// status reads in both light + dark without relying on hue alone. `i18n` maps the
// hyphenated resolution literal to the camelCase i18n key (S12 naming convention).
const BADGE_BY_RESOLUTION: Record<
  CacheResolution,
  { variant: 'secondary' | 'outline' | 'warning'; icon: typeof HardDrive; i18n: string }
> = {
  'mnt-cache': { variant: 'secondary', icon: HardDrive, i18n: 'mntCache' },
  'config-fallback': { variant: 'warning', icon: FolderCog, i18n: 'configFallback' },
  'user-override': { variant: 'outline', icon: UserCog, i18n: 'userOverride' },
};

// fetch-timeout guard (mirror auth-tab / settings-form): abort a hung PUT so the
// Save button never sticks in the loading state forever.
const SAVE_TIMEOUT_MS = 15_000;

export function CachePathCard({
  effectivePath,
  resolution,
  settingValue,
  advisory,
}: CachePathCardProps) {
  const t = useTranslations('settings.cachePath');
  const router = useRouter();

  const [value, setValue] = useState(settingValue ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const submitLockRef = useRef(false);

  const dirty = value.trim() !== (settingValue ?? '').trim();
  const badge = BADGE_BY_RESOLUTION[resolution];
  const BadgeIcon = badge.icon;

  async function handleSave(): Promise<void> {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setIsSaving(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SAVE_TIMEOUT_MS);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // empty string ⇒ clear-to-unset (revert to auto-resolve); trim so a
        // stray space does not get persisted as a bogus override.
        body: JSON.stringify({ settings: { cache_pool_path: value.trim() } }),
        signal: controller.signal,
      });
      if (res.ok) {
        toast.success(t('savedToast'));
        // re-resolve effective path + badge server-side.
        router.refresh();
      } else {
        let code: string | undefined;
        try {
          const body = (await res.json()) as { fieldErrors?: { cache_pool_path?: string } };
          code = body.fieldErrors?.cache_pool_path;
        } catch {
          // ignore parse failure — fall through to generic error toast.
        }
        toast.error(code ? t(`errorToast.${code}`) : t('errorToast.generic'));
      }
    } catch {
      toast.error(t('errorToast.generic'));
    } finally {
      clearTimeout(timer);
      submitLockRef.current = false;
      setIsSaving(false);
    }
  }

  return (
    <Card data-testid="cache-path-card">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Effective resolved path (read-only) + resolution badge */}
        <div className="flex flex-col gap-1">
          <span className="text-sm text-muted-foreground">{t('effectiveLabel')}</span>
          <div className="flex flex-wrap items-center gap-2">
            <code
              className="rounded bg-muted px-2 py-1 font-mono text-sm"
              data-testid="cache-effective-path"
            >
              {effectivePath}
            </code>
            <Badge variant={badge.variant} data-testid="cache-resolution-badge">
              <BadgeIcon aria-hidden="true" />
              {t(`badge.${badge.i18n}`)}
            </Badge>
          </div>
        </div>

        {/* Amber space advisory — only on config-fallback */}
        {advisory === 'config-fallback-space' && (
          <div
            role="status"
            data-testid="cache-config-fallback-advisory"
            className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-100 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-200"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t('advisory')}</span>
          </div>
        )}

        {/* Editable override */}
        <div className="flex flex-col gap-1">
          <label htmlFor="cache-pool-override" className="text-sm font-medium">
            {t('overrideLabel')}
          </label>
          <Input
            id="cache-pool-override"
            value={value}
            placeholder={effectivePath}
            onChange={(e) => setValue(e.target.value)}
            disabled={isSaving}
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">{t('helperText')}</p>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={!dirty || isSaving} data-testid="cache-path-save">
            {isSaving ? t('savingCta') : t('saveCta')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
