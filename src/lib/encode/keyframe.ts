// Phase 49 Plan 49-02 — deterministic closed-GOP keyframe resolvers.
//
// Root-cause (measured locally against ffmpeg 6.1.1, 2026-08-19 — NOT researched):
// until v2.45.0 NO line in this codebase set a keyframe interval or an IDR
// behaviour, so every output rode the bare ffmpeg CLI default.
//
//  M1 — that default is `gop_size = 250` FRAMES (≈10.4 s @24 fps), not 12:
//         libx265, no args → keyframes @ 0.000 / 10.417 / 20.833 (30 s testsrc)
//       hevc_qsv / hevc_vaapi read the same `avctx->gop_size`. The N100 forum
//       reporter's "picture is normal by 10 seconds" is an exact hit.
//
//  M2 — `-force_key_frames` alone does NOT produce IDR frames. NAL-unit types
//       from the raw HEVC bitstream (libx265, 30 s):
//         (no args)                              → 10.42 s spacing, 1 IDR + 2 CRA
//         -force_key_frames expr:gte(t,n_forced*5) →  5 s spacing, 1 IDR + 5 CRA
//         -x265-params open-gop=0                → 10.42 s spacing, 3 IDR, 0 CRA
//         both                                   →  5 s spacing, 6 IDR, 0 CRA
//       INTERVAL and IDR-ness are two INDEPENDENT knobs, hence two env levers.
//       CRA + RASL leading pictures is precisely the "block garbage over an
//       otherwise correct picture" signature the reporter described.
//
// Pattern mirrors resolveX265Pools (profiles.ts) / resolvePollIntervalMs
// (watch/poll-interval.ts): PURE resolver + memoized accessor + test seam,
// reject-to-default (NOT clamp — a typo'd value must surface), resolved value
// logged ONCE at `info`. NOT at `logger.debug`: `debug` (20) does not reach the
// ring-buffer, so the line would never reach the diagnostics copy-report (the
// 22-01 → 38-02 dark-surface bug, CONTEXT R4). `telemetry` (25) is the lowest
// level that does reach it — see the tier table in src/lib/logger.ts.

import { logger as defaultLogger } from '../logger';

type KeyframeLogger = Pick<typeof defaultLogger, 'info' | 'warn'>;

// 5 s: the interval CONTEXT D3=B settled on. M4 size cost on a synthetic
// worst-case clip (60 s testsrc, every frame new content, CRF 28 ultrafast):
// pre-49 baseline 518 185 B → 5 s + open-gop=0 = 614 321 B (+18.6 %). Real film
// material pays far less (the I-frame share collapses); the SHAPE — halve the
// interval ≈ double the I-frames — holds. ENCODE_KEYFRAME_INTERVAL_SEC is the
// no-redeploy correction lever.
export const DEFAULT_KEYFRAME_INTERVAL_SEC = 5;

/**
 * Resolve ENCODE_KEYFRAME_INTERVAL_SEC.
 *
 *  - unset / whitespace  → DEFAULT (no warn — unset IS the normal case)
 *  - '0'                 → 0, the EXPLICIT off-state, NOT a reject. Precedent:
 *                          resolveX265Pools treats '0'/'auto' the same way.
 *  - positive integer    → VERBATIM, unclamped upwards
 *  - anything else       → DEFAULT + exactly ONE warn (reject-to-default, NOT
 *                          clamp: a typo'd `50` must be noticed, not silently
 *                          become 19 — same discipline as ENCODE_NICE / SLOW_QUERY_MS)
 *
 * UPPER-BOUND CAVEAT (49-02 audit M5b, MEASURED not argued): the resolved VALUE
 * is verbatim, the OBSERVABLE keyframe spacing is `min(interval, encoder default
 * GOP)`. Measured: interval 60 on a 30 s clip yields keyframes at 0 / 10.417 /
 * 20.833 — the untouched `gop_size = 250` default wins, NOT 0 / 60. Values above
 * the encoder default GOP (~10 s @24 fps) are therefore WITHOUT EFFECT; only
 * values BELOW it actually shorten the spacing. This resolver deliberately does
 * NOT clamp (it does not know the source fps and must not falsify an operator
 * value) — but the limit is documented here, in CLAUDE.md and frozen in an
 * executed test, so nobody reports "set 60, got 10" as a bug. Frozen by AC-17.
 */
export function resolveKeyframeIntervalSec(
  raw: string | undefined,
  log: KeyframeLogger = defaultLogger,
): number {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return DEFAULT_KEYFRAME_INTERVAL_SEC;
  if (trimmed === '0') return 0;

  const n = Number(trimmed);
  if (Number.isInteger(n) && n > 0) return n;

  log.warn(
    {
      action: 'keyframe_interval_invalid',
      raw,
      fallback: DEFAULT_KEYFRAME_INTERVAL_SEC,
    },
    'keyframe: ENCODE_KEYFRAME_INTERVAL_SEC invalid (non-integer / negative / junk) — falling back to the default interval',
  );
  return DEFAULT_KEYFRAME_INTERVAL_SEC;
}

/**
 * Resolve ENCODE_CLOSED_GOP_DISABLED.
 *
 * DELIBERATELY ASYMMETRIC to the interval resolver: this is a kill-switch, and
 * the repo-wide kill-switch convention is `*_DISABLED === '1'` (see the CLAUDE.md
 * table). `=1` ⇒ disabled ⇒ no IDR pin is emitted for ANY encoder. Anything
 * else — including unset, '0', 'true', junk — leaves the pin ENABLED.
 */
export function resolveClosedGopEnabled(raw: string | undefined): boolean {
  return (raw ?? '').trim() !== '1';
}

let _intervalCache: number | undefined; // undefined = not yet resolved
let _closedGopCache: boolean | undefined;

/**
 * Memoized ENCODE_KEYFRAME_INTERVAL_SEC accessor. The memoization is what makes
 * the invalid-value warn fire exactly ONCE per process (the parse runs once).
 * Restart required for an operator flip — same contract as X265_POOLS.
 */
export function keyframeIntervalSec(): number {
  if (_intervalCache === undefined) {
    const raw = process.env.ENCODE_KEYFRAME_INTERVAL_SEC;
    const trimmed = (raw ?? '').trim();
    _intervalCache = resolveKeyframeIntervalSec(raw);
    const n = Number(trimmed);
    const source =
      trimmed === ''
        ? 'default'
        : trimmed === '0' || (Number.isInteger(n) && n > 0)
          ? 'env'
          : 'env-invalid';
    // info; `debug` (20) would not reach the ring — see the module header
    // (CONTEXT R4 / AC-15).
    defaultLogger.info(
      {
        action: 'keyframe_interval_resolved',
        resolvedSec: _intervalCache,
        source,
        envRaw: raw ?? null,
      },
      'keyframe: forced-keyframe interval resolved',
    );
  }
  return _intervalCache;
}

/** Memoized ENCODE_CLOSED_GOP_DISABLED accessor. Restart required to flip. */
export function closedGopEnabled(): boolean {
  if (_closedGopCache === undefined) {
    const raw = process.env.ENCODE_CLOSED_GOP_DISABLED;
    _closedGopCache = resolveClosedGopEnabled(raw);
    const source = (raw ?? '').trim() === '' ? 'default' : 'env';
    defaultLogger.info(
      {
        action: 'closed_gop_resolved',
        enabled: _closedGopCache,
        source,
        envRaw: raw ?? null,
      },
      'keyframe: closed-GOP (IDR pin) resolved',
    );
  }
  return _closedGopCache;
}

// 49-02 test seam — never barrel-exported (consumed only by tests/encode/*).
export function __forTests_resetKeyframeCache(): void {
  _intervalCache = undefined;
  _closedGopCache = undefined;
}
