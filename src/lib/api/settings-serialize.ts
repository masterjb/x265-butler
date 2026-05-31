// audit-added S6: form-to-API serialization helper. Converts form values
// (numbers for crf_*, min_savings_percent) to the string shape the DB stores
// + the PUT API expects. Keeps the boundary explicit and unit-testable.
//
// 14-04 (Plan 14-04 Task 5): legacy single-share keys scan_root / extensions
// / min_size_mb / max_depth removed from this surface — multi-share source of
// truth is shareRepo() via /api/shares. cache_pool_path STAYS (settings-level
// concern). parseExtensions removed (no consumer post-14-04).

import type { FormatLocale } from '@/src/lib/format';

// 03-03 audit M2: EncoderId + ConcurrencyValue literals exposed for the
// Settings UI Encoder tab. Mirrors src/lib/encode/profiles.ts ENCODER_IDS
// + Discovery's concurrency 'auto' | '1'..'8' range.
export type EncoderChoice = 'auto' | 'nvenc' | 'qsv' | 'vaapi' | 'libx265';
export type ConcurrencyChoice = 'auto' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8';

export type EditableSettings = {
  cache_pool_path: string;
  language: 'en' | 'de';
  theme_override: 'system' | 'light' | 'dark';
  auto_enqueue_after_scan: 'true' | 'false';
  // 03-03: encoder + concurrency + per-encoder CRF defaults (DB stores TEXT).
  encoder: EncoderChoice;
  concurrency: ConcurrencyChoice;
  crf_libx265: string;
  crf_nvenc: string;
  crf_qsv: string;
  crf_vaapi: string;
  // 12-03: per-encoder preset override (DB stores TEXT; runtime-validated
  // against PRESETS_BY_ENCODER Catalog at app/api/settings/route.ts zod layer).
  preset_libx265: string;
  preset_nvenc: string;
  preset_qsv: string;
  preset_vaapi: string;
  // 05-13: 3-bucket verdict threshold separating done-smaller from
  // done-not-worth (range 0..50; DB stores TEXT — already seeded by 0002).
  min_savings_percent: string;
  // 05-bonus: encode-behavior toggles (DB stores TEXT).
  delete_original_after_encode: 'true' | 'false';
  output_suffix: string;
  // 05-14: operator-selectable output container — 'mkv' default + 'mp4' opt-in.
  // 05-15: 'match-source' DWIM directive added (resolves per source ext at dispatch).
  output_container: 'mkv' | 'mp4' | 'match-source';
};

export type FormValues = {
  language: FormatLocale;
  theme_override: 'system' | 'light' | 'dark';
  auto_enqueue_after_scan: boolean;
  // 03-03: form-side encoder + concurrency + CRF (number for input UX;
  // serialized → string for DB via serializeForApi).
  encoder: EncoderChoice;
  concurrency: ConcurrencyChoice;
  crf_libx265: number;
  crf_nvenc: number;
  crf_qsv: number;
  crf_vaapi: number;
  // 12-03: per-encoder preset override (form-side string enum, passthrough
  // to API-side string; zod enum-narrows at app/api/settings/route.ts).
  preset_libx265: string;
  preset_nvenc: string;
  preset_qsv: string;
  preset_vaapi: string;
  // 05-13: form-side number (Slider native), serialized → string for DB.
  min_savings_percent: number;
  // 05-bonus: encode-behavior toggles (form-side bool + string; serialized
  // → string for DB via serializeForApi).
  delete_original_after_encode: boolean;
  output_suffix: string;
  // 05-14: form-side container literal — passed through as-is to DB.
  // 05-15: 'match-source' added (3rd Select option).
  output_container: 'mkv' | 'mp4' | 'match-source';
};

export function serializeForApi(values: Partial<FormValues>): Partial<EditableSettings> {
  const out: Partial<EditableSettings> = {};
  if (values.language !== undefined) out.language = values.language;
  if (values.theme_override !== undefined) out.theme_override = values.theme_override;
  if (values.auto_enqueue_after_scan !== undefined) {
    out.auto_enqueue_after_scan = values.auto_enqueue_after_scan ? 'true' : 'false';
  }
  // 03-03 audit M2 + S6: encoder + concurrency passthrough; CRF number → string.
  if (values.encoder !== undefined) out.encoder = values.encoder;
  if (values.concurrency !== undefined) out.concurrency = values.concurrency;
  if (values.crf_libx265 !== undefined) out.crf_libx265 = String(values.crf_libx265);
  if (values.crf_nvenc !== undefined) out.crf_nvenc = String(values.crf_nvenc);
  if (values.crf_qsv !== undefined) out.crf_qsv = String(values.crf_qsv);
  if (values.crf_vaapi !== undefined) out.crf_vaapi = String(values.crf_vaapi);
  // 12-03: per-encoder preset passthrough (form-string → API-string;
  // zod enum-narrows at app/api/settings/route.ts. NO transform here —
  // settings-serialize is type-pass-through only per audit M1).
  if (values.preset_libx265 !== undefined) out.preset_libx265 = values.preset_libx265;
  if (values.preset_nvenc !== undefined) out.preset_nvenc = values.preset_nvenc;
  if (values.preset_qsv !== undefined) out.preset_qsv = values.preset_qsv;
  if (values.preset_vaapi !== undefined) out.preset_vaapi = values.preset_vaapi;
  // 05-13: 3-bucket verdict threshold (form number → DB string).
  if (values.min_savings_percent !== undefined) {
    out.min_savings_percent = String(values.min_savings_percent);
  }
  // 05-bonus: encode-behavior toggles.
  if (values.delete_original_after_encode !== undefined) {
    out.delete_original_after_encode = values.delete_original_after_encode ? 'true' : 'false';
  }
  if (values.output_suffix !== undefined) out.output_suffix = values.output_suffix;
  // 05-14: container — direct passthrough, already enum-shaped.
  if (values.output_container !== undefined) out.output_container = values.output_container;
  return out;
}
