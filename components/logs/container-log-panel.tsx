'use client';

// 05-03 T2.E: Container log tail panel.
// Phase 5 Plan 05-03 — AC-7 + design-system/pages/logs.md §5.

import { Download, RotateCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';

import { authFetch } from '@/components/auth/auth-fetcher';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

const AUTO_REFRESH_INTERVAL_MS = 5_000;
const LINE_OPTIONS = [100, 500, 1000] as const;

export type ContainerFormat = 'raw' | 'json';

export function ContainerLogPanel({
  format,
  lines: initialLines,
  onFormatChange,
  onLinesChange,
  className,
}: {
  format: ContainerFormat;
  lines: number;
  onFormatChange: (next: ContainerFormat) => void;
  onLinesChange: (next: number) => void;
  className?: string;
}) {
  const t = useTranslations('logs.container');
  const [data, setData] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await authFetch(`/api/logs/container?lines=${initialLines}&format=${format}`);
      if (!res.ok) {
        setLoadError(`HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { lines: string[] };
      setData(body.lines ?? []);
    } catch (err) {
      if (err && (err as Error).name === 'AuthRedirectError') return;
      setLoadError((err as Error).message);
    }
  }, [initialLines, format]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Auto-refresh: 5s interval, paused when document hidden.
  useEffect(() => {
    if (!autoRefresh) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    const tick = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refresh();
    };
    intervalRef.current = setInterval(tick, AUTO_REFRESH_INTERVAL_MS);
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [autoRefresh, refresh]);

  return (
    <section
      className={cn('flex h-full flex-col rounded-md border border-border bg-card', className)}
      aria-label={t('regionAria')}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
        <RadioGroup
          value={format}
          onValueChange={(v) => onFormatChange(v as ContainerFormat)}
          className="flex flex-row gap-3"
        >
          <div className="flex items-center gap-1">
            <RadioGroupItem id="container-format-raw" value="raw" />
            <label htmlFor="container-format-raw" className="text-sm">
              {t('format.raw')}
            </label>
          </div>
          <div className="flex items-center gap-1">
            <RadioGroupItem id="container-format-json" value="json" />
            <label htmlFor="container-format-json" className="text-sm">
              {t('format.json')}
            </label>
          </div>
        </RadioGroup>

        <Select value={String(initialLines)} onValueChange={(v) => onLinesChange(Number(v))}>
          <SelectTrigger className="w-[110px]" aria-label={t('lines.aria')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LINE_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {t('lines.option', { count: n })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2">
          <Switch
            id="container-auto-refresh"
            checked={autoRefresh}
            onCheckedChange={setAutoRefresh}
          />
          <label htmlFor="container-auto-refresh" className="text-sm">
            {t('action.autoRefresh')}
          </label>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          aria-label={t('action.refreshAria')}
        >
          <RotateCw aria-hidden="true" className="h-4 w-4" />
          <span>{t('action.refresh')}</span>
        </Button>

        <a href={`/api/logs/container?lines=${initialLines}&format=${format}`} className="ml-auto">
          <Button type="button" variant="outline" size="sm">
            <Download aria-hidden="true" className="h-4 w-4" />
            <span>{t('action.download')}</span>
          </Button>
        </a>
      </header>

      <div className="flex-1 overflow-auto bg-muted/30 p-3 font-mono text-xs leading-6 lg:text-sm">
        {loadError ? (
          <div role="alert" className="flex items-center gap-3">
            <p className="text-destructive">{t('loadError', { detail: loadError })}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
              <RotateCw aria-hidden="true" className="h-4 w-4" />
              <span>{t('action.refresh')}</span>
            </Button>
          </div>
        ) : null}
        {data.length === 0 && !loadError ? (
          <p className="text-muted-foreground">{t('empty')}</p>
        ) : null}
        <pre className="whitespace-pre-wrap break-words">
          {data.map((line, i) => (
            <span key={i} className="block">
              {line}
            </span>
          ))}
        </pre>
      </div>

      <footer className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
        {t('note.dockerLogs')}
      </footer>
    </section>
  );
}
