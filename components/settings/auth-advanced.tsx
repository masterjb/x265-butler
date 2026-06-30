'use client';

// 05-02 T2: Auth Advanced collapsible (session_ttl_seconds + auth_trust_proxy_xff + bcrypt_cost).
// Phase 5 Plan 05-02 — AC-7 + audit S7 (dynamic bcrypt cost estimate).

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ChevronDown, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';

const TTL_PRESETS = [
  { key: '1h', value: '3600' },
  { key: '6h', value: '21600' },
  { key: '1d', value: '86400' },
  { key: '3d', value: '259200' },
  { key: '7d', value: '604800' },
  { key: '14d', value: '1209600' },
  { key: '30d', value: '2592000' },
] as const;

const BCRYPT_COST_ESTIMATES: Record<number, number> = {
  10: 60,
  11: 120,
  12: 250,
  13: 500,
  14: 1000,
};

interface AuthAdvancedProps {
  sessionTtlSeconds: string;
  trustProxyXff: boolean;
  bcryptCost: string;
}

export function AuthAdvanced({
  sessionTtlSeconds,
  trustProxyXff: trustProxyXffInitial,
  bcryptCost: bcryptCostInitial,
}: AuthAdvancedProps) {
  const t = useTranslations('settings.advanced');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [ttl, setTtl] = useState(sessionTtlSeconds);
  const [xff, setXff] = useState(trustProxyXffInitial);
  const [cost, setCost] = useState(parseInt(bcryptCostInitial, 10) || 12);
  const [isSaving, setIsSaving] = useState(false);

  function isDirty(): boolean {
    return (
      ttl !== sessionTtlSeconds ||
      xff !== trustProxyXffInitial ||
      cost !== parseInt(bcryptCostInitial, 10)
    );
  }

  async function handleSave(): Promise<void> {
    if (isSaving) return;
    setIsSaving(true);
    try {
      const settings: Record<string, string> = {};
      if (ttl !== sessionTtlSeconds) settings.session_ttl_seconds = ttl;
      if (xff !== trustProxyXffInitial) settings.auth_trust_proxy_xff = xff ? 'true' : 'false';
      if (cost !== parseInt(bcryptCostInitial, 10)) settings.bcrypt_cost = String(cost);

      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
      });
      if (res.ok) {
        router.refresh();
      } else {
        toast.error('Failed to save advanced settings');
      }
    } catch {
      toast.error('Failed to save advanced settings');
    } finally {
      setIsSaving(false);
    }
  }

  const costEstimate = BCRYPT_COST_ESTIMATES[cost] ?? 250;

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle>{t('heading')}</CardTitle>
          <CollapsibleTrigger
            render={
              <Button variant="ghost" size="icon" className="size-9" aria-label={t('heading')}>
                <ChevronDown
                  className={cn(
                    'size-4 transition-transform motion-safe:duration-200',
                    open && 'rotate-180',
                  )}
                  aria-hidden="true"
                />
              </Button>
            }
          />
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="flex flex-col gap-6">
            {/* Session TTL */}
            <div className="space-y-2">
              <p className="text-sm font-medium">{t('sessionTtl.label')}</p>
              <p className="text-sm text-muted-foreground">{t('sessionTtl.helper')}</p>
              <RadioGroup
                value={ttl}
                onValueChange={(v) => setTtl(v)}
                className="flex flex-wrap gap-2"
              >
                {TTL_PRESETS.map((p) => (
                  <label
                    key={p.key}
                    className={cn(
                      'flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors',
                      ttl === p.value
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border bg-card text-muted-foreground hover:bg-muted',
                    )}
                  >
                    <RadioGroupItem value={p.value} className="sr-only" />
                    {t(`sessionTtl.preset.${p.key}`)}
                  </label>
                ))}
              </RadioGroup>
            </div>

            {/* Trust XFF */}
            <div className="flex flex-row items-start justify-between gap-4 rounded-lg border border-border p-4">
              <div className="space-y-1">
                <p className="text-base font-medium">{t('trustProxyXff.label')}</p>
                <p className="flex items-start gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                  <span>{t('trustProxyXff.helperWarning')}</span>
                </p>
              </div>
              <Switch
                checked={xff}
                onCheckedChange={setXff}
                aria-label={t('trustProxyXff.label')}
              />
            </div>

            {/* Bcrypt cost */}
            <div className="space-y-2">
              <p className="text-sm font-medium">{t('bcryptCost.label')}</p>
              <p className="text-sm text-muted-foreground">
                {cost === 14 ? (
                  <span className="flex items-start gap-1.5 font-medium text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                    <span>{t('bcryptCost.helperWarning14')}</span>
                  </span>
                ) : (
                  t('bcryptCost.helper')
                )}
              </p>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={10}
                  max={14}
                  step={1}
                  value={cost}
                  onChange={(e) => setCost(parseInt(e.target.value, 10))}
                  aria-label={t('bcryptCost.label')}
                  className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                />
                <span className="font-mono text-sm tabular-nums text-foreground">
                  {t('bcryptCost.estimate', { cost, ms: costEstimate })}
                </span>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <Button onClick={handleSave} disabled={!isDirty() || isSaving} className="min-h-10">
                {isSaving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
