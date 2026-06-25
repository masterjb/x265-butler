// Phase 42 Plan 42-01 — forced-polling stat-rate cap resolver.
//
// Root-cause (strace-confirmed 2026-06-25): chokidar `usePolling:true` +
// `interval:2000` + `depth:99` on a FUSE/shfs share stat()s EVERY watched path
// (files AND directories) every tick. Reporter cmeyer86: 620 684 statx in 10 s
// (~62 k/s) on ~11 685 files ⇒ paths ≈ 10× files (depth:99 walks dirs too) ⇒
// ~124 k watched paths. That saturates the 4-thread libuv pool and starves the
// Node SSR request path (TTFB /diagnostics 7.2 s).
//
// Fix lever (CONTEXT decision 2026-06-25 = scale-by-count): raise the chokidar
// `interval` proportionally to the watched-path count so the COMPUTED stat-rate
// stays under a conservative ceiling. Larger library ⇒ longer interval ⇒ flat
// stat-rate. Watch latency grows (documented tradeoff) but the pool no longer
// thrashes. UV_THREADPOOL_SIZE only SPREADS the load (UV8<UV16<UV32 = symptom
// relief, not a fix); this REDUCES it.
//
// Pattern mirrors resolveEncodeNice (child-priority.ts) / X265_POOLS (profiles.ts):
// reject-to-default (NOT clamp — a typo'd value should surface), env-parse
// memoized + warn-once, resolved value logged at info (survives the LOG_LEVEL
// gate → ring-buffer; NEVER debug — the 22-01→38-02 dark-surface bug).

import { logger as defaultLogger } from '../logger';

type IntervalLogger = Pick<typeof defaultLogger, 'info' | 'warn'>;

// Mirrors watcher.ts DEFAULTS.forcedPollingIntervalMs (the pre-42 fixed interval
// and the scaling floor — small libraries keep the snappy 2 s poll).
export const BASE_POLL_INTERVAL_MS = 2_000;

// Conservative computed-stat-rate ceiling. strace anchor: the pathological load
// was ~62 k statx/s at the 2 s fixed interval; 500/s keeps the 4-thread libuv
// pool well clear of saturation. At the measured ~124 k paths this yields a
// ~248 s effective interval (under MAX) — a ≥10× rate reduction vs the 2 s fix.
export const TARGET_STATS_PER_SEC = 500;

// Generous safety ceiling. MUST be minutes-range: at the measured ~124 k paths a
// 30 s cap would only floor the rate at ~4 k/s (still pool-saturating). 5 min
// lets the scaling engage fully for very large libraries before the cap bites.
export const MAX_POLL_INTERVAL_MS = 300_000;

// chokidar `depth:99` stat()s every directory AND file, not just files. The
// strace proved watched paths ≈ 10× the file count. The resolver scales over
// realPaths = watchedFileCount × PATHS_PER_FILE so the cap actually engages at
// the MEASURED load — a bare file-count scale underestimates the interval ~10×
// and misses AC-2 at exactly the N the strace measured (audit M2 / AC-7).
export const PATHS_PER_FILE = 10;

// The pre-42 default that bump-version/seed wrote into autoScan.pollInterval. A
// stored value equal to this is treated as "never explicitly overridden" so the
// scaling is NOT disabled on every existing install (audit M3 / AC-8).
const OLD_DEFAULT_SENTINEL_MS = 2_000;

export interface PollIntervalResolution {
  ms: number;
  source: 'env' | 'setting' | 'scaled' | 'default';
  watchedFileCount: number;
  realPaths: number;
  pathMultiplier: number;
  computedStatsPerSec: number;
}

export interface ResolvePollIntervalArgs {
  watchedFileCount: number;
  // The operator-EXPLICIT autoScan.pollInterval override, already raw-checked by
  // the caller (settingRepo.get() !== undefined → parsed int; otherwise null).
  // The OLD_DEFAULT_SENTINEL guard below additionally rejects a stored 2000 so a
  // never-touched install still scales (AC-8).
  settingExplicitMs?: number | null;
  pathMultiplier?: number;
}

// undefined = unresolved; number = explicit valid env; null = unset/invalid.
let _envCache: number | null | undefined;
let _envInvalidWarned = false; // warn-once per process (audit S4) — NOT per share.

function resolveEnvMs(log: IntervalLogger): number | null {
  if (_envCache !== undefined) return _envCache;

  const raw = process.env.WATCH_POLL_INTERVAL_MS;
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') {
    _envCache = null;
    return null;
  }

  const n = Number(trimmed);
  if (Number.isInteger(n) && n > 0) {
    _envCache = n;
    return n;
  }

  // Invalid (NaN / ≤0 / float / junk) → reject to size-scaling + warn ONCE. The
  // warn hangs off the memoized parse so it fires once per PROCESS, not once per
  // share (N shares would otherwise spam the log — mirrors WATCH_INGEST_CONCURRENCY
  // 28-06 SR-1, but here we DO warn because the env-parse is memoized, not per-flush).
  _envCache = null;
  if (!_envInvalidWarned) {
    _envInvalidWarned = true;
    log.warn(
      { action: 'watch_poll_interval_invalid', raw, fallback: 'size-scaled' },
      'watch-poll: WATCH_POLL_INTERVAL_MS invalid (non-integer / ≤0) — falling back to size-scaled interval',
    );
  }
  return null;
}

function clamp(lo: number, value: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/**
 * Resolve the effective chokidar poll `interval` for ONE forced-polling share.
 *
 * Precedence (audit M3 / AC-8): env-explicit > setting-EXPLICIT-≠2000 > scaled > base.
 *  - env-explicit:   WATCH_POLL_INTERVAL_MS, a valid positive int, used verbatim.
 *  - setting:        an operator-set autoScan.pollInterval ≠ old-default 2000.
 *  - scaled:         clamp(BASE, ceil(realPaths / TARGET × 1000), MAX) — the fix.
 *  - default:        the scaled result floored to BASE (small library / N=0).
 *
 * computedStatsPerSec is derived from realPaths (NOT bare files) so the
 * self-diagnosis does not under-report the true stat-rate ~10× (audit S2 / AC-10).
 *
 * Logs `watch_poll_interval_resolved` at info ONCE per call (= once per share-start).
 */
export function resolvePollIntervalMs(
  args: ResolvePollIntervalArgs,
  log: IntervalLogger = defaultLogger,
): PollIntervalResolution {
  const watchedFileCount =
    Number.isFinite(args.watchedFileCount) && args.watchedFileCount > 0
      ? Math.floor(args.watchedFileCount)
      : 0;
  const pathMultiplier =
    typeof args.pathMultiplier === 'number' && args.pathMultiplier > 0
      ? args.pathMultiplier
      : PATHS_PER_FILE;
  const realPaths = watchedFileCount * pathMultiplier;

  const envMs = resolveEnvMs(log);
  const settingExplicitMs = args.settingExplicitMs;

  let ms: number;
  let source: PollIntervalResolution['source'];
  if (envMs !== null) {
    ms = envMs;
    source = 'env';
  } else if (
    settingExplicitMs != null &&
    settingExplicitMs > 0 &&
    settingExplicitMs !== OLD_DEFAULT_SENTINEL_MS
  ) {
    ms = settingExplicitMs;
    source = 'setting';
  } else {
    const scaledRaw = realPaths > 0 ? Math.ceil((realPaths / TARGET_STATS_PER_SEC) * 1000) : 0;
    ms = clamp(BASE_POLL_INTERVAL_MS, scaledRaw, MAX_POLL_INTERVAL_MS);
    source = scaledRaw > BASE_POLL_INTERVAL_MS ? 'scaled' : 'default';
  }

  const computedStatsPerSec = ms > 0 ? Math.round((realPaths / ms) * 1000) : 0;

  log.info(
    {
      action: 'watch_poll_interval_resolved',
      resolvedMs: ms,
      source,
      watchedFileCount,
      realPaths,
      pathMultiplier,
      computedStatsPerSec,
    },
    'watch-poll: forced-polling interval resolved',
  );

  return { ms, source, watchedFileCount, realPaths, pathMultiplier, computedStatsPerSec };
}

// Test-only — clear the memoized env-parse + warn-once flag.
export function __forTests_resetPollIntervalEnv(): void {
  _envCache = undefined;
  _envInvalidWarned = false;
}
