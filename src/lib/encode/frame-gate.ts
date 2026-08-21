// Phase 50 Plan 50-01 — output frame-count integrity gate.
//
// WHY THIS EXISTS
// v2.46.0 booked a job carrying 17 of 371 722 video frames as `done-smaller`,
// moved the original to trash and set the library row to "successful".
// `verifyOutput` checked exactly two things — `ffprobe(stageOut) !== null` and
// `statSync(stageOut).size` — and a video-less output passes BOTH sieves. After
// that only the size ratio decided the verdict bucket: 4.3 GB of audio out of a
// 21 GB source ⇒ high savingsPercent ⇒ green job.
//
// The gate compares an EXPECTED packet count against a COUNTED one. It cannot be
// a single metadata field:
//
//  M5/M-A (measured, ffmpeg 6.1.1) — a truncated Matroska video track keeps
//        `avg_frame_rate=24/1` in its track header and reports `nb_frames=N/A`.
//        Neither field collapses when the stream does. Only `-count_packets`
//        (a real demux of the artefact) tells the truth.
//
// PATTERN
// Mirrors keyframe.ts (49-02): PURE resolver + memoized accessor + test seam,
// resolved value logged ONCE at `info` (NOT `debug` — 20 does not reach the ring
// buffer, so the line would never make the diagnostics copy-report; the
// 22-01 → 38-02 dark-surface bug). Module imports the logger and NOTHING else —
// no node:os, no DB, no orchestrator edge.

import { logger as defaultLogger } from '../logger';

/**
 * D2: 2 % slack, exclusive.
 *
 * At the reporter's 371 722 expected frames that is 7 434 frames of headroom —
 * enough for VFR sources whose average frame rate does not describe the stream
 * exactly, and for the odd trailing packet a muxer drops. The reporter's own case
 * misses by FOUR ORDERS OF MAGNITUDE (17 vs. 371 722), so it is nowhere near the
 * boundary. 0.95 was rejected: it buys nothing against the failure class this
 * gate exists for and silently tolerates a 5 % truncation.
 */
export const FRAME_GATE_THRESHOLD = 0.98;

/**
 * Resolve ENCODE_FRAME_GATE_DISABLED.
 *
 * DELIBERATELY ASYMMETRIC to a tuning-knob resolver: this is a kill-switch, and
 * the repo-wide kill-switch convention is `*_DISABLED === '1'` (CLAUDE.md table,
 * precedent resolveClosedGopEnabled). `=1` ⇒ gate OFF. Anything else — unset,
 * '0', 'true', junk — leaves the gate ON.
 */
export function resolveFrameGateEnabled(raw: string | undefined): boolean {
  return (raw ?? '').trim() !== '1';
}

let _enabledCache: boolean | undefined; // undefined = not yet resolved

/**
 * Memoized ENCODE_FRAME_GATE_DISABLED accessor. Restart required to flip — same
 * contract as X265_POOLS / ENCODE_NICE / the keyframe levers.
 *
 * LAZY, like its house-style neighbours: the `frame_gate_resolved` line appears
 * on the FIRST verifyOutput after a restart, not at boot. An operator who flips
 * the switch and looks at the log immediately sees nothing; the evidence arrives
 * with the first finished encode.
 */
export function frameGateEnabled(): boolean {
  if (_enabledCache === undefined) {
    const raw = process.env.ENCODE_FRAME_GATE_DISABLED;
    _enabledCache = resolveFrameGateEnabled(raw);
    const source = (raw ?? '').trim() === '' ? 'default' : 'env';
    defaultLogger.info(
      {
        action: 'frame_gate_resolved',
        enabled: _enabledCache,
        source,
        envRaw: raw ?? null,
      },
      'frame-gate: output frame-count gate resolved',
    );
  }
  return _enabledCache;
}

/** 50-01 test seam — never barrel-exported (consumed only by tests/encode/*). */
export function __forTests_resetFrameGateCache(): void {
  _enabledCache = undefined;
}

export type FrameGateInput = {
  /**
   * E1=C: the SOURCE duration (file.duration_seconds, scan time), falling back
   * to the output probe only when the DB row carries none. See the caller.
   */
  durationSeconds: number | null | undefined;
  /** avg_frame_rate of the REAL video stream of the OUTPUT (never the cover). */
  avgFrameRate: number | undefined;
  /** nb_read_packets of that same stream, or null when the count run failed. */
  actualPackets: number | null;
};

export type FrameGateVerdict =
  | { kind: 'skip'; reason: 'no_duration' | 'no_frame_rate' | 'count_failed' }
  | { kind: 'pass'; expected: number; threshold: number; actual: number }
  | { kind: 'fail'; expected: number; threshold: number; actual: number };

/**
 * Pure gate evaluation — ZERO I/O, and deliberately NO `process.env` read: the
 * kill-switch is queried at the call site so this function runs in tests without
 * env fiddling.
 *
 * THE ORDER OF THE THREE SKIP REASONS IS BINDING, not cosmetic:
 *
 *   no_duration → no_frame_rate → (only now may a count be needed) → count_failed
 *
 * The caller exploits exactly this: it first calls with `actualPackets: null`;
 * a `no_duration` / `no_frame_rate` verdict means the expensive count spawn is
 * NEVER launched, while `count_failed` proves duration+fps are valid and the
 * count run is worth starting. That is what keeps legacy tests (whose fixtures
 * carry no avgFrameRate) from spawning anything at all — E7.
 *
 * fail-OPEN by D2/E6: a missing metadatum, and a count run that could not be
 * carried out, both let the job through. A failed CHECK is not evidence of a
 * broken output; the kill-switch exists for the opposite direction.
 */
export function evaluateFrameGate(input: FrameGateInput): FrameGateVerdict {
  const { durationSeconds, avgFrameRate, actualPackets } = input;

  if (
    durationSeconds === null ||
    durationSeconds === undefined ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return { kind: 'skip', reason: 'no_duration' };
  }
  if (avgFrameRate === undefined || !Number.isFinite(avgFrameRate) || avgFrameRate <= 0) {
    return { kind: 'skip', reason: 'no_frame_rate' };
  }
  if (actualPackets === null) {
    return { kind: 'skip', reason: 'count_failed' };
  }

  const expected = durationSeconds * avgFrameRate;
  const threshold = FRAME_GATE_THRESHOLD * expected;
  return actualPackets < threshold
    ? { kind: 'fail', expected, threshold, actual: actualPackets }
    : { kind: 'pass', expected, threshold, actual: actualPackets };
}
