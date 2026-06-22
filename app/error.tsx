'use client';

// Phase 21 Plan 21-03 T4 — pre-locale root error boundary.
//
// Triggers when an error escapes [locale]/error.tsx, OR when a route outside
// the locale tree (rare) throws. Locale state is unavailable — we hardcode
// the default-locale (`/en/*`) hrefs.

import { useEffect, useRef } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { classifyError } from '@/src/lib/diagnostics/error-heuristic';
import { Button } from '@/components/ui/button';
import { HeuristicCallout } from '@/components/error-pages/heuristic-callout';
import { ErrorActionCluster } from '@/components/error-pages/error-action-cluster';
import { PageContainer } from '@/components/page-layout';

const FORUM_URL =
  process.env.NEXT_PUBLIC_FEEDBACK_FORUM_URL ??
  'https://forums.unraid.net/topic/182094-support-human-126094-docker-templates/';

const FETCH_TIMEOUT_MS = 10_000;

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
    const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);

    void fetch('/api/diagnostics/log-event', {
      method: 'POST',
      signal: ac.signal,
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'errorBoundaryTriggered',
        payload: {
          source: 'error-boundary-root',
          kind: result.kind,
          boundary: 'root',
          digest: result.digest,
          versionFingerprint: result.versionFingerprint,
        },
      }),
    }).catch(() => {
      // Silent — see locale error.tsx for rationale.
    });

    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [error]);

  const primaryAction = (
    <Button onClick={reset} size="lg" className="min-h-[44px] gap-2">
      <RotateCcw className="size-4" aria-hidden="true" />
      <span>Try again</span>
    </Button>
  );

  return (
    <PageContainer variant="centered">
      <HeuristicCallout
        kind="root"
        icon={AlertTriangle}
        title="Something went wrong"
        body="An unexpected error occurred outside of the localized application shell. Please retry, or report the issue."
        primaryAction={primaryAction}
      />
      <ErrorActionCluster
        diagnosticsHref="/en/diagnostics"
        libraryHref="/en/library"
        forumHref={FORUM_URL}
        labels={{
          diagnostics: 'Diagnostics',
          library: 'Library',
          forum: 'Report issue',
          onboarding: 'Start onboarding',
        }}
      />
    </PageContainer>
  );
}
