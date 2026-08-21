// 49-05 Task 1 — the ONE source for the per-encoder factory CRF defaults.
//
// WHY A SEPARATE LEAF FILE (audit MH-1): this constant is read by CLIENT
// components (`components/onboarding/quality-step.tsx` is `'use client'`), and
// the two obvious homes are both unusable as a VALUE import from the client
// graph:
//   - `./profiles` does `import os from 'node:os'` + `import { logger }` (pino)
//   - `./index` (the barrel) additionally pulls orchestrator + detection
// A value import of either from a client component drags a Node builtin into
// the webpack client bundle — typecorrect, so neither `tsc --noEmit` nor vitest
// sees it; it fails in `npm run build`. That today's five client consumers of
// profiles.ts all import `import type { EncoderId }` (type-erased, therefore
// harmless) is not an accident — it is the rule this file exists to keep.
//
// INVARIANT: this module stays runtime-dependency-FREE. The only import allowed
// is the type-only `EncoderId`. `tests/encode/default-crf-consistency.test.ts`
// asserts the file header carries no other import.
//
// Client components import the LEAF path `@/src/lib/encode/crf-defaults`.
// Server code may use the profiles.ts / barrel re-export for import ergonomics.
import type { EncoderId, QsvRateControl } from './profiles';

// 49-05: `qsv` moves 22 → 26 for NEW INSTALLATIONS ONLY (the seed in
// migrations/0005_encoder_settings.sql; `INSERT OR IGNORE` leaves every existing
// row untouched — D4). The 26 is a conservative ESTIMATE derived from the
// unRAID-forum recommendation 26-28 (2026-08-19, lower end chosen), NOT a VMAF
// measurement — there is no Intel hardware locally. `crf_vaapi` stays 22 because
// no evidence contradicts it.
//
// The scales are NOT comparable across encoders: libx265 `-crf`, nvenc `-qp`
// (constqp), vaapi `-qp` (rc_mode CQP), qsv `-global_quality` (ICQ) or `-q:v`
// (CQP) depending on the tier the boot probe resolved. Same number, different
// meaning — that mismatch is the whole reason for 49-05.
export const DEFAULT_CRF_BY_ENCODER: Record<EncoderId, number> = {
  libx265: 23,
  nvenc: 23,
  qsv: 26,
  vaapi: 22,
};

// 49-05: which ffmpeg quality flag the QSV path actually emits, per resolved
// ratecontrol tier. Mirrors PROFILE_BUILDERS.qsv (profiles.ts) — the two branches
// there emit `-global_quality <crf> -low_power 0` (ICQ, full-encode path) and
// `-q:v <crf>` (CQP, low-power path). Lives HERE, not in profiles.ts, because the
// Settings CRF helper is a client component (MH-1). Bound to the real argv by
// tests/encode/crf-helper-argv-binding.test.ts, so a flag rename in the builder
// cannot silently outlive the UI text again — that drift is what 49-05 repairs.
export const QSV_QUALITY_PARAM_BY_TIER: Record<QsvRateControl, string> = {
  'icq-full': '-global_quality',
  cqp: '-q:v',
};

// The tier the runtime falls back to when the boot probe never resolved one:
// getActiveQsvRateControl() (detection.ts:1159-1160) reads
// `globalThis.__x265butler_encoder_cache?.qsvRateControl ?? 'icq-full'`, so an
// unresolved host still deterministically ships `-global_quality`. The UI must
// say that instead of only saying "unknown" — it would otherwise know less than
// the program (audit MH-3). Pinned to the detection fallback by the same test.
export const QSV_QUALITY_PARAM_FALLBACK: string = QSV_QUALITY_PARAM_BY_TIER['icq-full'];
