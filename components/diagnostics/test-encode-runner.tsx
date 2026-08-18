'use client';

// Phase 21 Plan 21-02 — TestEncodeRunner: POST /api/diagnostics/test-encode.
//
// /ui-ux-pro-max T0 D2=α: button + spinner + result-card below + collapsible
// <details> for stdout/stderr. No client log-event (21-01 backend emits
// testEncodeTriggered server-side; audit-M3 hard-blocks client-POST).
// audit-SR3+SR4: AbortController + 20s timeout + unmount cleanup.
// audit-SR5: prefers-reduced-motion → text "Loading..." label.

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, PlayCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { usePrefersReducedMotion } from './use-prefers-reduced-motion';
import type { TestEncodeResultSnapshot } from './test-encode-result-markdown';

const TEST_ENCODE_TIMEOUT_MS = 20_000;

type TestEncodeResult =
  | { kind: 'idle' }
  | { kind: 'mutex_held'; retryAfter: number }
  | { kind: 'http_error'; status: number }
  | { kind: 'aborted'; reason: 'timeout' }
  | {
      kind: 'completed';
      outcome: 'success' | 'failed' | 'killed_timeout';
      encoderPicked: string;
      durationMs: number;
      exitCode: number | null;
      ffmpegStdout: string;
      ffmpegStderr: string;
      mappedError: { code: string; severity: 'error' | 'warning' } | null;
    };

interface TestEncodeBody {
  success: boolean;
  encoderPicked: string;
  durationMs: number;
  ffmpegStdout: string;
  ffmpegStderr: string;
  exitCode: number | null;
  mappedError: { code: string; severity: 'error' | 'warning' } | null;
}

function deriveOutcome(body: TestEncodeBody): 'success' | 'failed' | 'killed_timeout' {
  if (body.success && body.exitCode === 0) return 'success';
  if (body.exitCode === null) return 'killed_timeout';
  return 'failed';
}

export function TestEncodeRunner({
  onResult,
}: {
  onResult?: (snapshot: TestEncodeResultSnapshot | null) => void;
} = {}) {
  const t = useTranslations('diagnostics');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TestEncodeResult>({ kind: 'idle' });
  const submitLockRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const reduceMotion = usePrefersReducedMotion();

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleClick = async () => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setLoading(true);
    setResult({ kind: 'idle' });

    const ac = new AbortController();
    abortRef.current = ac;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, TEST_ENCODE_TIMEOUT_MS);

    try {
      const res = await fetch('/api/diagnostics/test-encode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
      });
      if (res.status === 503) {
        const data = (await res.json().catch(() => ({}))) as {
          retryAfterSeconds?: number;
        };
        setResult({ kind: 'mutex_held', retryAfter: data.retryAfterSeconds ?? 5 });
        return;
      }
      if (!res.ok) {
        setResult({ kind: 'http_error', status: res.status });
        return;
      }
      const body = (await res.json()) as TestEncodeBody;
      const snapshot: TestEncodeResultSnapshot = {
        outcome: deriveOutcome(body),
        encoderPicked: body.encoderPicked,
        durationMs: body.durationMs,
        exitCode: body.exitCode,
        ffmpegStdout: body.ffmpegStdout ?? '',
        ffmpegStderr: body.ffmpegStderr ?? '',
        mappedError: body.mappedError ?? null,
      };
      setResult({ kind: 'completed', ...snapshot });
      onResult?.(snapshot);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        if (timedOut) setResult({ kind: 'aborted', reason: 'timeout' });
      } else {
        setResult({ kind: 'http_error', status: 0 });
      }
    } finally {
      clearTimeout(timeout);
      setLoading(false);
      submitLockRef.current = false;
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button
          type="button"
          onClick={handleClick}
          disabled={loading}
          aria-busy={loading || undefined}
          className="min-h-[44px] gap-2"
        >
          {loading && !reduceMotion ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <PlayCircle className="size-4" aria-hidden="true" />
          )}
          <span>{loading ? t('testEncode.loadingLabel') : t('testEncode.button')}</span>
        </Button>
      </div>

      {result.kind === 'mutex_held' && (
        <div className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t('testEncode.mutexHeld', { seconds: result.retryAfter })}</span>
        </div>
      )}

      {result.kind === 'http_error' && (
        <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            {t('testEncode.failed')} (HTTP {result.status})
          </span>
        </div>
      )}

      {result.kind === 'aborted' && (
        <div className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t('testEncode.killedTimeout')}</span>
        </div>
      )}

      {result.kind === 'completed' && (
        <div
          className={`rounded border p-3 text-sm ${
            result.outcome === 'success'
              ? 'border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-200'
              : result.outcome === 'killed_timeout'
                ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200'
                : 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200'
          }`}
        >
          <div className="mb-2 flex items-center gap-2">
            {result.outcome === 'success' ? (
              <CheckCircle2 className="size-4" aria-hidden="true" />
            ) : result.outcome === 'killed_timeout' ? (
              <AlertTriangle className="size-4" aria-hidden="true" />
            ) : (
              <AlertCircle className="size-4" aria-hidden="true" />
            )}
            <span className="font-medium">
              {result.outcome === 'success'
                ? t('testEncode.success')
                : result.outcome === 'killed_timeout'
                  ? t('testEncode.killedTimeout')
                  : t('testEncode.failed')}
            </span>
          </div>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono text-xs">
            <dt>{t('encoders.detected')}</dt>
            <dd>{result.encoderPicked}</dd>
            <dt>{t('testEncode.duration')}</dt>
            <dd>{result.durationMs} ms</dd>
            <dt>{t('testEncode.exitCode')}</dt>
            <dd>{result.exitCode === null ? '(killed)' : result.exitCode}</dd>
          </dl>
          {/* 23-01: server-derived "Likely cause" callout (failed/killed only —
              mappedError is null on success). Neutral surface separates it from
              the already-severity-tinted card; severity drives colour + icon;
              static (reduced-motion-safe); colour-not-only via icon + label. */}
          {result.mappedError && (
            <div
              role="status"
              className={`mt-3 flex items-start gap-2 rounded-md border border-l-4 bg-background/70 p-2.5 text-xs leading-snug dark:bg-background/40 ${
                result.mappedError.severity === 'warning'
                  ? 'border-amber-300 border-l-amber-500 dark:border-amber-800 dark:border-l-amber-400'
                  : 'border-red-300 border-l-red-500 dark:border-red-800 dark:border-l-red-400'
              }`}
            >
              {result.mappedError.severity === 'warning' ? (
                <AlertTriangle
                  className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                  aria-hidden="true"
                />
              ) : (
                <AlertCircle
                  className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400"
                  aria-hidden="true"
                />
              )}
              <div>
                <p className="font-semibold">{t('testEncode.diagnosisTitle')}</p>
                <p className="mt-0.5">{t(`testEncode.hint.${result.mappedError.code}`)}</p>
              </div>
            </div>
          )}
          <Collapsible className="mt-3">
            <CollapsibleTrigger className="rounded px-2 py-1 text-xs font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {t('testEncode.stdoutToggle')}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-tight text-foreground">
                {result.ffmpegStdout && (
                  <>
                    {'--- stdout ---\n'}
                    {result.ffmpegStdout}
                    {'\n'}
                  </>
                )}
                {result.ffmpegStderr && (
                  <>
                    {'--- stderr ---\n'}
                    {result.ffmpegStderr}
                  </>
                )}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}
    </div>
  );
}
