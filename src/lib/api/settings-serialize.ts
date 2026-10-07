// Form-to-API serialization helper. Converts form values
// (numbers for crf_*, min_savings_percent) to the string shape the DB stores
// + the PUT API expects. Keeps the boundary explicit and unit-testable.
//
// Legacy single-share keys scan_root / extensions
// / min_size_mb / max_depth removed from this surface — multi-share source of
// truth is shareRepo() via /api/shares. cache_pool_path STAYS (settings-level
// concern). parseExtensions removed (no consumer left).

import type { FormatLocale } from '@/src/lib/format';

// Stable client-facing shape for one probed /dev/dri/renderD* node.
// Derived from RenderDeviceProbe but narrowed to the fields the GPU
// device-picker needs (drops processGroups/processGid/gid/error). Neutral home
// (shared by the server route, the SSR settings page, and the client field
// component) avoids a server-route→client-component import edge — single source
// for the endpoint mapping, the page probe, and the Select options.
export type RenderDeviceOption = {
  path: string; // FULL /dev/dri/renderD<N> path — the persisted gpu_device value
  node: string; // basename, e.g. renderD129 — the Select label
  exists: boolean;
  readable: boolean;
  writable: boolean;
  groupName: string | null;
  inRenderGroup: boolean;
};

// EncoderId + ConcurrencyValue literals exposed for the
// Settings UI Encoder tab. Mirrors src/lib/encode/profiles.ts ENCODER_IDS
// + Discovery's concurrency 'auto' | '1'..'8' range.
export type EncoderChoice = 'auto' | 'nvenc' | 'qsv' | 'vaapi' | 'libx265';
export type ConcurrencyChoice = 'auto' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8';

export type EditableSettings = {
  cache_pool_path: string;
  language: 'en' | 'de';
  theme_override: 'system' | 'light' | 'dark';
  // Master switch; replaces the retired after-scan auto-enqueue key.
  auto_encode: 'true' | 'false';
  // Encoder + concurrency + per-encoder CRF defaults (DB stores TEXT).
  encoder: EncoderChoice;
  concurrency: ConcurrencyChoice;
  crf_libx265: string;
  crf_nvenc: string;
  crf_qsv: string;
  crf_vaapi: string;
  // Per-encoder preset override (DB stores TEXT; runtime-validated
  // against PRESETS_BY_ENCODER Catalog at app/api/settings/route.ts zod layer).
  preset_libx265: string;
  preset_nvenc: string;
  preset_qsv: string;
  preset_vaapi: string;
  // 3-bucket verdict threshold separating done-smaller from
  // done-not-worth (range 0..50; DB stores TEXT — already seeded by 0002).
  min_savings_percent: string;
  stall_timeout_minutes: string;
  // Days an original stays in the trash (1..3650).
  trash_retention_days: string;
  // 'false' = no trash; no stored row means on.
  trash_enabled: 'true' | 'false';
  // Trash place when trash_path is empty; no stored row means 'cache'.
  trash_location: 'share' | 'cache';
  // '1' on, '0' off; no stored row means on.
  resume_after_restart: '0' | '1';
  // Encode-behavior toggles (DB stores TEXT).
  delete_original_after_encode: 'true' | 'false';
  output_suffix: string;
  // Operator-selectable output container — 'mkv' default + 'mp4' opt-in.
  // 'match-source' DWIM directive (resolves per source ext at dispatch).
  output_container: 'mkv' | 'mp4' | 'match-source';
  // Output strategy (suffix-sibling vs in-place replace). DB stores
  // TEXT; default 'suffix' applied via orchestrator code-fallback, NOT a seed.
  output_mode: 'suffix' | 'replace';
  // Sidecar location mode + central root (DB stores TEXT; defaults
  // applied via orchestrator code-fallback, NOT a default-seed migration).
  sidecar_mode: 'off' | 'beside' | 'central';
  sidecar_central_path: string;
  // Operator-configurable originals-trash root. Empty = auto (track the
  // cache stageRoot = byte-identical default), NOT sidecar's .min(1) idiom.
  trash_path: string;
  // Operator-pinned /dev/dri/renderD* node for HW encoders. Empty = auto
  // (first-enumerated node = byte-identical default). DB stores TEXT.
  gpu_device: string;
  // Auto-crop / black-bar removal. DB stores TEXT.
  // auto_crop bool-string (mirror delete_original_after_encode); crop_override =
  // fixed W:H:X:Y geometry, empty = auto/none (a valid override wins over the
  // toggle). Default off/empty = byte-identical to no cropping.
  auto_crop: 'true' | 'false';
  crop_override: string;
  // Force 10-bit HEVC Main10 output. bool-string
  // (mirror auto_crop). Default 'false' via orchestrator code-fallback (NO
  // default-seed) → fresh/upgraded install byte-identical.
  force_10bit: 'true' | 'false';
  // Preserve source VUI color tags on output.
  // bool-string (mirror force_10bit). Default 'false' via orchestrator
  // code-fallback (NO default-seed) → fresh/upgraded install byte-identical.
  color_passthrough: 'true' | 'false';
  // GPU decode for vaapi jobs. bool-string, default 'false' via code-fallback.
  vaapi_hw_decode: 'true' | 'false';
};

export type FormValues = {
  language: FormatLocale;
  theme_override: 'system' | 'light' | 'dark';
  auto_encode: boolean;
  // Form-side encoder + concurrency + CRF (number for input UX;
  // serialized → string for DB via serializeForApi).
  encoder: EncoderChoice;
  concurrency: ConcurrencyChoice;
  crf_libx265: number;
  crf_nvenc: number;
  crf_qsv: number;
  crf_vaapi: number;
  // Per-encoder preset override (form-side string enum, passthrough
  // to API-side string; zod enum-narrows at app/api/settings/route.ts).
  preset_libx265: string;
  preset_nvenc: string;
  preset_qsv: string;
  preset_vaapi: string;
  // Form-side number (Slider native), serialized → string for DB.
  min_savings_percent: number;
  // Form-side number, serialized → string for DB. 0 = stall detection off.
  stall_timeout_minutes: number;
  resume_after_restart: boolean;
  // Form-side number, serialized → string for DB.
  trash_retention_days: number;
  trash_enabled: boolean;
  trash_location: 'share' | 'cache';
  // Encode-behavior toggles (form-side bool + string; serialized
  // → string for DB via serializeForApi).
  delete_original_after_encode: boolean;
  output_suffix: string;
  // Form-side container literal — passed through as-is to DB,
  // including 'match-source'.
  output_container: 'mkv' | 'mp4' | 'match-source';
  // Form-side output mode (passthrough to API, enum-shaped).
  output_mode: 'suffix' | 'replace';
  // Form-side sidecar mode + central root (passthrough to API).
  sidecar_mode: 'off' | 'beside' | 'central';
  sidecar_central_path: string;
  // Form-side trash root (passthrough to API; empty = auto-cache).
  trash_path: string;
  // gpu_device on FormValues — the device-picker field + its
  // form-schema entry live together (the pair MUST co-exist or the
  // settings-form zodResolver generic breaks: FormValues ≡ inferred schema).
  // Empty = auto (first-enumerated node = byte-identical default).
  gpu_device: string;
  // Form-side auto-crop toggle (bool) + crop_override (passthrough string,
  // empty=auto/none). Serialized → 'true'/'false' + raw string via serializeForApi.
  auto_crop: boolean;
  crop_override: string;
  // Form-side force-10bit toggle (bool). Serialized → 'true'/'false'.
  force_10bit: boolean;
  // Form-side color-passthrough toggle (bool). Serialized → 'true'/'false'.
  color_passthrough: boolean;
  vaapi_hw_decode: boolean;
};

export function serializeForApi(values: Partial<FormValues>): Partial<EditableSettings> {
  const out: Partial<EditableSettings> = {};
  if (values.language !== undefined) out.language = values.language;
  if (values.theme_override !== undefined) out.theme_override = values.theme_override;
  if (values.auto_encode !== undefined) {
    out.auto_encode = values.auto_encode ? 'true' : 'false';
  }
  // Encoder + concurrency passthrough; CRF number → string.
  if (values.encoder !== undefined) out.encoder = values.encoder;
  if (values.concurrency !== undefined) out.concurrency = values.concurrency;
  if (values.crf_libx265 !== undefined) out.crf_libx265 = String(values.crf_libx265);
  if (values.crf_nvenc !== undefined) out.crf_nvenc = String(values.crf_nvenc);
  if (values.crf_qsv !== undefined) out.crf_qsv = String(values.crf_qsv);
  if (values.crf_vaapi !== undefined) out.crf_vaapi = String(values.crf_vaapi);
  // Per-encoder preset passthrough (form-string → API-string;
  // zod enum-narrows at app/api/settings/route.ts. NO transform here —
  // settings-serialize is type-pass-through only).
  if (values.preset_libx265 !== undefined) out.preset_libx265 = values.preset_libx265;
  if (values.preset_nvenc !== undefined) out.preset_nvenc = values.preset_nvenc;
  if (values.preset_qsv !== undefined) out.preset_qsv = values.preset_qsv;
  if (values.preset_vaapi !== undefined) out.preset_vaapi = values.preset_vaapi;
  // 3-bucket verdict threshold (form number → DB string).
  if (values.stall_timeout_minutes !== undefined) {
    out.stall_timeout_minutes = String(values.stall_timeout_minutes);
  }
  if (values.trash_retention_days !== undefined) {
    out.trash_retention_days = String(values.trash_retention_days);
  }
  if (values.trash_enabled !== undefined) {
    out.trash_enabled = values.trash_enabled ? 'true' : 'false';
  }
  if (values.trash_location !== undefined) out.trash_location = values.trash_location;
  if (values.resume_after_restart !== undefined) {
    out.resume_after_restart = values.resume_after_restart ? '1' : '0';
  }
  if (values.min_savings_percent !== undefined) {
    out.min_savings_percent = String(values.min_savings_percent);
  }
  // 05-bonus: encode-behavior toggles.
  if (values.delete_original_after_encode !== undefined) {
    out.delete_original_after_encode = values.delete_original_after_encode ? 'true' : 'false';
  }
  if (values.output_suffix !== undefined) out.output_suffix = values.output_suffix;
  // Container — direct passthrough, already enum-shaped.
  if (values.output_container !== undefined) out.output_container = values.output_container;
  // Output mode — direct passthrough (enum-shaped).
  if (values.output_mode !== undefined) out.output_mode = values.output_mode;
  // Sidecar mode + central root — direct passthrough (enum / string).
  if (values.sidecar_mode !== undefined) out.sidecar_mode = values.sidecar_mode;
  if (values.sidecar_central_path !== undefined) {
    out.sidecar_central_path = values.sidecar_central_path;
  }
  // Trash root — direct string passthrough (no transform; empty=auto).
  if (values.trash_path !== undefined) out.trash_path = values.trash_path;
  // gpu_device — direct string passthrough (empty=auto). The route zod
  // enforces ''|/dev/dri/renderD<N> + the empty-trim + invalidate-on-change.
  if (values.gpu_device !== undefined) out.gpu_device = values.gpu_device;
  // auto_crop bool → string; crop_override direct passthrough (empty=auto).
  // The route zod enforces ''|even W:H:X:Y geometry + the empty-trim.
  if (values.auto_crop !== undefined) out.auto_crop = values.auto_crop ? 'true' : 'false';
  if (values.crop_override !== undefined) out.crop_override = values.crop_override;
  // force_10bit bool → string (mirror auto_crop).
  if (values.force_10bit !== undefined) out.force_10bit = values.force_10bit ? 'true' : 'false';
  // color_passthrough bool → string (mirror force_10bit).
  if (values.color_passthrough !== undefined)
    out.color_passthrough = values.color_passthrough ? 'true' : 'false';
  if (values.vaapi_hw_decode !== undefined)
    out.vaapi_hw_decode = values.vaapi_hw_decode ? 'true' : 'false';
  return out;
}
