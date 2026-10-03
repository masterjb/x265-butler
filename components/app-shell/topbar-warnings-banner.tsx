'use client';

// Phase 21 Plan 21-04 — Topbar warnings banner.
//
// Surfaces non-encoder AggregatedWarning[] from /api/diagnostics with per-code
// 24h-localStorage dismiss + muted restore-pill + kill-switch + audit-trail.
// Bell-coexistence: source='encoder' entries are FILTERED OUT (encoder warnings
// remain NotificationBell's sovereignty per OQ-B α).
//
// audit-M1: localStorage resilience — try/catch wrappers around getItem/setItem
//   tolerate private-browsing SecurityError / QuotaExceededError / corrupted
//   JSON / non-number values; banner falls back to in-memory-only dismiss mode.
// audit-M2: banner uses its own sticky-wrapper at z-10 (under Topbar z-20),
//   positioned at top-14 / lg:top-16 below the Topbar height. The wrapper
//   deliberately AVOIDS transform/filter/isolation/will-change CSS so it does
//   not create a new stacking context that would clip the Bell dropdown (z-50)
//   below the banner.
// audit-M5: visibleWarnings + visibleCount + hiddenCount are DERIVED via
//   useMemo from (rawWarnings + dismissedMap). NEVER stored as separate
//   useState — prevents poll-vs-dismiss race where a poll-tick during a
//   dismiss-click overwrites a stale derived list.
// audit-M6: client-side code-format guard (defense-in-depth alongside server
//   isValidWarningCode) — invalid codes are filtered from the visible list AND
//   substituted with '<invalid_code>' before fetch POST.
// audit-SR1: dismiss UX completes BEFORE POST. POST failure does NOT revert
//   state — console.warn once.
// audit-SR2: source-field allowlist ['mount','onboarding','aggregator'] —
//   unknown sources default-hide.
// audit-SR3: GET poll-error keeps last-known-good warnings (NOT cleared) —
//   console.warn once per failure-streak.
// audit-SR4: layout-shift on hydration is ACCEPTED (not mitigated) — banner
//   only renders when warnings.length > 0 which is rare on healthy installs;
//   reserving min-height would create permanent dead-space worse-trade-off.
// audit-SR6: NO bannerMounted event — passive surface, instrumentation fires
//   only on USER-initiated actions (dismiss / restore). Intentional asymmetry
//   vs. 21-02 diagnostics-page mount-emit (global-always-on chrome would
//   saturate the metric).
// audit-SR7: count-text region uses role="status" + aria-atomic="true" +
//   aria-live="off"; user-action confirmations announced via separate sr-only
//   aria-live="polite" region to avoid poll-driven SR-spam.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { AlertCircle, AlertTriangle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AggregatedWarning, DiagnosticsPayload } from '@/src/lib/diagnostics/types';

const KILL = process.env.NEXT_PUBLIC_DIAGNOSTICS_BANNER_DISABLED === '1';
const POLL_INTERVAL_MS = 60_000;
const DISMISS_TTL_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'x265butler.diagnosticsBanner.dismissed';
const FETCH_TIMEOUT_MS = 10_000;
const VALID_SOURCES: ReadonlySet<AggregatedWarning['source']> = new Set([
  'mount',
  'onboarding',
  'aggregator',
]);
const CODE_REGEX = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

type DismissedMap = Record<string, number>;

// audit-M1: resilient read. Returns {} on any failure path (SecurityError,
// corrupted JSON, non-object root, non-number values).
function readDismissed(): DismissedMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: DismissedMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch (e) {
    console.warn('[topbar-warnings-banner] localStorage read failed', e);
    return {};
  }
}

// audit-M1: resilient write. QuotaExceededError / SecurityError are swallowed;
// in-memory state still mutates so the dismiss reflects this session.
function writeDismissed(value: DismissedMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch (e) {
    console.warn('[topbar-warnings-banner] localStorage write failed', e);
  }
}

let codeValidatorWarnedOnce = false;
function isValidWarningCodeClient(code: unknown): code is string {
  return typeof code === 'string' && CODE_REGEX.test(code);
}

function severityIcon(severity: AggregatedWarning['severity']) {
  if (severity === 'error') {
    return <AlertCircle className="h-4 w-4 text-destructive" aria-hidden="true" />;
  }
  return (
    <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-hidden="true" />
  );
}

function severityClasses(severity: AggregatedWarning['severity']): string {
  if (severity === 'error') return 'border-l-destructive bg-destructive/5';
  return 'border-l-amber-500 dark:border-l-amber-400 bg-amber-50/50 dark:bg-amber-950/20';
}

// Module-load kill-switch wrapper. Returning null BEFORE any hook call keeps
// Rules of Hooks satisfied (the inner component is never mounted when KILL).
export function TopbarWarningsBanner() {
  if (KILL) return null;
  return <BannerImpl />;
}

function BannerImpl() {
  const t = useTranslations();
  const locale = useLocale();
  const [rawWarnings, setRawWarnings] = useState<AggregatedWarning[]>([]);
  const [dismissedMap, setDismissedMap] = useState<DismissedMap>({});
  const [actionAnnounce, setActionAnnounce] = useState<string>('');
  const fetchFailedOnceRef = useRef(false);

  useEffect(() => {
    setDismissedMap(readDismissed());
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controllers = new Set<AbortController>();

    const tick = async () => {
      const ac = new AbortController();
      controllers.add(ac);
      const timeoutId = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch('/api/diagnostics', { cache: 'no-store', signal: ac.signal });
        if (!res.ok) throw new Error(`status=${res.status}`);
        const body = (await res.json()) as DiagnosticsPayload;
        if (cancelled) return;
        const next = Array.isArray(body?.warnings) ? body.warnings : [];
        setRawWarnings(next);
        fetchFailedOnceRef.current = false;
      } catch (e) {
        if (cancelled) return;
        // audit-SR3: keep last-known-good — do NOT setRawWarnings([]).
        if (!fetchFailedOnceRef.current) {
          fetchFailedOnceRef.current = true;
          console.warn('[topbar-warnings-banner] /api/diagnostics fetch failed', e);
        }
      } finally {
        clearTimeout(timeoutId);
        controllers.delete(ac);
      }
    };

    void tick();
    const id = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      for (const ac of controllers) ac.abort();
    };
  }, []);

  // audit-M5: DERIVED state via useMemo. Filter pipeline cheapest-first:
  //   1. drop source='encoder' (Bell coexistence)
  //   2. drop unknown source (audit-SR2 default-hide)
  //   3. drop invalid code format (audit-M6 defense-in-depth)
  //   4. drop dismissed-within-TTL (24h auto-revive on stale ts)
  const { totalActive, visibleWarnings, hiddenCount } = useMemo(() => {
    const now = Date.now();
    const activeList = rawWarnings.filter((w) => {
      if (!w || typeof w !== 'object') return false;
      if (w.source === 'encoder') return false;
      if (!VALID_SOURCES.has(w.source)) return false;
      if (!isValidWarningCodeClient(w.code)) return false;
      return true;
    });
    const visibleList = activeList.filter((w) => {
      const dismissedAt = dismissedMap[w.code];
      if (typeof dismissedAt !== 'number' || !Number.isFinite(dismissedAt)) return true;
      return now - dismissedAt > DISMISS_TTL_MS;
    });
    return {
      totalActive: activeList.length,
      visibleWarnings: visibleList,
      hiddenCount: activeList.length - visibleList.length,
    };
  }, [rawWarnings, dismissedMap]);

  const handleDismiss = useCallback(
    (warning: AggregatedWarning) => {
      // audit-SR1: state update synchronous BEFORE POST. POST failure does NOT
      // revert state.
      setDismissedMap((prev) => {
        const next = { ...prev, [warning.code]: Date.now() };
        writeDismissed(next);
        return next;
      });
      setActionAnnounce(t('diagnostics.banner.announce.dismissed', { code: warning.code }));

      // audit-M6 defense-in-depth: validate code before POST. Server also
      // validates; this prevents a needless 200-with-substitution roundtrip.
      let codeToEmit = warning.code;
      if (!isValidWarningCodeClient(warning.code)) {
        codeToEmit = '<invalid_code>';
        if (!codeValidatorWarnedOnce) {
          codeValidatorWarnedOnce = true;
          console.warn(
            '[topbar-warnings-banner] invalid warning code substituted before emit',
            warning.code,
          );
        }
      }

      const ac = new AbortController();
      const timeoutId = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      void fetch('/api/diagnostics/log-event', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'bannerDismissed',
          payload: {
            source: 'topbar-banner',
            code: codeToEmit,
            severity: warning.severity,
            warningSource: warning.source,
          },
        }),
        signal: ac.signal,
      })
        .then((res) => {
          if (!res.ok) {
            console.warn(`[topbar-warnings-banner] log-event POST failed: status=${res.status}`);
          }
        })
        .catch((e) => {
          const name = (e as { name?: string })?.name;
          if (name !== 'AbortError') {
            console.warn('[topbar-warnings-banner] log-event POST failed', e);
          }
        })
        .finally(() => clearTimeout(timeoutId));
    },
    [t],
  );

  const handleRestore = useCallback(() => {
    const restoredCount = hiddenCount;
    setDismissedMap({});
    writeDismissed({});
    setActionAnnounce(t('diagnostics.banner.announce.restored', { count: restoredCount }));

    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    void fetch('/api/diagnostics/log-event', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'bannerRestored',
        payload: { source: 'topbar-banner', restoredCount },
      }),
      signal: ac.signal,
    })
      .then((res) => {
        if (!res.ok) {
          console.warn(`[topbar-warnings-banner] log-event POST failed: status=${res.status}`);
        }
      })
      .catch((e) => {
        const name = (e as { name?: string })?.name;
        if (name !== 'AbortError') {
          console.warn('[topbar-warnings-banner] log-event POST failed', e);
        }
      })
      .finally(() => clearTimeout(timeoutId));
  }, [hiddenCount, t]);

  if (totalActive === 0) return null;

  if (visibleWarnings.length === 0 && hiddenCount > 0) {
    return (
      <div
        className="sticky top-14 z-10 border-b border-border bg-background lg:top-16"
        data-testid="topbar-warnings-restore-wrapper"
      >
        <div
          role="status"
          aria-atomic="true"
          aria-live="off"
          className="flex items-center justify-between gap-3 px-4 py-2 text-xs text-muted-foreground"
        >
          <span className="flex items-center gap-2">
            <Info className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <span>{t('diagnostics.banner.restorePill.label', { count: hiddenCount })}</span>
          </span>
          <button
            type="button"
            onClick={handleRestore}
            aria-label={t('diagnostics.banner.restorePill.restoreAria')}
            className="inline-flex h-9 items-center justify-center rounded px-3 text-xs font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="topbar-warnings-restore-cta"
          >
            {t('diagnostics.banner.restorePill.cta')}
          </button>
        </div>
        <span aria-live="polite" className="sr-only">
          {actionAnnounce}
        </span>
      </div>
    );
  }

  const highestSeverity: AggregatedWarning['severity'] = visibleWarnings.some(
    (w) => w.severity === 'error',
  )
    ? 'error'
    : 'warn';

  return (
    <div
      className="sticky top-14 z-10 border-b border-border bg-background lg:top-16"
      data-testid="topbar-warnings-wrapper"
    >
      <div
        className={cn(
          'flex flex-col gap-2 border-l-4 px-4 py-2 sm:flex-row sm:items-center sm:justify-between',
          severityClasses(highestSeverity),
        )}
      >
        <div
          role="status"
          aria-atomic="true"
          aria-live="off"
          className="flex items-center gap-2 text-sm font-medium text-foreground"
        >
          {severityIcon(highestSeverity)}
          <span data-testid="topbar-warnings-count">
            {visibleWarnings.length === 1
              ? t('diagnostics.banner.countOne', { count: visibleWarnings.length })
              : t('diagnostics.banner.countMany', { count: visibleWarnings.length })}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {visibleWarnings.map((w) => (
            <button
              key={w.code}
              type="button"
              onClick={() => handleDismiss(w)}
              aria-label={t('diagnostics.banner.dismiss.aria', { code: w.code })}
              title={w.message}
              className="inline-flex h-11 w-11 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid={`topbar-warnings-dismiss-${w.code}`}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          ))}
          <Link
            href={`/${locale}/diagnostics`}
            className="inline-flex h-11 items-center justify-center rounded px-3 text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="topbar-warnings-cta"
          >
            {t('diagnostics.banner.cta.viewDiagnostics')} →
          </Link>
        </div>
      </div>
      <span aria-live="polite" className="sr-only">
        {actionAnnounce}
      </span>
    </div>
  );
}
