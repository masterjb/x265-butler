// 48-02 (Bundle A + B): SINGLE source of truth for the two system-path lists.
//
// Reporter R2 (unRAID forum, v2.44.0) configured a share whose path encloses
// `/`. `shares-zod.ts` had no prefix guard, so chokidar (`depth:99`) recursed
// the container rootfs, produced one EACCES per `/sys` path, and the unthrottled
// WARN per error flushed the ring buffer until the container died.
//
// TWO lists, deliberately DIFFERENT — do not collapse them:
//
//   FORBIDDEN_SHARE_PREFIXES — the VALIDATION list (Bundle A). Mirrors
//     `FORBIDDEN_CACHE_PREFIXES` (app/api/settings/route.ts:373) and adds
//     `/run` (tmpfs — a share there is never a media library). This list is
//     about "an operator must not be able to configure this", so it is wide.
//
//   PRUNE_SYSTEM_PREFIXES — the RUNTIME list (Bundle B), applied by the scan
//     walker and by chokidar's `ignored` regardless of what is configured, so
//     an ALREADY-broken install heals with no operator action. Narrower on
//     purpose: `/etc` and `/boot` are small and readable, they do not produce
//     the stat storm, and pruning them would be behaviour change that buys
//     nothing.
//
// Residual risk (stated, not papered over): with a `/` root the walk/watch
// still covers `/usr`, `/var`, `/tmp`, `/etc`, `/boot` and the container's own
// `/config`. B stops the EACCES storm and the descriptor exhaustion; it does
// NOT make `/` a sane share root. The operator-facing exit is the
// `share_path_forbidden_prefix_stored` WARN plus Guard A on the next edit.
//
// NOT refactored here on purpose: `FORBIDDEN_CACHE_PREFIXES`
// (app/api/settings/route.ts) and `FORBIDDEN_SIDECAR_PREFIXES`
// (components/settings/settings-form.tsx) keep their own copies — a drive-by
// consolidation of two working guards is unpaid risk on a hotfix path.

import { logger } from '../logger';

export const FORBIDDEN_SHARE_PREFIXES: readonly string[] = [
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/run',
];

export const PRUNE_SYSTEM_PREFIXES: readonly string[] = ['/proc', '/sys', '/dev', '/run'];

/**
 * DEFENSIVE normalization — deliberately does NOT trust its caller.
 *
 * `isForbiddenSharePath` is reached from two different Zod schemas with
 * different upstream refines (`shares-zod.pathSchema` collapses double slashes
 * via `.transform()`; a future third door may not). A guard whose correctness
 * depends on what ran before it is not a guard, so the collapse + trailing-slash
 * strip happen here as well.
 */
function normalize(p: string): string {
  const collapsed = p.replace(/\/{2,}/g, '/');
  const stripped = collapsed.replace(/\/+$/, '');
  return stripped;
}

/** SEGMENT-exact prefix test: '/etcetera' must NOT match '/etc'. */
function isUnderAny(norm: string, prefixes: readonly string[]): boolean {
  return prefixes.some((bad) => norm === bad || norm.startsWith(`${bad}/`));
}

/**
 * Bundle A — may this path be stored as a share / scan root?
 *
 * Rejects the bare root, every FORBIDDEN_SHARE_PREFIXES entry (segment-exact),
 * any surviving `..` segment and any NUL byte.
 */
export function isForbiddenSharePath(p: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (/\x00/.test(p)) return true;
  const norm = normalize(p);
  // '' is what a bare '/' (or '//', '///') normalizes to — both are the root.
  if (norm === '' || norm === '/') return true;
  if (norm.split('/').some((seg) => seg === '..')) return true;
  return isUnderAny(norm, FORBIDDEN_SHARE_PREFIXES);
}

// 48-02 (audit M6): TEST SEAM. The production prune list is ABSOLUTE
// ('/proc', …) while a vitest fixture tree lives under `os.tmpdir()`, so no
// fixture path can ever match it and AC-5/AC-6/AC-7b/AC-8 would be untestable —
// i.e. shipped blind. Shaped and documented like `__resetScanIntegrityForTests`
// (scan-integrity-store.ts:77): TEST-ONLY, production code NEVER calls it.
let pruneListOverride: readonly string[] | null = null;

export function __setPruneSystemPrefixesForTests(list: string[] | null): void {
  pruneListOverride = list;
}

function activePruneList(): readonly string[] {
  return pruneListOverride ?? PRUNE_SYSTEM_PREFIXES;
}

/**
 * Bundle B — is this path at or under a runtime-pruned system prefix?
 * Same segment-exact rule as `isForbiddenSharePath`.
 */
export function isUnderPruneSystemPrefix(p: string): boolean {
  const norm = normalize(p);
  if (norm === '' || norm === '/') return false; // '/' is NOT a prune prefix (AC-6)
  return isUnderAny(norm, activePruneList());
}

// 48-02 kill-switch. Follows the resolveEncodeNice / resolvePollIntervalMs
// pattern: memoized, logged ONCE at info (≥ `telemetry` (25) reaches the
// ring-buffer; `debug` (20) does not — the 22-01 → 38-02 dark-surface trap;
// tier table in src/lib/logger.ts), restart required.
//
// `SCAN_PRUNE_SYSTEM_PATHS=0` disables the RUNTIME prune only. It never relaxes
// the Zod guard (Bundle A), and it does NOT govern `followSymlinks` — that has
// its own lever (`WATCH_FOLLOW_SYMLINKS`, AC-16). One lever per behaviour change.
let pruneEnabledMemo: boolean | null = null;

export function isSystemPruneEnabled(): boolean {
  if (pruneEnabledMemo !== null) return pruneEnabledMemo;
  const raw = process.env.SCAN_PRUNE_SYSTEM_PATHS;
  const enabled = raw !== '0';
  pruneEnabledMemo = enabled;
  logger.info(
    {
      action: 'scan_prune_system_paths_resolved',
      enabled,
      source: raw === undefined ? 'default' : 'env',
      prefixes: PRUNE_SYSTEM_PREFIXES,
    },
    'scan/watch: system-prefix prune resolved',
  );
  return enabled;
}

// Test-only companion to the memo above — production code NEVER calls this.
// Without it the AC-8 kill-switch could not be exercised in-suite at all
// (the memo would freeze whatever the first test happened to set).
export function __resetSystemPruneMemoForTests(): void {
  pruneEnabledMemo = null;
}
