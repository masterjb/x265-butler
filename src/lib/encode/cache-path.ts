// 24-03 (F2): DC-B cache-pool auto-resolution. When `cache_pool_path` is UNSET,
// resolve the effective cache root at read time: probe `/mnt/cache` writable →
// `/mnt/cache/x265-butler` (back-compat for unRAID array users); else fall back
// to `/config/cache` (always-mounted appdata, alongside /config/x265-butler.db).
// An explicit operator override is honoured verbatim with NO probe.
//
// Design invariants (24-03 audit 2026-05-31):
//   - resolveEffectiveCachePath is PURE + uncached + side-effect-isolated. ONLY
//     the dispatch chokepoint (orchestrator.ts readSettings) + unit tests call
//     it directly — dispatch MUST stay fresh-per-read to honour a late-mounting
//     /mnt/cache (matches the existing fresh-read-at-dispatch contract).
//   - The probe is PROBE-ONLY: it NEVER mkdirs /mnt/cache (would create a
//     misleading empty mount-point on a host that lacks it). Reuses the 22-02
//     write-probe verbatim via probeCachePoolWritable.
//   - Read surfaces (diagnostics aggregator + Settings page render) call the
//     `Cached` wrapper EXCLUSIVELY so a 60s banner-poll / per-render does NOT
//     emit a /mnt/cache write-probe each time (AC-10 — collapse to ≤1 probe/TTL).

import { probeCachePoolWritable } from './staging';

export type CacheResolution = 'user-override' | 'mnt-cache' | 'config-fallback';

export interface EffectiveCachePath {
  effectivePath: string;
  resolution: CacheResolution;
}

// Single source of truth for the label-style /mnt/cache default. Aliased by
// orchestrator's legacy DEFAULT_CACHE_POOL_PATH const for any other reader.
export const MNT_CACHE_DEFAULT = '/mnt/cache/x265-butler';
// user-pick A1 (2026-05-31): config-fallback lives in the always-mounted
// appdata volume next to /config/x265-butler.db.
export const CONFIG_CACHE_FALLBACK = '/config/cache';
// The probe target is the share ROOT, not the x265-butler subdir — we are
// testing whether the /mnt/cache mount itself is writable (the subdir does not
// exist until first dispatch mkdirs it).
export const MNT_CACHE_PROBE_ROOT = '/mnt/cache';

/**
 * Default /mnt/cache writability probe. Wraps the 22-02 probeCachePoolWritable
 * write-probe (FUSE-safe writefile-`wx` + unlink) in try/catch → returns false
 * on ANY throw (CachePoolUnavailableError for ENOENT/EACCES/EROFS OR a
 * shape-error). NEVER mkdirs — probe-only, must not create /mnt/cache on a host
 * that lacks it. Swallowing all throws means the resolver can NEVER throw, so a
 * server-page render can never 500 on a probe failure (degrades to
 * config-fallback).
 */
export function defaultProbeMntCacheWritable(): boolean {
  try {
    probeCachePoolWritable(MNT_CACHE_PROBE_ROOT);
    return true;
  } catch {
    return false;
  }
}

/**
 * PURE resolver — dispatch path. Injectable probe for hermetic tests.
 *   - settingValue non-empty (trimmed)  → user-override, verbatim, NO probe
 *   - unset + /mnt/cache writable        → mnt-cache  (/mnt/cache/x265-butler)
 *   - unset + /mnt/cache not writable    → config-fallback (/config/cache)
 */
export function resolveEffectiveCachePath(
  settingValue: string | undefined,
  probeWritable: () => boolean = defaultProbeMntCacheWritable,
): EffectiveCachePath {
  const trimmed = (settingValue ?? '').trim();
  if (trimmed.length > 0) {
    return { effectivePath: trimmed, resolution: 'user-override' };
  }
  return probeWritable()
    ? { effectivePath: MNT_CACHE_DEFAULT, resolution: 'mnt-cache' }
    : { effectivePath: CONFIG_CACHE_FALLBACK, resolution: 'config-fallback' };
}

// ── Read-surface rate-bound (AC-10) ───────────────────────────────────────
// A thin memo wrapper for the READ-only surfaces (diagnostics aggregator +
// Settings page render) so they do NOT emit a /mnt/cache write-probe on every
// 60s banner-poll / every render. The memo is process-global (module scope) —
// a value at most TTL-old is acceptable for evidence/render. The DISPATCH path
// is unaffected (it calls the PURE variant). TTL ≤10s honours a late-mount
// within seconds while collapsing the per-poll/per-render write-storm.
let _memo: { at: number; val: EffectiveCachePath } | null = null;
export const READ_SURFACE_TTL_MS = 10_000;

/**
 * Cached read-surface variant. `now` is injectable for hermetic specs (some
 * runtimes ban Date.now()). user-override never probes, but we cache uniformly
 * for simplicity — a setting change is picked up within ≤TTL on the read
 * surfaces (dispatch reflects it immediately via the pure variant).
 */
export function resolveEffectiveCachePathCached(
  settingValue: string | undefined,
  now: number = Date.now(),
  probeWritable: () => boolean = defaultProbeMntCacheWritable,
): EffectiveCachePath {
  if (_memo && now - _memo.at < READ_SURFACE_TTL_MS) return _memo.val;
  const val = resolveEffectiveCachePath(settingValue, probeWritable);
  _memo = { at: now, val };
  return val;
}

/** test-only reset to keep specs hermetic. */
export function __resetCachePathMemo(): void {
  _memo = null;
}
