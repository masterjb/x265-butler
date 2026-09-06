// ISS-002 (2026-09-06): the SINGLE place that reads the `cache_pool_path`
// setting out of the DB and hands back an ALREADY-RESOLVED path.
//
// WHY THIS FILE EXISTS — the same bug shipped twice.
// `resolveEffectiveCachePath` (24-03 DC-B) turns an UNSET setting into an
// auto-resolved root (`/mnt/cache/x265-butler` or `/config/cache`). A caller
// that reads `settingRepo().get('cache_pool_path')` RAW and guards on falsy
// therefore takes a "no path configured" branch on every install that never
// set an override — which is the DEFAULT since 24-03 and, after the 36-03
// legacy-row migration, ALSO every upgrader.
//   - ISS-001 (36-03): the 1h log-retention sweep skipped itself entirely.
//   - ISS-002 (this): GET /api/logs/[jobId] and .../download returned 404
//     `log_not_found` for EVERY job while the encoder was writing the logs to
//     the auto-resolved root all along. Operators saw "nothing loads" and
//     chased filesystem permissions that were never the cause.
//
// The fix is not the two call sites — it is removing the raw read as an
// available shape. `tests/encode/cache-path-raw-read-gate.test.ts` fails the
// suite when a new raw read appears outside the documented allowlist.
//
// SERVER-ONLY. Pulls in `@/src/lib/db` (better-sqlite3) and, through
// cache-path → staging, `node:fs`. NEVER import this from a `'use client'`
// file — that is the 49-05 client-bundle trap (type-correct, so neither tsc
// nor vitest catch it; it fails in `npm run build`).

import { settingRepo } from '@/src/lib/db';
import {
  resolveEffectiveCachePath,
  resolveEffectiveCachePathCached,
  type EffectiveCachePath,
} from './cache-path';

const CACHE_POOL_PATH_SETTING = 'cache_pool_path';

/**
 * FRESH (uncached) resolution — the dispatch-equivalent read.
 *
 * Use where a late-mounting `/mnt/cache` must be honoured at call time and the
 * call cadence is low enough that a write-probe per call is free: the 1h
 * retention sweep (ISS-001). Do NOT use it on a 60s poll or a per-render
 * surface — that is a probe storm; use the Cached variant there.
 */
export function readEffectiveCachePathFresh(probeWritable?: () => boolean): EffectiveCachePath {
  const stored = settingRepo().get(CACHE_POOL_PATH_SETTING);
  // The probe default lives in cache-path.ts and is NOT re-stated here: passing
  // it on explicitly would make this accessor a second place that decides how
  // an unset setting is probed. Forwarding only what the caller gave also keeps
  // the resolver's call shape unchanged for its existing tests.
  return probeWritable === undefined
    ? resolveEffectiveCachePath(stored)
    : resolveEffectiveCachePath(stored, probeWritable);
}

/**
 * CACHED resolution (24-03 READ_SURFACE_TTL_MS) — the read-surface variant.
 *
 * Use on request handlers, polls and server-component renders. A setting
 * change is picked up within one TTL; dispatch is unaffected (it holds its own
 * fresh read).
 */
export function readEffectiveCachePathCached(
  now: number = Date.now(),
  probeWritable?: () => boolean,
): EffectiveCachePath {
  const stored = settingRepo().get(CACHE_POOL_PATH_SETTING);
  return probeWritable === undefined
    ? resolveEffectiveCachePathCached(stored, now)
    : resolveEffectiveCachePathCached(stored, now, probeWritable);
}
