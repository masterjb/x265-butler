'use client';

// Phase 21 Plan 21-03 T4 — global error boundary.
//
// Catches errors thrown by the root layout itself; MUST include its own
// <html>/<body>. No Tailwind class dependency — design-system bundle may be
// broken at this layer. Audit-trail emit gated by useRef-once-gate (audit-SR3)
// so React StrictMode dev-double-mount + re-renders don't multi-emit.

import { useEffect, useRef } from 'react';

const FORUM_URL =
  process.env.NEXT_PUBLIC_FEEDBACK_FORUM_URL ??
  'https://forums.unraid.net/topic/182094-support-human-126094-docker-templates/';

const FETCH_TIMEOUT_MS = 10_000;

const containerStyle: React.CSSProperties = {
  display: 'flex',
  minHeight: '100vh',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '1rem',
  padding: '1.5rem',
  fontFamily: 'system-ui, sans-serif',
  background: '#0a0a0a',
  color: '#ededed',
  textAlign: 'center',
};

const titleStyle: React.CSSProperties = {
  fontSize: '1.75rem',
  fontWeight: 600,
  margin: 0,
};

const bodyStyle: React.CSSProperties = {
  fontSize: '1rem',
  color: '#a1a1aa',
  maxWidth: '40rem',
  margin: 0,
  lineHeight: 1.5,
};

const buttonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '44px',
  padding: '0.5rem 1.25rem',
  borderRadius: '0.5rem',
  background: '#1e40af',
  color: 'white',
  border: 'none',
  cursor: 'pointer',
  fontSize: '0.95rem',
  fontWeight: 500,
};

const linkRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.5rem',
  justifyContent: 'center',
  marginTop: '0.5rem',
};

const linkStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '44px',
  padding: '0.5rem 1rem',
  borderRadius: '0.5rem',
  border: '1px solid #3f3f46',
  background: 'transparent',
  color: '#ededed',
  textDecoration: 'none',
  fontSize: '0.9rem',
};

export default function GlobalError({
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
          source: 'error-boundary-global',
          kind: 'unknown',
          boundary: 'global',
          digest: error.digest,
        },
      }),
    }).catch(() => {
      // Silent — design-system bundle may be broken at this layer.
    });

    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [error.digest]);

  return (
    <html lang="en">
      <body>
        <div style={containerStyle}>
          <h1 style={titleStyle}>Something went wrong</h1>
          <p style={bodyStyle}>
            The application shell failed to render. Please retry, or report the issue using the
            links below.
          </p>
          <button type="button" onClick={reset} style={buttonStyle}>
            Try again
          </button>
          {/* eslint-disable @next/next/no-html-link-for-pages -- design-system
              bundle may be broken at this layer; next/link relies on the App
              Router runtime which we cannot assume is alive here. */}
          <div style={linkRowStyle}>
            <a href="/en/diagnostics" style={linkStyle}>
              Diagnostics
            </a>
            <a href="/en/library" style={linkStyle}>
              Library
            </a>
            <a href={FORUM_URL} target="_blank" rel="noopener noreferrer" style={linkStyle}>
              Report issue
            </a>
          </div>
          {/* eslint-enable @next/next/no-html-link-for-pages */}
        </div>
      </body>
    </html>
  );
}
