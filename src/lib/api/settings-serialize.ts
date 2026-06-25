// audit-added S6: form-to-API serialization helper. Converts form values
// (numbers for crf_*, min_savings_percent) to the string shape the DB stores
// + the PUT API expects. Keeps the boundary explicit and unit-testable.
//
// 14-04 (Plan 14-04 Task 5): legacy single-share keys scan_root / extensions
// / min_size_mb / max_depth removed from this surface — multi-share source of
// truth is shareRepo() via /api/shares. cache_pool_path STAYS (settings-level
// concern). parseExtensions removed (no consumer post-14-04).

import type { FormatLocale } from '@/src/lib/format';

// 34-02: stable client-facing shape for one probed /dev/dri/renderD* node.
// Derived from the 23-02 RenderDeviceProbe but narrowed to the fields the GPU
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
  // 26-02 (F5): output strategy (suffix-sibling vs in-place replace). DB stores
  // TEXT; default 'suffix' applied via orchestrator code-fallback, NOT a seed.
  output_mode: 'suffix' | 'replace';
  // 26-01 (F3): sidecar location mode + central root (DB stores TEXT; defaults
  // applied via orchestrator code-fallback, NOT a default-seed migration).
  sidecar_mode: 'off' | 'beside' | 'central';
  sidecar_central_path: string;
  // 33-02: operator-configurable originals-trash root. Empty = auto (track the
  // cache stageRoot = byte-identical to pre-33-02), NOT sidecar's .min(1) idiom.
  trash_path: string;
  // 34-01: operator-pinned /dev/dri/renderD* node for HW encoders. Empty = auto
  // (first-enumerated node = byte-identical pre-34). DB stores TEXT.
  gpu_device: string;
  // 35-02: auto-crop / black-bar removal (surfaces 35-01 backend). DB stores TEXT.
  // auto_crop bool-string (mirror delete_original_after_encode); crop_override =
  // fixed W:H:X:Y geometry, empty = auto/none (a valid override wins over the
  // toggle per 35-01 resolve). Default off/empty = byte-identical pre-35.
  auto_crop: 'true' | 'false';
  crop_override: string;
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
  // 26-02 (F5): form-side output mode (passthrough to API, enum-shaped).
  output_mode: 'suffix' | 'replace';
  // 26-01 (F3): form-side sidecar mode + central root (passthrough to API).
  sidecar_mode: 'off' | 'beside' | 'central';
  sidecar_central_path: string;
  // 33-02: form-side trash root (passthrough to API; empty = auto-cache).
  trash_path: string;
  // 34-02: gpu_device now on FormValues — the device-picker field + its
  // form-schema entry land together in this plan (the pair MUST co-exist or the
  // settings-form zodResolver generic breaks: FormValues ≡ inferred schema).
  // Empty = auto (first-enumerated node = byte-identical pre-34).
  gpu_device: string;
  // 35-02: form-side auto-crop toggle (bool) + crop_override (passthrough string,
  // empty=auto/none). Serialized → 'true'/'false' + raw string via serializeForApi.
  auto_crop: boolean;
  crop_override: string;
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
  // 26-02 (F5): output mode — direct passthrough (enum-shaped).
  if (values.output_mode !== undefined) out.output_mode = values.output_mode;
  // 26-01 (F3): sidecar mode + central root — direct passthrough (enum / string).
  if (values.sidecar_mode !== undefined) out.sidecar_mode = values.sidecar_mode;
  if (values.sidecar_central_path !== undefined) {
    out.sidecar_central_path = values.sidecar_central_path;
  }
  // 33-02: trash root — direct string passthrough (no transform; empty=auto).
  if (values.trash_path !== undefined) out.trash_path = values.trash_path;
  // 34-02: gpu_device — direct string passthrough (empty=auto). The route zod
  // enforces ''|/dev/dri/renderD<N> + the empty-trim + invalidate-on-change.
  if (values.gpu_device !== undefined) out.gpu_device = values.gpu_device;
  // 35-02: auto_crop bool → string; crop_override direct passthrough (empty=auto).
  // The route zod enforces ''|even W:H:X:Y geometry + the empty-trim.
  if (values.auto_crop !== undefined) out.auto_crop = values.auto_crop ? 'true' : 'false';
  if (values.crop_override !== undefined) out.crop_override = values.crop_override;
  return out;
}
