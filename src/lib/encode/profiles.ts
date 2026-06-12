// Phase 3 Plan 03-01 Task 1 — encoder profile registry.
//
// Single source of truth for the per-encoder ffmpeg argument blocks. Phase 2's
// libx265 codec block is preserved BYTE-IDENTICAL when the orchestrator passes
// no encoder (or 'libx265') — the regression gate in tests/encode/ffmpeg.test.ts
// proves this against the pre-03-01 buildArgs output.
//
// Audit notes:
//  M5 — buildCodecBlock returns ONLY the codec-specific portion. ffmpeg.ts owns
//       the envelope (-hide_banner -nostats -y -i input ... -progress pipe:1
//       output). buildEncodeArgs composes the full array for callers that want
//       the complete spawn args in one call.
//  S6 — VAAPI device path is passed through `devicePath`. NEVER hardcode
//       /dev/dri/renderD128; the detection helper captures the actual probed
//       device.
//
// Adding a new encoder (Milestone 2 AV1 etc.) means: add the EncoderId literal
// in detection.ts, add a PROFILE_BUILDERS entry below, add a per-encoder
// crf_<id> seed in the next migration. No other code changes.

// EncoderId + ENCODER_IDS live in this leaf module so the codec namespace is
// importable WITHOUT triggering detection.ts's server-only side-effect (which
// uses node:child_process and a typeof-window guard). Detection helper
// re-imports both from here.
export const ENCODER_IDS = ['nvenc', 'qsv', 'vaapi', 'libx265'] as const;
export type EncoderId = (typeof ENCODER_IDS)[number];

// 12-03 audit M3: Catalog-validator import. presets.ts uses `import type
// EncoderId from './profiles'` which is type-erased at runtime — so the
// runtime cycle profiles.ts → presets.ts is one-way (NOT a real circular
// dependency at the module-evaluation level).
import { isValidPreset } from './presets';

const DEFAULT_VAAPI_DEVICE = '/dev/dri/renderD128';

// 29-01: single source of truth for the HW-safe probe/test-encode frame size.
// 320x240 is the 21-02 NVENC-minimum-safe value (well above QSV/VAAPI HEVC min
// frame dims too). 16x16 — the pre-29-01 detection probe size — is BELOW the
// QSV/VAAPI/NVENC minimum → "Could not open encoder before EOF" / exit -22 →
// false `compiled-in-broken` → HW encoder gated out of detected[] → libx265
// fallback on good HW. Both buildProbeEncodeArgs (detection) and
// buildTestEncodeArgs (diagnostics) consume THIS const so the two arg-builders
// can never drift apart again (the drift WAS this bug).
export const PROBE_FRAME_SIZE = '320x240';

// 12-03: factory-default preset per encoder. MUST match migration 0024 seeds
// AND the pre-12-03 PROFILE_BUILDERS hardcoded preset values per encoder so
// AC-12 byte-identical orchestrator output holds for operators who never
// touch the Settings UI. AC-14 3-place consistency invariant test verifies
// this table against the migration + the (now-fallback) builder body.
export const DEFAULT_PRESET_BY_ENCODER: Record<EncoderId, string> = {
  libx265: 'medium',
  nvenc: 'p5',
  qsv: 'slow',
  vaapi: 'slow',
};

export interface CodecBlockInput {
  encoder: EncoderId;
  crf: number;
  // 12-03 audit M3: REQUIRED (NOT optional) preset — forces every caller to
  // thread an explicit value; if optional, a silent fallback site outside
  // PROFILE_BUILDERS would defeat the defensive Catalog-validator below.
  preset: string;
  devicePath?: string;
}

export interface EncodeProfileInput extends CodecBlockInput {
  input: string;
  output: string;
}

type ProfileBuilder = (crf: number, preset: string, devicePath?: string) => string[];

// 12-03 audit M3: Catalog-validator-fallback. Mirrors presets.ts isValidPreset
// at the dispatch layer — invalid preset → DEFAULT_PRESET_BY_ENCODER fallback.
function resolvePreset(encoder: EncoderId, preset: string): string {
  return isValidPreset(encoder, preset) ? preset : DEFAULT_PRESET_BY_ENCODER[encoder];
}

export const PROFILE_BUILDERS: Record<EncoderId, ProfileBuilder> = {
  // Phase 2 byte-identical libx265 codec block — `medium` preset matches the
  // pre-03-01 ffmpeg.ts default. 12-03 makes the preset operator-overridable
  // via settings.preset_libx265 → orchestrator dispatch → buildArgs → here.
  // Invalid preset → DEFAULT_PRESET_BY_ENCODER fallback (defensive).
  libx265: (crf, preset) => [
    '-c:v',
    'libx265',
    '-preset',
    resolvePreset('libx265', preset),
    '-crf',
    String(crf),
  ],

  // NVIDIA NVENC HEVC — preset p5 ≈ libx265 medium per Discovery §Findings.
  // `-rc constqp -qp <crf> -b:v 0` maps the user-facing CRF to NVENC's QP scale.
  // 2026-04-27 hotfix: encoder name is `hevc_nvenc` per `ffmpeg -encoders`.
  // 12-03: preset positional arg replaces hardcoded 'p5'; non-preset flags
  // (-tune hq, -rc constqp, -qp, -b:v 0) BYTE-IDENTICAL to pre-12-03 (audit SR1).
  nvenc: (crf, preset) => [
    '-c:v',
    'hevc_nvenc',
    '-preset',
    resolvePreset('nvenc', preset),
    '-tune',
    'hq',
    '-rc',
    'constqp',
    '-qp',
    String(crf),
    '-b:v',
    '0',
  ],

  // Intel QuickSync HEVC — `-global_quality` is QSV's CRF-equivalent (ICQ mode).
  // 12-03: preset positional arg replaces hardcoded 'slow'.
  // 25-02: the MSDK lookahead family (the two prior trailing flag/value pairs) removed —
  // legacy Intel MSDK (libmfx) options rejected by oneVPL/libvpl `hevc_qsv` with
  // `(Invalid argument)`; the v2.20.0+ image is libvpl-only after the 22-04 Trixie
  // rebase + 23-00 oneVPL add. `-global_quality` (ICQ) + `-preset` retained.
  qsv: (crf, preset) => [
    '-c:v',
    'hevc_qsv',
    '-preset',
    resolvePreset('qsv', preset),
    '-global_quality',
    String(crf),
  ],

  // Generic VAAPI HEVC — requires explicit `-vaapi_device` + `format=nv12,hwupload`
  // filter chain (no direct YUV→HW like NVENC). `-rc_mode CQP -qp <crf>` mirrors
  // the constant-QP semantics of NVENC for consistent operator UX.
  // 12-03 audit M5: `-compression_level 1` stays hardcoded AS the authoritative
  // driver-side quality knob; `-preset <value>` is layered on top as informational
  // metadata (some VAAPI drivers silently ignore the flag — see boundaries
  // §VAAPI-PRESET CAVEAT). Both flags ship in the argv.
  vaapi: (crf, preset, devicePath) => [
    '-vaapi_device',
    devicePath ?? DEFAULT_VAAPI_DEVICE,
    '-vf',
    'format=nv12,hwupload',
    '-c:v',
    'hevc_vaapi',
    '-preset',
    resolvePreset('vaapi', preset),
    '-rc_mode',
    'CQP',
    '-qp',
    String(crf),
    '-compression_level',
    '1',
  ],
};

export function buildCodecBlock(input: CodecBlockInput): string[] {
  const builder = PROFILE_BUILDERS[input.encoder];
  if (!builder) {
    throw new TypeError(
      `buildCodecBlock: unknown encoder '${input.encoder}' (expected one of ${Object.keys(
        PROFILE_BUILDERS,
      ).join(', ')})`,
    );
  }
  return builder(input.crf, input.preset, input.devicePath);
}

const ENVELOPE_HEAD = (input: string): string[] => ['-hide_banner', '-nostats', '-y', '-i', input];

const ENVELOPE_TAIL = (output: string): string[] => [
  '-c:a',
  'copy',
  '-c:s',
  'copy',
  '-map',
  '0',
  '-map_metadata',
  '0',
  '-movflags',
  '+faststart',
  '-progress',
  'pipe:1',
  output,
];

export function buildEncodeArgs(input: EncodeProfileInput): string[] {
  return [...ENVELOPE_HEAD(input.input), ...buildCodecBlock(input), ...ENVELOPE_TAIL(input.output)];
}
