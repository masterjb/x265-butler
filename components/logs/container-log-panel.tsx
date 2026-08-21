'use client';

// 05-03 T2.E: Container log tail panel.
// Phase 5 Plan 05-03 — AC-7 + design-system/pages/logs.md §5.

import { Download, RotateCw, Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ContainerLogMeta } from '@/app/api/logs/container/route';
import { authFetch } from '@/components/auth/auth-fetcher';
import { ClearLogsButton } from '@/components/logs/clear-logs-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

// 50-05: the pino level the 49-04 telemetry tier writes at — "recorded, not
// shouted". 49-04 took those lines off stdout; this panel reads the RING, where
// they still land, which is why the switch exists at all.
//
// The switch filters on the LEVEL, not on an action name, and that is load-
// bearing: `cpu_attribution` emits at this level in its quiet branch and at
// WARN when the event-loop lag p99 breaches its threshold
// (cpu-attribution-sampler.ts). An action denylist would hide the line exactly
// when it turns into the alarm.
const TELEMETRY_LEVEL = 25;

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
  // 50-05: lines, meta and totalLines live in ONE state value and are set by ONE
  // setState. With separate setters there is a render in which meta[i] still
  // describes a line from the PREVIOUS response — and then the telemetry filter
  // hides the wrong lines, silently, in the very tool the operator trusts while
  // hunting a bug. This is the one failure mode here nobody would see.
  const [snapshot, setSnapshot] = useState<{
    lines: string[];
    meta: ContainerLogMeta[];
    totalLines: number;
  }>({ lines: [], meta: [], totalLines: 0 });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  // 50-05: view-only filters, deliberately NOT in the URL like format/lines.
  // The tail is a ring buffer with auto-refresh — a shared link to a filtered
  // view would promise something the data source cannot keep. autoRefresh sits
  // in local state for the same reason.
  const [filterText, setFilterText] = useState('');
  const [hideTelemetry, setHideTelemetry] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await authFetch(`/api/logs/container?lines=${initialLines}&format=${format}`);
      if (!res.ok) {
        setLoadError(`HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as {
        lines?: string[];
        meta?: ContainerLogMeta[];
        totalLines?: number;
      };
      // A response without `meta` must not reuse the previous one — an empty
      // array makes the telemetry filter fail OPEN (every line stays visible)
      // instead of hiding lines it can no longer describe.
      setSnapshot({
        lines: body.lines ?? [],
        meta: body.meta ?? [],
        totalLines: body.totalLines ?? 0,
      });
    } catch (err) {
      if (err && (err as Error).name === 'AuthRedirectError') return;
      setLoadError((err as Error).message);
    }
  }, [initialLines, format]);

  const filterActive = filterText !== '' || hideTelemetry;

  // Substring, case-insensitive, matched against the RENDERED line — what the
  // operator sees is what gets matched. No regex on purpose: typing `[` must
  // not throw. No debounce either: unlike the library search there is no URL
  // write and no round-trip here, only <=1000 lines already in memory.
  const visibleLines = useMemo(() => {
    if (!filterActive) return snapshot.lines;
    const needle = filterText.toLowerCase();
    return snapshot.lines.filter((line, i) => {
      if (hideTelemetry && snapshot.meta[i]?.level === TELEMETRY_LEVEL) return false;
      if (needle !== '' && !line.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [snapshot, filterText, hideTelemetry, filterActive]);

  // Two distinct empty states. "no log lines available" means the RING is
  // empty; saying that while the ring is full would simply be false.
  const ringEmpty = snapshot.lines.length === 0;
  const filteredToNothing = !ringEmpty && visibleLines.length === 0;
  // Raising the line count only helps when the ring actually holds more than
  // the tail currently shows.
  const moreLinesAvailable = snapshot.totalLines > snapshot.lines.length;

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

        {/* 50-05: rebuilt rather than reusing components/library/search-input.tsx —
            that one calls useTranslations('library') outright and would render
            library strings here. Height stays at the Input default (h-8) to match
            this header's neighbours; see the Z.103 note in CLAUDE.md. */}
        <div className="relative w-full sm:w-56">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder={t('filter.placeholder')}
            aria-label={t('filter.aria')}
            className="pl-8 pr-8"
          />
          {filterText ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('filter.clear')}
              onClick={() => setFilterText('')}
              className="absolute right-1 top-1/2 -translate-y-1/2"
            >
              <X />
            </Button>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <Switch
            id="container-hide-telemetry"
            checked={hideTelemetry}
            onCheckedChange={setHideTelemetry}
            aria-describedby="container-hide-telemetry-hint"
          />
          <label htmlFor="container-hide-telemetry" className="text-sm">
            {t('filter.hideTelemetry')}
          </label>
        </div>

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

        {/* 24-05 F7: destructive clear — kept at the toolbar's right edge,
            visually separated from the read-only controls (UX destructive-emphasis). */}
        <ClearLogsButton onCleared={() => void refresh()} />
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
        {/* The RING is empty. Distinct from "the filter left nothing" below —
            claiming "no log lines available" while the ring is full would simply
            be false. */}
        {ringEmpty && !loadError ? <p className="text-muted-foreground">{t('empty')}</p> : null}
        {/* 50-05: the region is always mounted so a screen reader announces the
            transition when typing empties the list. The role="alert" error path
            above stays untouched. */}
        <div aria-live="polite">
          {filteredToNothing && !loadError ? (
            <p className="text-muted-foreground">
              {moreLinesAvailable
                ? t('filter.emptyFiltered', { count: snapshot.lines.length })
                : t('filter.emptyFilteredAll', { count: snapshot.lines.length })}
            </p>
          ) : null}
        </div>
        <pre className="whitespace-pre-wrap break-words">
          {visibleLines.map((line, i) => (
            <span key={i} className="block">
              {line}
            </span>
          ))}
        </pre>
      </div>

      <footer className="flex flex-col gap-1 border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <p>{t('note.dockerLogs')}</p>
        {/* E4: the download is an <a href> straight at the API — a client-side
            filter cannot touch it, and that stays that way. A shared log silently
            missing its filtered-out lines can send a diagnosis the wrong way. */}
        <p>{t('note.downloadUnfiltered')}</p>
        <p id="container-hide-telemetry-hint">{t('filter.hideTelemetryHint')}</p>
      </footer>
    </section>
  );
}
