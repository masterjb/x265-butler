// Phase 50 Plan 50-06 — the ONE place that turns stored settings into the
// encoder, the CRF and the preset a run will actually use.
//
// WHY THIS LEAF EXISTS: until v2.46.x the /diagnostics test encode hard-pinned
// `crf: 28` + DEFAULT_PRESET_BY_ENCODER and probed `det.activeFromAuto`, while
// production resolved `crf_<enc>` / `preset_<enc>` / `settings.encoder` in
// `orchestrator.ts`. The two answered different questions and the operator was
// told they answered the same one. The repair is NOT a second resolver — it is
// ONE resolver with two callers (the 48-02 `fs/system-paths.ts` / 50-03
// `scan/media-eligibility.ts` form). A copy would be the 29-01 drift class,
// which is exactly the bug this plan closes.
//
// PURITY CONTRACT (AC-22): this module reads NO `process.env`, opens NO DB and
// logs NOTHING. It takes the already-read settings record and returns values.
// The WARN lines stay at the call sites because they carry a `jobId` this leaf
// has no business knowing about.
//
// BEHAVIOUR IS MIRRORED, NOT IMPROVED (AC-6/AC-14): every branch below is a
// character-level mirror of what `resolveEncoderFor` / `resolveEncodeParams` did
// before, INCLUDING the NaN pass-through when `default_crf` is unparsable. That
// pass-through is a real pre-existing defect (production can dispatch
// `-crf NaN`), and repairing it HERE would silently change the production CRF —
// the one thing this plan must prove it does not do. It is surfaced by 50-06
// (AC-26) and repaired by a separate plan.

import { DEFAULT_PRESET_BY_ENCODER, ENCODER_IDS, type EncoderId } from './profiles';
import { isValidPreset } from './presets';

/**
 * What `settings.encoder` asked for.
 *  - an EncoderId → the operator pinned that encoder
 *  - 'auto'       → unset or the literal 'auto' (the seeded default, migration 0005)
 *  - 'invalid'    → a value outside ENCODER_IDS (operator DB edit, tampering,
 *                   a typo) — the CALLER decides what to warn and what to fall
 *                   back to, because production and diagnostics log differently.
 */
export type RequestedEncoder = EncoderId | 'auto' | 'invalid';

export function resolveRequestedEncoder(raw: string | undefined): RequestedEncoder {
  if (raw === undefined || raw === 'auto') return 'auto';
  if ((ENCODER_IDS as readonly string[]).includes(raw)) return raw as EncoderId;
  return 'invalid';
}

/**
 * The `default_crf` fallback, byte-identical to `readSettings`:
 * `parseInt(settings.get('default_crf') ?? '23', 10)`.
 *
 * NOTE the `??` (not `||`): a STORED empty string is NOT replaced by '23', it
 * parses to NaN. That is the pre-existing production behaviour and it is
 * deliberately preserved — see the module header.
 */
export function resolveDefaultCrf(settingsAll: Record<string, string>): number {
  return parseInt(settingsAll.default_crf ?? '23', 10);
}

/**
 * Per-encoder CRF with the production fallback chain:
 *   `crf_<encoder>` (truthy) → else `default_crf` → else 23
 * and, if the per-encoder value does not parse to a finite number, the
 * `default_crf` value again.
 *
 * `fallbackCrf` exists so the orchestrator can hand in the value IT already
 * computed (`readSettings().crf`, read through `settingRepo().get`) instead of
 * this leaf re-deriving it from `getAll()`. Both read the same row and the
 * getAll cache is invalidated on every write, so they cannot diverge — but
 * passing it through makes the delegation provably identical rather than
 * argued-identical, and that is the whole point of AC-14.
 */
export function resolveCrfForEncoder(
  encoder: EncoderId,
  settingsAll: Record<string, string>,
  fallbackCrf: number = resolveDefaultCrf(settingsAll),
): number {
  const raw = settingsAll[`crf_${encoder}`];
  const parsed = raw ? parseInt(raw, 10) : fallbackCrf;
  return Number.isFinite(parsed) ? parsed : fallbackCrf;
}

export interface ResolvedPreset {
  preset: string;
  source: 'settings' | 'fallback';
  /**
   * The raw stored value, handed back so a caller can reproduce the exact
   * "was set but invalid" condition (`raw != null && source === 'fallback'`)
   * that gates the `dispatch_preset_invalid_fallback` warn. Without it the
   * caller could not tell "no preset stored" from "garbage preset stored", and
   * the audit trail would change.
   */
  raw: string | undefined;
}

/**
 * Per-encoder preset with the Catalog guard (12-03 audit M4): a value outside
 * the per-encoder preset catalog — operator DB edit or catalog drift — falls
 * back to DEFAULT_PRESET_BY_ENCODER.
 */
export function resolvePresetForEncoder(
  encoder: EncoderId,
  settingsAll: Record<string, string>,
): ResolvedPreset {
  const raw = settingsAll[`preset_${encoder}`];
  const valid = typeof raw === 'string' && isValidPreset(encoder, raw);
  return {
    preset: valid ? raw : DEFAULT_PRESET_BY_ENCODER[encoder],
    source: valid ? 'settings' : 'fallback',
    raw,
  };
}

/**
 * `force_10bit`, in the same code-fallback form `readSettings` and
 * `resolveEncodeParams` already use: anything other than the exact string
 * 'true' is OFF, so unset/'false'/junk is byte-identical to pre-43.
 */
export function resolveForce10bit(settingsAll: Record<string, string>): boolean {
  return settingsAll.force_10bit === 'true';
}
