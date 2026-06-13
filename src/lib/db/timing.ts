// 22-01 IMP-3: SQLite repo-method timing helper.
//
// Wraps repo public-method bodies in performance.now() deltas; emits
// `slow_query` pino-debug when threshold breached. Canonical wrap-form per
// audit-M6: outer-method-body wrap (NOT inner-stmt wrap) for ALL ≥20 sites
// — coarse repo-method-granularity is the right resolution for B1a TTFB
// attribution; per-prepare wraps would balloon to 50+ sites with marginal
// investigation-value.
//
// Synchronous variant only — better-sqlite3 is sync. Throws propagate through
// the finally clause so the timing emit still fires on error paths.

import { logger } from '@/src/lib/logger';

// Module-const threshold (ms). Operator-config deferred per Plan boundaries.
// Strict greater-than: durationMs > SLOW_QUERY_MS emits.
export const SLOW_QUERY_MS = 100;

export function withQueryTiming<T>(name: string, fn: () => T): T {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    const durationMs = performance.now() - t0;
    if (durationMs > SLOW_QUERY_MS) {
      logger.debug({ action: 'slow_query', queryName: name, durationMs }, 'slow_query');
    }
  }
}
