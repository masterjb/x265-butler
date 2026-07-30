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
import os from 'node:os';
import { isValidPreset } from './presets';
import { logger } from '../logger';

const DEFAULT_VAAPI_DEVICE = '/dev/dri/renderD128';

// 37-01: x265 thread-pool cap. x265's NUMA/CPU auto-detection over-allocates on
// some high-core-count hosts (observed `Thread pool created using 21914 threads`
// on a 128-CPU unRAID box → encode + test-encode hang). Setting `pools=<N>`
// explicitly bypasses the auto-detect entirely. Returns the integer pool size,
// or null = emit NO arg (x265 native).
export const X265_POOLS_CEILING = 16;
export function resolveX265Pools(cpuCount: number, envOverride: string | undefined): number | null {
  const raw = (envOverride ?? '').trim();
  if (raw !== '') {
    // '0' or 'auto' (case-insensitive) = explicit native revert → no pools arg.
    if (raw === '0' || raw.toLowerCase() === 'auto') return null;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
    // anything else (NaN / negative / float / junk) → ignore, fall through to computed.
  }
  const cpu = Number.isFinite(cpuCount) && cpuCount > 0 ? Math.floor(cpuCount) : X265_POOLS_CEILING;
  return Math.max(1, Math.min(cpu, X265_POOLS_CEILING));
}

function readCpuCount(): number {
  try {
    return typeof os.availableParallelism === 'function'
      ? os.availableParallelism()
      : os.cpus().length;
  } catch {
    return X265_POOLS_CEILING; // can't read topology → safe bounded pool
  }
}
let _x265PoolsCache: number | null | undefined; // undefined = not yet computed
function x265Pools(): number | null {
  if (_x265PoolsCache === undefined) {
    const cpu = readCpuCount();
    const raw = process.env.X265_POOLS;
    _x265PoolsCache = resolveX265Pools(cpu, raw);
    // 37-01 audit AC-8: leave app-side evidence the cap engaged. Validation is
    // no-local-repro → a remote operator + post-incident reviewer must be able to
    // confirm the resolved pool size WITHOUT parsing the x265 banner from a raw log
    // paste. Once-per-process (memoized resolve fires exactly once) — same discipline
    // as warnQsvRateControlDefaultedOnce in ffmpeg.ts.
    const trimmed = (raw ?? '').trim();
    const source =
      _x265PoolsCache === null
        ? 'native-revert'
        : trimmed !== '' && Number.isInteger(Number(trimmed)) && Number(trimmed) > 0
          ? 'operator-override'
          : 'computed-cap';
    logger.info(
      { resolvedPools: _x265PoolsCache, source, cpuCount: cpu, x265PoolsEnv: raw ?? null },
      'x265: libx265 thread-pool cap resolved',
    );
  }
  return _x265PoolsCache;
}
// 37-01 test seam — never barrel-exported (consumed only by tests/encode/*).
export function __forTests_resetX265PoolsCache(): void {
  _x265PoolsCache = undefined;
}

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

// 30-01: QSV ratecontrol variant. The probe validates which one the iGPU
// actually runs; production/bench/diagnostics then emit the validated variant.
//  'icq-full' = `-global_quality <crf> -low_power 0` — ICQ on the full-encode
//               (VAEntrypointEncSlice) path. Best quality-per-bitrate; the path
//               a real-resolution production encode auto-selects.
//  'cqp'      = `-q:v <crf>` — constant-QP; the only mode the low-power (VDENC)
//               path runs, so the fallback that keeps LP-only chips on hardware
//               qsv instead of dropping them to libx265.
export type QsvRateControl = 'icq-full' | 'cqp';

export interface CodecBlockInput {
  encoder: EncoderId;
  crf: number;
  // 12-03 audit M3: REQUIRED (NOT optional) preset — forces every caller to
  // thread an explicit value; if optional, a silent fallback site outside
  // PROFILE_BUILDERS would defeat the defensive Catalog-validator below.
  preset: string;
  devicePath?: string;
  // 30-01 (additive): qsv-only ratecontrol variant. undefined ⇒ 'icq-full'
  // default so every pre-30-01 caller stays byte-identical for non-qsv encoders
  // and gets the ICQ-full block for qsv (the prior `-global_quality`-only block,
  // now path-pinned with `-low_power 0`). Ignored by nvenc/vaapi/libx265.
  qsvRateControl?: QsvRateControl;
  // 35-01 (additive): normalized `"W:H:X:Y"` auto-crop geometry (NO `crop=`
  // prefix — the per-encoder builders add it). D3 = CPU-crop uniform: a `crop`
  // filter on decoded frames BEFORE any hwupload, for all four encoders. When
  // undefined the produced block is BYTE-IDENTICAL to pre-35 (the byte-identical
  // default contract — AC-1). bench (vmaf.ts encodeForBench) never sets this, so
  // VMAF stays apples-to-apples by construction (AC-6).
  crop?: string;
  // 43-01 (additive): force a 10-bit HEVC Main10 output regardless of source
  // depth (HandBrake's "encode 8-bit as 10-bit"). When undefined/false the
  // produced block is BYTE-IDENTICAL to pre-43 for every encoder (the
  // byte-identical default contract — AC-1, same as `crop` 35-01). bench
  // (vmaf.ts encodeForBench) never sets this → VMAF stays source-depth by
  // construction (AC-8). Unconditional-when-ON: no source-depth probe (forcing
  // 10-bit on an already-10-bit source is a harmless no-op).
  tenBit?: boolean;
  // 43-04 (additive): pre-formatted HDR10 static-metadata strings from
  // ffprobe.extractHdr10. libx265 ONLY consumes them — merged into the single
  // `-x265-params` token as `master-display=…:max-cll=…`. undefined / both-null ⇒
  // byte-identical pre-43-04 for ALL FOUR encoders (the byte-identical default
  // contract — AC-1, same as `tenBit` 43-01). HW encoders (nvenc/qsv/vaapi) ignore
  // it and ride ffmpeg's automatic AVFrame-side-data → SEI passthrough (AC-6).
  // bench (vmaf.ts encodeForBench) never sets it → VMAF stays HDR10-free (AC-8).
  hdr10?: { masterDisplay: string | null; maxCll: string | null };
}

export interface EncodeProfileInput extends CodecBlockInput {
  input: string;
  output: string;
}

type ProfileBuilder = (
  crf: number,
  preset: string,
  devicePath?: string,
  qsvRateControl?: QsvRateControl,
  crop?: string,
  tenBit?: boolean,
  hdr10?: { masterDisplay: string | null; maxCll: string | null },
) => string[];

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
  // 35-01: CPU-crop prepended (D3). crop undefined → byte-identical to pre-35.
  // 37-01: append `-x265-params pools=<N>` (x265Pools()) AFTER -crf → caps the
  // x265 thread pool, bypassing NUMA/CPU auto-detect. null (X265_POOLS=0/auto) →
  // no arg = byte-identical to pre-37 native path.
  // 43-01: tenBit appends `-pix_fmt yuv420p10le -profile:v main10` AFTER -crf and
  // BEFORE the -x265-params tail. undefined/false → byte-identical to pre-43.
  // 43-04: HDR10 static metadata merges into the SAME single `-x265-params` token
  // as `master-display=…:max-cll=…` (colon-joined AFTER the 37-01 pools= segment).
  // x265 accepts ONE -x265-params token (a second would overwrite the first), so
  // the merge is mandatory. undefined / both-null → byte-identical to pre-43-04.
  libx265: (crf, preset, _devicePath, _qsvRateControl, crop, tenBit, hdr10) => {
    const pools = x265Pools();
    const x265Params: string[] = [];
    if (pools != null) x265Params.push(`pools=${pools}`);
    if (hdr10?.masterDisplay) x265Params.push(`master-display=${hdr10.masterDisplay}`);
    if (hdr10?.maxCll) x265Params.push(`max-cll=${hdr10.maxCll}`);
    return [
      ...(crop ? ['-vf', `crop=${crop}`] : []),
      '-c:v',
      'libx265',
      '-preset',
      resolvePreset('libx265', preset),
      '-crf',
      String(crf),
      ...(tenBit ? ['-pix_fmt', 'yuv420p10le', '-profile:v', 'main10'] : []),
      ...(x265Params.length ? ['-x265-params', x265Params.join(':')] : []),
    ];
  },

  // NVIDIA NVENC HEVC — preset p5 ≈ libx265 medium per Discovery §Findings.
  // `-rc constqp -qp <crf> -b:v 0` maps the user-facing CRF to NVENC's QP scale.
  // 2026-04-27 hotfix: encoder name is `hevc_nvenc` per `ffmpeg -encoders`.
  // 12-03: preset positional arg replaces hardcoded 'p5'; non-preset flags
  // (-tune hq, -rc constqp, -qp, -b:v 0) BYTE-IDENTICAL to pre-12-03 (audit SR1).
  // 35-01: CPU-crop prepended (D3) → nvenc implicit upload. undefined → byte-identical.
  // 43-01: tenBit appends `-pix_fmt p010le -profile:v main10` after `-b:v 0`.
  nvenc: (crf, preset, _devicePath, _qsvRateControl, crop, tenBit) => [
    ...(crop ? ['-vf', `crop=${crop}`] : []),
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
    ...(tenBit ? ['-pix_fmt', 'p010le', '-profile:v', 'main10'] : []),
  ],

  // Intel QuickSync HEVC — two-tier ratecontrol (30-01).
  // 12-03: preset positional arg replaces hardcoded 'slow'.
  // 25-02: the MSDK lookahead family removed — legacy Intel MSDK (libmfx)
  // options rejected by oneVPL/libvpl `hevc_qsv` with `(Invalid argument)`; the
  // v2.20.0+ image is libvpl-only after the 22-04 Trixie rebase + 23-00 oneVPL add.
  // 30-01: the variant is selected by detection's two-tier probe (default
  // 'icq-full'). WHY `-low_power 0`: ICQ (`-global_quality`) is only negotiable
  // on the full-encode VAEntrypointEncSlice path. The small synthetic probe
  // (testsrc 320x240) makes iHD AUTO-select the low-power VDENC path where ICQ is
  // rejected ("Selected ratecontrol mode is unsupported") → false `compiled-in-
  // broken` → qsv gated out of detected[] on functional HW (rasalf UHD 770,
  // i5-14500T, v2.24.0/v2.25.0 forum report). Pinning `-low_power 0` forces the
  // full path the real-resolution production encode already lands on, so ICQ
  // negotiates. WHY the CQP fallback: `-q:v` (constant-QP) is the ONLY mode the
  // low-power VDENC path can run — genuinely LP-only chips keep hardware qsv via
  // CQP instead of falling all the way back to libx265 (rasalf Variant-B proof).
  // 34-01: devicePath (was ignored `_devicePath`) is now LIVE. When the operator
  // pins a render node, `-init_hw_device qsv=hw:<node>` binds it. WHY this form:
  // oneVPL/QSV device selection on Linux; it is a GLOBAL/input option so it MUST
  // precede `-c:v hevc_qsv`. QSV does implicit hwupload, so NO `-vf` /
  // `-filter_hw_device` is required on the filterless transcode path — the
  // encoder auto-binds the single qsv device context. SHIPPED FORM (SR-3):
  // B-minus-filter = `-init_hw_device` only. Syntax confirmed accepted by the
  // image ffmpeg (qsv hwdevice type present; `qsv=hw:<node>` parses past option
  // validation to device-creation), but NOT runtime-verified on real Intel/Arc HW
  // (no local HW) → operator-validate v2.31.0. Two documented single-commit-revert
  // fallbacks if B-minus-filter fails on the Arc: (1) add `-filter_hw_device hw`;
  // (2) D-QSV-ARG=C VAAPI-derivation `-init_hw_device vaapi=va:<node>
  // -init_hw_device qsv=hw@va`. Empty/undefined devicePath → NO device tokens
  // (byte-identical to pre-34, the default-GPU path = AC-1).
  // 43-01: tenBit appends `-pix_fmt p010le -profile:v main10` at the END of BOTH
  // ratecontrol branches. undefined/false → byte-identical to pre-43.
  qsv: (crf, preset, devicePath, qsvRateControl, crop, tenBit) => {
    const deviceInit =
      devicePath && devicePath.length > 0 ? ['-init_hw_device', `qsv=hw:${devicePath}`] : [];
    // 35-01: CPU `crop` AFTER the 34-01 deviceInit tokens, BEFORE `-c:v` → qsv
    // implicit hwupload (no hwdevice forced). undefined → byte-identical.
    const cropArgs = crop ? ['-vf', `crop=${crop}`] : [];
    const tenBitArgs = tenBit ? ['-pix_fmt', 'p010le', '-profile:v', 'main10'] : [];
    return qsvRateControl === 'cqp'
      ? [
          ...deviceInit,
          ...cropArgs,
          '-c:v',
          'hevc_qsv',
          '-preset',
          resolvePreset('qsv', preset),
          '-q:v',
          String(crf),
          ...tenBitArgs,
        ]
      : [
          ...deviceInit,
          ...cropArgs,
          '-c:v',
          'hevc_qsv',
          '-preset',
          resolvePreset('qsv', preset),
          '-global_quality',
          String(crf),
          '-low_power',
          '0',
          ...tenBitArgs,
        ];
  },

  // Generic VAAPI HEVC — requires explicit `-vaapi_device` + `format=nv12,hwupload`
  // filter chain (no direct YUV→HW like NVENC). `-rc_mode CQP -qp <crf>` mirrors
  // the constant-QP semantics of NVENC for consistent operator UX.
  // 12-03 audit M5: `-compression_level 1` stays hardcoded AS the authoritative
  // driver-side quality knob; `-preset <value>` is layered on top as informational
  // metadata (some VAAPI drivers silently ignore the flag — see boundaries
  // §VAAPI-PRESET CAVEAT). Both flags ship in the argv.
  // 35-01: CPU crop merged into the filter chain BEFORE hwupload (crop on
  // decoded frames, then format/upload). undefined → byte-identical to pre-35.
  // 43-01: tenBit swaps the filter format token nv12→p010le (MH-1: p010le is the
  // canonical ffmpeg pix_fmt — bare `p010` fails filter-graph parse) and appends
  // `-profile:v main10` after `-compression_level 1`. The format swap composes
  // with the optional crop= token (4-cell tenBit×crop matrix). undefined/false →
  // byte-identical to pre-43 (format=nv12, no -profile:v).
  vaapi: (crf, preset, devicePath, _qsvRateControl, crop, tenBit) => {
    const format = tenBit ? 'p010le' : 'nv12';
    return [
      '-vaapi_device',
      devicePath ?? DEFAULT_VAAPI_DEVICE,
      '-vf',
      crop ? `crop=${crop},format=${format},hwupload` : `format=${format},hwupload`,
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
      ...(tenBit ? ['-profile:v', 'main10'] : []),
    ];
  },
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
  return builder(
    input.crf,
    input.preset,
    input.devicePath,
    input.qsvRateControl,
    input.crop,
    input.tenBit,
    input.hdr10,
  );
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
