'use client';

// 22-01 IMP-4: hand-rolled Web Vitals reporter (ZERO new npm deps).
//
// Mounts in app/[locale]/layout.tsx. PerformanceObserver-driven; posts each
// observed TTFB / LCP / INP to /api/diagnostics/log-event with the
// webVitalCaptured event name. Reuses existing log-event-route envelope —
// NO new endpoint, ZERO new deps.
//
// audit-M2 dedup: TTFB once-per-mount (ttfbPostedRef); LCP entries deduped via
// `${entryType}:${startTime}` set (suppresses buffered-replay duplicates on
// pathname change).
// audit-SR1 normalization: routes piped through normalizeRoute() to redact
// share-tokens before persistence.
// audit-SR6 INP debounce: maxInp tracked over event-timing entries; post
// debounced (INP_DEBOUNCE_MS) on maxInp increase + pagehide-flush listener
// for user-leaves-before-debounce-fires.

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { normalizeRoute } from '@/src/lib/diagnostics/route-normalizer';

const ENDPOINT = '/api/diagnostics/log-event';
const INP_DEBOUNCE_MS = 500;

type Metric = 'ttfb' | 'lcp' | 'inp';

async function postVital(metric: Metric, value: number, route: string): Promise<void> {
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'webVitalCaptured',
        metric,
        value,
        route: normalizeRoute(route),
        atIso: new Date().toISOString(),
      }),
      keepalive: true,
    });
  } catch {
    // Best-effort fire-and-forget — diagnostics is non-essential.
  }
}

export function WebVitalsReporter(): null {
  const pathname = usePathname() ?? '/';
  const ttfbPostedRef = useRef(false);
  const processedLcpRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // TTFB — Navigation Timing Level 2. audit-M2: post exactly once per mount.
    if (!ttfbPostedRef.current) {
      const navEntries = performance.getEntriesByType('navigation');
      const nav = navEntries[0] as PerformanceNavigationTiming | undefined;
      if (nav && Number.isFinite(nav.responseStart)) {
        const ttfb = nav.responseStart;
        if (ttfb > 0) {
          void postVital('ttfb', ttfb, pathname);
          ttfbPostedRef.current = true;
        }
      }
    }

    // LCP — PerformanceObserver. audit-M2: dedup via processedLcpRef Set.
    let lcpObserver: PerformanceObserver | null = null;
    try {
      lcpObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const key = `${entry.entryType}:${entry.startTime}`;
          if (processedLcpRef.current.has(key)) continue;
          processedLcpRef.current.add(key);
          void postVital('lcp', entry.startTime, pathname);
        }
      });
      lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
      // PerformanceObserver / LCP entry unsupported — skip silently.
    }

    // INP — event-timing entries; max duration tracked, posts debounced.
    let inpObserver: PerformanceObserver | null = null;
    let maxInp = 0;
    let inpTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      inpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries() as PerformanceEntry[];
        for (const entry of entries) {
          const dur = (entry as PerformanceEntry & { duration?: number }).duration ?? 0;
          if (dur > maxInp) {
            maxInp = dur;
            if (inpTimer) clearTimeout(inpTimer);
            inpTimer = setTimeout(() => void postVital('inp', maxInp, pathname), INP_DEBOUNCE_MS);
          }
        }
      });
      inpObserver.observe({
        type: 'event',
        buffered: true,
        durationThreshold: 40,
      } as PerformanceObserverInit);
    } catch {
      // event-timing unsupported — skip silently.
    }

    // audit-SR6: pagehide-flush listener for unfinished INP debounces.
    const onPageHide = (): void => {
      if (inpTimer) {
        clearTimeout(inpTimer);
        if (maxInp > 0) void postVital('inp', maxInp, pathname);
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', onPageHide);
    }

    return () => {
      lcpObserver?.disconnect();
      inpObserver?.disconnect();
      if (inpTimer) clearTimeout(inpTimer);
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', onPageHide);
      }
    };
  }, [pathname]);

  return null;
}
