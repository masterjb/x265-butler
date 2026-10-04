// 50-03: SINGLE source of truth for the question "would the scan walker have
// picked this file up?" — shared by the walker, the chokidar watch path, the
// single-file ingest and the reconcile orphan sweep.
//
// WHY this module exists (R3, CONTEXT 50): the watch path ingested EVERYTHING
// chokidar reported. The app therefore fed on its own output — a written
// sidecar JSON produced an `add` event, was hashed, ffprobed, upserted into
// `file` with `codec: null` and enqueued; a poster image did the same with a
// perfectly valid codec. The scan walker never had this bug (`walker.ts:278`),
// so the fix is not a new predicate — it is the SAME predicate, in one place,
// used by all four surfaces (48-02 `fs/system-paths.ts` form).
//
// WHY EXTENSION AND NOT CODEC — do not "simplify" this into an
// `AND file.codec IS NOT NULL` (both facts MEASURED 2026-08-20, ffprobe 6.1.1):
//
//   M-A  a poster JPEG answers ffprobe with exit 0, `codec_type: video` and
//        `codec_name: mjpeg`. Its `file` row carries a NON-NULL codec, so a
//        codec gate does not see it at all.
//   M-C  `scan/orchestrator.ts:262-273` drops an unchanged file BEFORE
//        hash/ffprobe ("mtime + size unchanged → fast path"). A real `.mkv`
//        whose ffprobe once failed transiently (the wrapper has a 30 s timeout,
//        realistic on a cold shfs array) keeps `codec = NULL` FOREVER — a codec
//        gate would take its orphan recovery away silently and permanently.
//
// And there is no second line of defence downstream: the skip pipeline lost its
// codec check in 10-01 (`skip/pipeline.ts:11` — only SIDECAR + BLOCKLIST remain).

import path from 'node:path';
// E6: the sidecar suffixes come from the module that WRITES them. Re-typing the
// literal here would be a drift source with the half-life of this plan.
// M-E: `encode/sidecar.ts` imports only node:fs, node:path and ../logger, so
// this import pulls no heavy graph into `watch/watcher.ts`.
import { SIDECAR_SUFFIX, SIDECAR_TMP_SUFFIX } from '../encode/sidecar';

/**
 * The extension allowlist a share falls back to when it has none of its own.
 *
 * Value-equal to `ONBOARDING_DEFAULT_EXT_CSV`
 * (`app/api/onboarding/complete/route.ts:22`) — the LIVING source that a fresh
 * install actually writes into `shares.extensions_csv`. A test holds the two
 * against each other (AC-9) instead of typing the list a fifth time.
 *
 * NOT anchored to `migrations/0001_initial.sql:35`: that legacy `setting` row is
 * DELETED by `migrations/0027_drop_legacy_share_settings.sql`, so it can never
 * change again and would therefore never notice drift (audit-added M6).
 *
 * Consolidation still OPEN — three further typed copies exist today and one of
 * them has ALREADY diverged:
 *   app/api/scan/route.ts:116            (equal)
 *   app/api/scan/estimate/route.ts:148   (equal)
 *   app/[locale]/scan/estimate/page.tsx  ('mp4,mkv,avi' — divergent)
 * Folding those in is a plan of its own, not a drive-by of a watch-ingest plan.
 */
export const DEFAULT_MEDIA_EXTENSIONS: readonly string[] = [
  'mp4',
  'mkv',
  'avi',
  'mov',
  'm4v',
  'webm',
  'ts',
  'm2ts',
  'wmv',
];

/**
 * Pulled OUT of `scan/walker.ts` (E5), body byte-identical to the original at
 * `829101f`. The parameter type is widened to `readonly string[]` so
 * DEFAULT_MEDIA_EXTENSIONS can be passed directly; every existing caller keeps
 * working. A second implementation would drift from the walker within a phase.
 */
export function normalizeExtensions(extensions: readonly string[]): Set<string> {
  return new Set(
    extensions.map((e) => e.toLowerCase().replace(/^\./, '')).filter((e) => e.length > 0),
  );
}

/**
 * `shares.extensions_csv` → normalized set. PURE: no fallback, no logging — the
 * walker needs the raw semantics. The watch path uses `resolveAllowedExtensions`.
 */
export function parseExtensionCsv(csv: string): Set<string> {
  // The trim happens HERE, not in normalizeExtensions (whose body is frozen by
  // AC-15). A hand-written share CSV routinely carries spaces around commas,
  // and `normalizeExtensions` would keep ' mp4' as a distinct token.
  return normalizeExtensions(csv.split(',').map((s) => s.trim()));
}

/**
 * The WATCH-path wrapper (E10, audit-added M2). An EMPTY allowlist is a total
 * predicate — it rejects every file — so on the watch path it would silently
 * remove a share's last working ingest source. That is exactly the failure mode
 * the kill-switch exists for, and a fail-safe is cheaper than the lever.
 *
 * Deliberately NOT symmetric to the walker: this plan does not make the watch
 * path worse than the scan path, it just refuses to copy the bug. `walker.ts`
 * does NOT use this wrapper.
 *
 * Not theoretical: `shares-zod.ts:74` rejects an empty CSV at the API boundary,
 * but `migrations/0026_shares_foundation.sql:33` back-filled the column via
 * `COALESCE((SELECT value FROM setting WHERE key='extensions'), …)` — and
 * COALESCE catches NULL, not the empty string. An operator who set `extensions`
 * to `''` before 14-01 carries a share row with an empty allowlist today.
 *
 * The caller decides whether to log (`fellBack`); this function never does —
 * AC-19 wants at most ONE warn per share and watcher start.
 */
export function resolveAllowedExtensions(csv: string | null | undefined): {
  set: Set<string>;
  fellBack: boolean;
} {
  const parsed = csv === null || csv === undefined ? new Set<string>() : parseExtensionCsv(csv);
  if (parsed.size === 0) {
    return { set: normalizeExtensions(DEFAULT_MEDIA_EXTENSIONS), fellBack: true };
  }
  return { set: parsed, fellBack: false };
}

/**
 * The one extension test. Byte-for-byte the walker's expression
 * (`walker.ts:278`) so walker and watch path cannot mean different things by
 * "extension". `path.extname` only ever looks at the last path segment, so
 * passing an absolute path is equivalent to passing the basename.
 */
export function hasAllowedExtension(absPath: string, allowed: Set<string>): boolean {
  const ext = path.extname(absPath).toLowerCase().replace(/^\./, '');
  return allowed.has(ext);
}

/** The suffixes carry dots — escape before they enter a RegExp. */
function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * chokidar `ignored` matcher for the files this app writes itself. Built from
 * the imported suffixes (E6/AC-16) — the literal must not appear in this file.
 *
 * Both suffixes: a `.tmp` left behind by an aborted atomic write is no more a
 * medium than the finished sidecar. Anchored at the end and WITHOUT the `g`
 * flag, so `.test()` is stateless.
 */
export const SIDECAR_IGNORE_RE = new RegExp(
  `(?:${escapeForRegExp(SIDECAR_SUFFIX)}|${escapeForRegExp(SIDECAR_TMP_SUFFIX)})$`,
);

export function isSidecarPath(absPath: string): boolean {
  return SIDECAR_IGNORE_RE.test(absPath);
}

// ── Kill-switch WATCH_INGEST_FILTER_DISABLED (E2) ───────────────────────────
//
// Shaped 1:1 after `resolveFollowSymlinks` (watcher.ts:318): memoized, only an
// exact '1' disables, restart required. PURE on purpose — it takes no logger
// and emits nothing. The ONE info line lives at the call site that owns a
// logger (`startWatcher`, AC-12b); a resolver that logs would either log per
// event or force a logger through four modules.
//
// It governs the extension check, the size check and the orphan gate — NOT the
// sidecar ignore (E2b): the app writes those files itself, so a lever that
// restores the self-feeding is not a safety net.
let ingestFilterMemo: { enabled: boolean; source: 'env' | 'default' } | null = null;

export function resolveIngestFilterEnabled(): { enabled: boolean; source: 'env' | 'default' } {
  if (ingestFilterMemo !== null) return ingestFilterMemo;
  const raw = process.env.WATCH_INGEST_FILTER_DISABLED;
  ingestFilterMemo = { enabled: raw !== '1', source: raw === undefined ? 'default' : 'env' };
  return ingestFilterMemo;
}

export function ingestFilterEnabled(): boolean {
  return resolveIngestFilterEnabled().enabled;
}

// Test-only companion to the memo above — production code NEVER calls this.
export function __resetIngestFilterMemoForTests(): void {
  ingestFilterMemo = null;
}
