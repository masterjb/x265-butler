'use client';

import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import useSWR, { mutate } from 'swr';
import { Switch } from '@/components/ui/switch';

// 16-01 T7: Auto-Scan global toggle.
//
// Reads current value via SWR /api/settings; on flip PUTs the same endpoint
// with key 'autoScan.enabled'. The settings route's audit-added M5 post-write
// hook restarts the watcher service synchronously.

const SETTINGS_URL = '/api/settings';
const HEALTH_URL = '/api/health';

interface SettingsResponse {
  settings: Record<string, string>;
}

const fetcher = async (url: string): Promise<SettingsResponse> => {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  return r.json();
};

export function AutoScanToggle() {
  const t = useTranslations('settings.autoScan');
  const { data, isLoading, error } = useSWR<SettingsResponse>(SETTINGS_URL, fetcher);
  const [, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);

  const persisted = data?.settings?.['autoScan.enabled'];
  const checked = optimistic ?? (persisted === undefined ? true : persisted === 'true');

  useEffect(() => {
    if (data && optimistic !== null && persisted === (optimistic ? 'true' : 'false')) {
      setOptimistic(null);
    }
  }, [data, optimistic, persisted]);

  async function flip(next: boolean): Promise<void> {
    setOptimistic(next);
    try {
      const res = await fetch(SETTINGS_URL, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { 'autoScan.enabled': next ? 'true' : 'false' } }),
      });
      if (!res.ok) throw new Error(`PUT settings: ${res.status}`);
      startTransition(() => {
        void mutate(SETTINGS_URL);
        void mutate(HEALTH_URL);
      });
    } catch (err) {
      setOptimistic(null);
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg);
    }
  }

  return (
    <div className="flex flex-col gap-1 rounded-md border p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <label htmlFor="autoScan-toggle" className="text-sm font-medium leading-none">
            {t('toggleLabel')}
          </label>
          <p className="text-muted-foreground text-sm">{t('toggleHelp')}</p>
        </div>
        <Switch
          id="autoScan-toggle"
          checked={checked}
          disabled={isLoading || error !== undefined}
          onCheckedChange={(v) => void flip(v)}
          aria-label={t('toggleLabel')}
        />
      </div>
    </div>
  );
}
