'use client';

// Phase 21 Plan 21-03 T4 — heuristic-driven locale error boundary.
//
// Detects stale-browser-cache by comparing window.__APP_VERSION__ (injected
// by [locale]/layout.tsx at SSR time) against NEXT_PUBLIC_APP_VERSION (baked
// into the client bundle). Emits a single `errorBoundaryTriggered` audit
// trail entry via POST /api/diagnostics/log-event (audit-M5 source field).

import { useEffect, useRef } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, RefreshCcw, RotateCcw } from 'lucide-react';
import { classifyError } from '@/src/lib/diagnostics/error-heuristic';
import { Button } from '@/components/ui/button';
import { HeuristicCallout } from '@/components/error-pages/heuristic-callout';
import { ErrorActionCluster } from '@/components/error-pages/error-action-cluster';
import { PageContainer } from '@/components/page-layout';

const FORUM_URL =
  process.env.NEXT_PUBLIC_FEEDBACK_FORUM_URL ??
  'https://forums.unraid.net/topic/182094-support-human-126094-docker-templates/';

const FETCH_TIMEOUT_MS = 10_000;

declare global {
  interface Window {
    __APP_VERSION__?: string;
  }
}

export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('error');
  const locale = useLocale();
  const emittedRef = useRef(false);

  useEffect(() => {
    if (emittedRef.current) return;
    emittedRef.current = true;

    const actual = typeof window !== 'undefined' ? window.__APP_VERSION__ : undefined;
    const expected = process.env.NEXT_PUBLIC_APP_VERSION;
    const versionFingerprint =
      actual !== undefined || expected !== undefined
        ? { actual: actual ?? null, expected: expected ?? null }
        : null;
    const result = classifyError({ error, versionFingerprint });

    const ac = new AbortController();
    const t1 = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);

    void fetch('/api/diagnostics/log-event', {
      method: 'POST',
      signal: ac.signal,
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'errorBoundaryTriggered',
        payload: {
          source: 'error-boundary-locale',
          kind: result.kind,
          boundary: 'locale',
          digest: result.digest,
          versionFingerprint: result.versionFingerprint,
        },
      }),
    }).catch(() => {
      // Silent: operator already in an error state. 401 (auth-mirror gate),
      // network failures, abort — none should cascade into more noise.
    });

    return () => {
      clearTimeout(t1);
      ac.abort();
    };
  }, [error]);

  const actual = typeof window !== 'undefined' ? window.__APP_VERSION__ : undefined;
  const expected = process.env.NEXT_PUBLIC_APP_VERSION;
  const result = classifyError({
    error,
    versionFingerprint:
      actual !== undefined || expected !== undefined
        ? { actual: actual ?? null, expected: expected ?? null }
        : null,
  });

  const Icon = result.kind === 'stale-cache' ? RefreshCcw : AlertTriangle;
  const branch = result.kind === 'stale-cache' ? 'staleCache' : 'unknown';
  const title = t(`${branch}.title`);
  const body = t(`${branch}.body`);

  const primaryAction = (
    <Button onClick={reset} size="lg" className="min-h-[44px] gap-2">
      <RotateCcw className="size-4" aria-hidden="true" />
      <span>{t('actionCluster.retry')}</span>
    </Button>
  );

  return (
    <PageContainer variant="centered">
      <HeuristicCallout
        kind={result.kind}
        icon={Icon}
        title={title}
        body={body}
        primaryAction={primaryAction}
      />
      <ErrorActionCluster
        diagnosticsHref={`/${locale}/diagnostics`}
        libraryHref={`/${locale}/library`}
        forumHref={FORUM_URL}
        labels={{
          diagnostics: t('actionCluster.diagnostics'),
          library: t('actionCluster.library'),
          forum: t('actionCluster.forum'),
          onboarding: t('actionCluster.onboarding'),
        }}
      />
    </PageContainer>
  );
}
