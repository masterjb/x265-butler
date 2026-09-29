'use client';

// Phase 18 Plan 18-01 Task 6: EncoderWarningsBadge — Settings/Encoder tab badge.
//
// Pulls from /api/notifications (same source as NotificationBell). When
// notifications.length === 0 → returns null. Click opens DropdownMenu used
// as info-popover with vendor-specific remediation per warning code.
//
// Deviation: shadcn Popover not in components/ui/ + new-runtime-deps boundary
// forbids @radix-ui/react-popover install. DropdownMenu carries the popover
// semantic (focus-trap + escape + keyboard-nav from Radix).

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Copy } from 'lucide-react';
import { badgeVariants } from '@/components/ui/badge';
import { NVENC_REQUIREMENTS } from '@/lib/encode/nvenc-requirements';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface NotificationItem {
  id: string;
  severity: 'info' | 'warn';
  code: string;
  title: string;
  detail?: string;
}

interface NotificationsResponse {
  notifications: NotificationItem[];
}

const POLL_INTERVAL_MS = 60_000;

function VendorRemediation({ code }: { code: string }) {
  const t = useTranslations();

  switch (code) {
    case 'nvenc_no_runtime': {
      const steps = t.raw('notification.detection.nvenc_no_runtime.remediation.steps') as
        | string[]
        | string;
      const stepArr = Array.isArray(steps) ? steps : [String(steps)];
      // 23-06: per-field copy sourced from the single-source NVENC_REQUIREMENTS.
      // Each button writes a BARE value (extra-param / Variable Name / Variable
      // Value) — never a joined KEY=value (AUDIT-M1). Keeps the toast pattern.
      const copy = async (text: string) => {
        try {
          await navigator.clipboard.writeText(text);
          toast.success(t('notification.detection.nvenc_no_runtime.remediation.copyToast'));
        } catch {
          toast.error(t('notification.detection.nvenc_no_runtime.remediation.copyToast'));
        }
      };
      const copyButton = (text: string, ariaLabel: string) => (
        <Button
          size="sm"
          variant="outline"
          onClick={() => copy(text)}
          aria-label={ariaLabel}
          className="min-h-[44px] shrink-0"
        >
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      );
      const codeClass =
        'flex-1 break-all rounded border border-border bg-background px-1.5 py-0.5 font-mono text-xs';
      const rmKey = 'notification.detection.nvenc_no_runtime.remediation';
      return (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t(`${rmKey}.title`)}</p>
          <ol className="ml-4 list-decimal space-y-1 text-xs text-muted-foreground">
            {stepArr.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <div className="space-y-2 pt-1">
            <div className="flex items-center gap-2">
              <code className={codeClass}>{NVENC_REQUIREMENTS.extraParam}</code>
              {copyButton(
                NVENC_REQUIREMENTS.extraParam,
                t(`${rmKey}.copyExtraParam`, { value: NVENC_REQUIREMENTS.extraParam }),
              )}
            </div>
            {NVENC_REQUIREMENTS.envVars.map((ev) => (
              <div key={ev.key} className="space-y-1">
                <div className="flex items-center gap-2">
                  <code className={codeClass}>{ev.key}</code>
                  {copyButton(ev.key, t(`${rmKey}.copyName`, { value: ev.key }))}
                </div>
                <div className="flex items-center gap-2">
                  <code className={codeClass}>{ev.value}</code>
                  {copyButton(ev.value, t(`${rmKey}.copyValue`, { value: ev.value }))}
                </div>
              </div>
            ))}
          </div>
          <div className="pt-1">
            <a
              href="https://forums.unraid.net/topic/98978-plugin-nvidia-driver/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center text-xs text-primary underline-offset-4 hover:underline"
            >
              {t(`${rmKey}.pluginLinkLabel`)}
            </a>
          </div>
        </div>
      );
    }
    case 'qsv_only_legacy_intel':
      return (
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {t('notification.detection.qsv_only_legacy_intel.remediation.title')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('notification.detection.qsv_only_legacy_intel.remediation.body')}
          </p>
        </div>
      );
    case 'dri_present_no_driver': {
      const steps = t.raw('notification.detection.dri_present_no_driver.remediation.steps') as
        | string[]
        | string;
      const stepArr = Array.isArray(steps) ? steps : [String(steps)];
      return (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            {t('notification.detection.dri_present_no_driver.remediation.title')}
          </p>
          <ol className="ml-4 list-decimal space-y-1 text-xs text-muted-foreground">
            {stepArr.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      );
    }
    case 'vainfo_binary_missing':
      return (
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {t('notification.detection.vainfo_binary_missing.remediation.title')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('notification.detection.vainfo_binary_missing.remediation.body')}
          </p>
        </div>
      );
    default:
      // Exhaustive-union fallback: surface raw detail as last-resort guidance.
      return null;
  }
}

export function EncoderWarningsBadge() {
  const t = useTranslations();
  const [warnings, setWarnings] = useState<NotificationItem[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications', { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as NotificationsResponse;
      // Defensive: if upstream returns a partial body (older API, mocked
      // fetch in tests, transient error response), normalize to empty array
      // so the `.length === 0` guard below stays safe.
      setWarnings(Array.isArray(body?.notifications) ? body.notifications : []);
    } catch {
      // Silent.
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  if (warnings.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('settings.encoder.warningsBadge.aria')}
        className={cn(
          badgeVariants({ variant: 'warning' }),
          'cursor-pointer gap-1 hover:opacity-90',
        )}
      >
        <span aria-hidden="true">⚠</span>
        {t('settings.encoder.warningsBadge.label', { count: warnings.length })}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-96 p-3">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-0 pt-0">
            {t('settings.encoder.warningsBadge.label', { count: warnings.length })}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <div className="space-y-3 pt-1">
          {warnings.map((w) => (
            <div key={w.id} className="space-y-1">
              <p className="text-sm font-semibold">{t(w.title)}</p>
              {w.detail && <p className="text-xs text-muted-foreground">{w.detail}</p>}
              <VendorRemediation code={w.code} />
            </div>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
