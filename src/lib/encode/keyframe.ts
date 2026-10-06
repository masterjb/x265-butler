// Deterministic closed-GOP keyframe resolvers.
//
// Root-cause (measured locally against ffmpeg 6.1.1, 2026-08-19 — NOT researched):
// until v2.45.0 NO line in this codebase set a keyframe interval or an IDR
// behaviour, so every output rode the bare ffmpeg CLI default.
//
//  Finding 1 — that default is `gop_size = 250` FRAMES (≈10.4 s @24 fps), not 12:
//         libx265, no args → keyframes @ 0.000 / 10.417 / 20.833 (30 s testsrc)
//       hevc_qsv / hevc_vaapi read the same `avctx->gop_size`. The N100 forum
//       reporter's "picture is normal by 10 seconds" is an exact hit.
//
//  Finding 2 — `-force_key_frames` alone does NOT produce IDR frames. NAL-unit types
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
// ring-buffer, so the line would never reach the diagnostics copy-report.
// `telemetry` (25) is the lowest level that does reach it — see the tier table in src/lib/logger.ts.

import { logger as defaultLogger } from '../logger';

type KeyframeLogger = Pick<typeof defaultLogger, 'info' | 'warn'>;

// 10 s. RAISED from the original value of 5 on 2026-09-07 — the reasoning
// is worth keeping, because the number moved for an evidence reason, not taste.
//
// Size cost on a synthetic worst-case clip (60 s testsrc, every frame new
// content, CRF 28 ultrafast), all three rows MEASURED:
//     no-args baseline               518 185 B
//     10 s + open-gop=0              518 042 B   (−0.03 %)
//      5 s + open-gop=0              614 321 B   (+18.6 %)
// Real film material pays far less than the 5 s row (the I-frame share
// collapses); the SHAPE — halve the interval ≈ double the I-frames — holds.
//
// WHY 5 WAS CHOSEN, AND WHY IT NO LONGER EARNS ITS COST: 5 s was picked partly
// against the N100 reporter's "block garbage over an otherwise correct picture",
// on the hypothesis that tighter, IDR-only keyframes would clear it. For the
// v2.47.0 VLC report that hypothesis is now REFUTED by a control: v2.47.0 and
// v2.48.0 produce a BYTE-IDENTICAL argv (the only encode-path delta between the
// tags is a new log-route file), yet the same source plays correctly under
// v2.48.0 on qsv AND vaapi. The image's rolling `BTBN_TAG=latest` pin was the
// only moving part ⇒ a broken ffmpeg master nightly muxed the file, later master
// healed it. The keyframe interval never entered into it.
//
// ⚠ WHAT IS **NOT** REFUTED, and why the IDR pin stays ON: finding 2 measured CRA +
// RASL leading pictures directly in the bitstream, independently of any player
// report. `open-gop=0` / `-forced_idr` is unaffected by the nightly finding and
// is NOT relaxed here. Only the INTERVAL moves.
//
// WHY 10 AND NOT 0 (i.e. why not drop the token): at 10 s the measured size cost
// is ≈ 0, so the token costs nothing to keep, and keeping it preserves two
// properties the bare encoder default does not have. (a) `gop_size = 250` is
// FRAME-based, so the spacing drifts with source fps (10.4 s @24, ~4.2 s @60);
// the time expression caps it at ≤10 s for every source. (b) the emitted token
// keeps the whole closed-GOP path — including the forced-IDR CONFIRM probe and
// both env levers — exercised in production rather than dead.
//
// ENCODE_KEYFRAME_INTERVAL_SEC remains the no-redeploy correction lever in BOTH
// directions: `=5` restores the old default, `=0` removes the token entirely.
export const DEFAULT_KEYFRAME_INTERVAL_SEC = 10;

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
 * UPPER-BOUND CAVEAT (MEASURED, not argued): the resolved VALUE
 * is verbatim, the OBSERVABLE keyframe spacing is `min(interval, encoder default
 * GOP)`. Measured: interval 60 on a 30 s clip yields keyframes at 0 / 10.417 /
 * 20.833 — the untouched `gop_size = 250` default wins, NOT 0 / 60. Values above
 * the encoder default GOP (~10 s @24 fps) are therefore WITHOUT EFFECT; only
 * values BELOW it actually shorten the spacing. This resolver deliberately does
 * NOT clamp (it does not know the source fps and must not falsify an operator
 * value) — but the limit is documented here, in docs/dev/kill-switches.md and frozen in an
 * executed test, so nobody reports "set 60, got 10" as a bug.
 *
 * ⚠ SINCE THE DEFAULT MOVED TO 10 (2026-09-07) THIS CAVEAT NOW APPLIES TO THE
 * DEFAULT ITSELF, so state it honestly rather than let a reader assume "10 s
 * keyframes" everywhere: the token is a CEILING, not a guarantee. @24 fps the
 * default GOP is 10.417 s ⇒ 10 binds, barely. @30 fps it is 8.33 s and @60 fps
 * ~4.17 s ⇒ the encoder default already wins and the token changes nothing. The
 * guarantee the default buys is therefore "spacing ≤ 10 s on any source fps",
 * which the frame-based encoder default alone does NOT give.
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
 * the repo-wide kill-switch convention is `*_DISABLED === '1'` (see the docs/dev/kill-switches.md
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
    // info; `debug` (20) would not reach the ring — see the module header.
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

// `-force_key_frames` is the FOURTH global video-stream specifier, after
// `-c:v`, `-vf` and `-tag:v`.
//
// The expression is TIME-based — `expr:gte(t,n_forced*<sec>)` — which is why no
// fps probe is needed and why one form covers all four encoders.
// The rejected `-g <frames>` variant would need fps from ffprobe AND four
// encoder-specific argv forms, and measured (finding 2) it carries the SAME open-CRA
// weakness anyway, so it buys nothing.
//
// THE ORDINAL NARROWING IS CLASS CONSISTENCY, **NOT** A BUG FIX. Measured (executed
// against ffmpeg 6.1.1, source with a real attached_pic cover on
// `-c:v:1 copy`): the BARE `-force_key_frames` token returns exit 0 with the cover
// unchanged in mkv AND mp4 — ffmpeg treats it as a silent no-op on a stream-copied
// stream, unlike `-vf`, which aborts hard with "Filtering and streamcopy cannot be
// used together" (see attached-pic.ts). The narrowing is done anyway: ONE pattern for
// all four global video specifiers, zero cost, and a future fifth specifier
// inherits the rule instead of rediscovering it. DO NOT cite this as proof that the
// narrowing is necessary — its necessity is measured and REFUTED.
//
// MOVED here from `ffmpeg.ts` (pulled, not copied) so the second
// caller, the /diagnostics test encode, can emit the SAME token without importing
// the production encode module. It lives beside the interval resolver it consumes,
// which is where it belonged from the start.
//
// ⚠ INVARIANT (unchanged by the move): `profiles.ts` must NEVER import this
// module. `encodeForBench` (bench/vmaf.ts) calls `buildCodecBlock` DIRECTLY, so any
// keyframe knowledge inside the builder would push the policy into every bench
// Pass-1 argv and break the apples-to-apples VMAF invariant. The move does not relax
// that rule — it only gives the two
// LEGITIMATE callers (`buildArgs`, `buildTestEncodeArgs`) one source instead of two.
export function forceKeyFrameArgs(sec: number, ordinals?: ReadonlyArray<number>): string[] {
  if (!(sec > 0)) return [];
  const expr = `expr:gte(t,n_forced*${sec})`;
  if (!ordinals || ordinals.length === 0) return ['-force_key_frames', expr];
  return ordinals.flatMap((n) => [`-force_key_frames:v:${n}`, expr]);
}

// Test seam — never barrel-exported (consumed only by tests/encode/*).
export function __forTests_resetKeyframeCache(): void {
  _intervalCache = undefined;
  _closedGopCache = undefined;
}
