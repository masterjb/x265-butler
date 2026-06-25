// 22-01 IMP-3: SQLite repo-method timing helper.
//
// Wraps repo public-method bodies in performance.now() deltas; emits a
// `slow_query` WARN event when the threshold is breached.
//
// 38-02 (dark-since-22-01 fix): this event was emitted at logger.debug, but the
// pino instance level is `LOG_LEVEL ?? 'info'`, so the debug line was dropped at
// the instance gate BEFORE the multistream fan-out → the ring-buffer writer
// never saw it → /api/diagnostics.slowQueries.topN was permanently [] and slow
// request-path queries were invisible in container logs from 22-01 until 38-02.
// Emitting at WARN (40 > info 30) survives the `info` instance gate → reaches
// BOTH stdout and the ring-buffer writer (both per-stream level 'debug' ≤ warn).
// NOTE: info=30 would ALSO survive the info gate; WARN is chosen DELIBERATELY for
// consistency with the existing `storage_query_slow` warn path — do NOT silently
// revert to info/debug (recorded decision, AC-5).
//
// Canonical wrap-form per audit-M6: outer-method-body wrap (NOT inner-stmt wrap)
// for ALL ≥20 sites — coarse repo-method-granularity is the right resolution for
// B1a TTFB attribution; per-prepare wraps would balloon to 50+ sites with
// marginal investigation-value.
//
// Synchronous variant only — better-sqlite3 is sync. Throws propagate through
// the finally clause so the timing emit still fires on error paths.

import { logger } from '@/src/lib/logger';

// Default slow-query threshold (ms). Strict greater-than: durationMs > threshold
// emits. Operator-tunable via SLOW_QUERY_MS (38-02) — see resolveSlowQueryMs.
// Kept exported for back-compat (tests + importers reference it as the default).
export const SLOW_QUERY_MS = 100;

let _slowQueryMsCache: number | undefined; // undefined = not yet resolved

/**
 * Memoized module-load resolver for the slow-query threshold. Reads SLOW_QUERY_MS
 * ONCE and caches it — the wrapper is HOT (called on every repo method), so we
 * never read process.env per call. Pattern mirrors 38-01's resolveEncodeNice.
 *  - unset / empty → DEFAULT (100).
 *  - valid positive integer (> 0, Number.isInteger) → used verbatim.
 *  - NaN / ≤0 / float / junk → DEFAULT (100). Reject-to-default, NOT clamp (a
 *    typo'd value surfaces as the default, not a silent clamp — mirrors ENCODE_NICE).
 * Logs the resolution ONCE as an audit-info event.
 */
export function resolveSlowQueryMs(): number {
  if (_slowQueryMsCache !== undefined) return _slowQueryMsCache;

  const raw = process.env.SLOW_QUERY_MS;
  const trimmed = (raw ?? '').trim();
  const n = Number(trimmed);

  if (trimmed !== '' && Number.isInteger(n) && n > 0) {
    _slowQueryMsCache = n;
    logger.info(
      { action: 'slow_query_threshold_resolved', resolvedMs: _slowQueryMsCache, source: 'env' },
      'slow_query_threshold_resolved',
    );
    return _slowQueryMsCache;
  }

  _slowQueryMsCache = SLOW_QUERY_MS;
  logger.info(
    { action: 'slow_query_threshold_resolved', resolvedMs: _slowQueryMsCache, source: 'default' },
    'slow_query_threshold_resolved',
  );
  return _slowQueryMsCache;
}

export function withQueryTiming<T>(name: string, fn: () => T): T {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    const durationMs = performance.now() - t0;
    if (durationMs > resolveSlowQueryMs()) {
      logger.warn({ action: 'slow_query', queryName: name, durationMs }, 'slow_query');
    }
  }
}

// Test-only — clear the memo so a test can re-resolve under a different env.
export function __forTests_resetSlowQueryMs(): void {
  _slowQueryMsCache = undefined;
}
