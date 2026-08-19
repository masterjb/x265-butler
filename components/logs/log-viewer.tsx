'use client';

// 05-03 T2.D: log viewer (Per-Job tab — selected-job content).
// Phase 5 Plan 05-03 — AC-6 + design-system/pages/logs.md §4.2.
//
// Behavior:
//   - jobId selected + status=encoding → SSE stream via useSseSubscription
//   - else → authFetch GET /api/logs/[jobId]
//   - auto-scroll-to-bottom enabled by default; user-scrolls-up disables it;
//     scrolls-back-to-bottom re-enables
//   - line buffer cap 5000 (drop-oldest)

import { Download, FileText, RotateCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { authFetch } from '@/components/auth/auth-fetcher';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { cn } from '@/lib/utils';

import { LiveStatusIndicator, type LiveStatus } from './live-status-indicator';
import type { JobLogEntry } from './jobs-list';
import { useSseSubscription } from './use-sse-subscription';

const LINE_BUFFER_CAP = 5000;

export function LogViewer({ entry, className }: { entry: JobLogEntry | null; className?: string }) {
  const t = useTranslations('logs.perJob.viewer');
  const tDownload = useTranslations('logs.perJob.action');
  const tError = useTranslations('logs');
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [reloadNonce, setReloadNonce] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const isActive = entry?.status === 'encoding';
  const url = entry ? `/api/logs/${entry.id}` : '';

  // Initial / non-live load. Re-fires when reloadNonce changes (retry button).
  useEffect(() => {
    if (!entry) {
      setLines([]);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void authFetch(`/api/logs/${entry.id}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          setLines([]);
          return;
        }
        if (!res.ok) {
          setLoadError(`HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as { lines: string[] };
        setLines(data.lines ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err && (err as Error).name === 'AuthRedirectError') return;
        setLoadError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entry, reloadNonce]);

  const onSseMessage = useCallback((data: { line: string }) => {
    if (!data || typeof data.line !== 'string') return;
    setLines((prev) => {
      const next = [...prev, data.line];
      if (next.length > LINE_BUFFER_CAP) next.splice(0, next.length - LINE_BUFFER_CAP);
      return next;
    });
  }, []);

  const sse = useSseSubscription<{ line: string }>({
    url: `${url}?live=1`,
    enabled: Boolean(entry) && isActive,
    onMessage: onSseMessage,
  });

  const liveStatus: LiveStatus = useMemo(() => {
    if (!isActive) return 'static';
    if (sse.connectionState === 'open' || sse.connectionState === 'connecting') return 'live';
    if (sse.connectionState === 'reconnecting') return 'reconnecting';
    return 'static';
  }, [isActive, sse.connectionState]);

  // Auto-scroll heuristic.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoScroll(distanceFromBottom < 50);
  }, []);

  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  if (!entry) {
    return (
      <div className={cn('flex h-full items-center justify-center p-8', className)}>
        <EmptyState icon={FileText} title={t('empty.title')} body={t('empty.body')} />
      </div>
    );
  }

  const filename = entry.fileBasename ?? entry.filePath ?? `Job #${entry.id}`;

  return (
    <section className={cn('flex h-full flex-col', className)} aria-label={t('regionAria')}>
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-card/50 px-3 py-2">
        <span className="truncate font-mono text-sm" title={filename}>
          {filename}
        </span>
        <LiveStatusIndicator status={liveStatus} />
        <span className="text-xs text-muted-foreground">
          {t('lineCount', { count: lines.length })}
        </span>
        <a
          href={`/api/logs/${entry.id}/download`}
          className="ml-auto"
          aria-label={tDownload('downloadAria')}
        >
          <Button type="button" variant="outline" size="sm">
            <Download aria-hidden="true" className="h-4 w-4" />
            <span>{tDownload('download')}</span>
          </Button>
        </a>
      </header>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="bg-muted/30 text-foreground flex-1 overflow-auto rounded-b-md border-x border-b border-border p-3 font-mono text-xs leading-6 lg:text-sm"
      >
        {loading && lines.length === 0 ? (
          <p className="text-muted-foreground">{t('loading')}</p>
        ) : null}
        {loadError ? (
          <div role="alert" className="flex items-center gap-3">
            <p className="text-destructive">{tError('loadError', { detail: loadError })}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setReloadNonce((n) => n + 1)}
            >
              <RotateCw aria-hidden="true" className="h-4 w-4" />
              <span>{tError('retry')}</span>
            </Button>
          </div>
        ) : null}
        {lines.length === 0 && !loading && !loadError ? (
          <p className="text-muted-foreground">{t('empty.noLines')}</p>
        ) : null}
        <pre className="whitespace-pre-wrap break-words">
          {lines.map((line, i) => (
            <span key={i} className="block">
              {line}
            </span>
          ))}
        </pre>
      </div>
    </section>
  );
}
