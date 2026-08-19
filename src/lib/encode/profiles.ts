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

// 49-03: the pixel format both SYNTHETIC arg-builders pin their probe input to.
// Same 29-01 reasoning as PROBE_FRAME_SIZE right above: a value shared by
// buildProbeEncodeArgs (detection boot probe) and buildTestEncodeArgs
// (/diagnostics test encode) lives in ONE const so the two builders can never
// drift apart — the drift IS how 29-01's bug happened.
//
// nv12 = the 8-bit 4:2:0 format every HEVC HW encoder accepts natively. The
// `testsrc` source produces rgb24, and modern `hevc_qsv` builds advertise RGB in
// their `pix_fmts` table, so ffmpeg inserts NO converter and iHD rejects the
// frame (`Current pixel format is unsupported`) — a false `compiled-in-broken`
// on hardware whose real encodes run fine.
export const SYNTHETIC_PROBE_PIX_FMT = 'nv12';

// 49-03: the encoders that CONSUME the pin. Encapsulated as a predicate (not an
// inline `enc === 'qsv' || enc === 'nvenc'` in two files) for the same
// single-source reason as the const above.
//  - qsv   → the encoder the reported false-negative actually hit.
//  - nvenc → the same auto-conversion gap is plausible there; the pin is
//            risk-free (nv12 is its native input) but NOT a proven need.
//  - libx265 → nv12 is not in its pix_fmts table; ffmpeg converts rgb24 by
//            itself and a pin would BREAK the block.
//  - vaapi → already pins the format inside `format=nv12|p010le,hwupload`.
export function usesSyntheticPixFmtPin(encoder: EncoderId): boolean {
  return encoder === 'qsv' || encoder === 'nvenc';
}

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

// 49-05: the per-encoder factory CRF defaults live in the dependency-free leaf
// `./crf-defaults` (this file imports node:os + the pino logger, so a client
// component can never take a VALUE import from here — audit MH-1). Re-exported
// next to DEFAULT_PRESET_BY_ENCODER purely for SERVER import ergonomics; client
// components MUST import the leaf path directly.
export { DEFAULT_CRF_BY_ENCODER } from './crf-defaults';

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
  // 49-01 (additive): the video ordinals that are actually ENCODED, i.e. the
  // complement of the embedded-cover-art ordinals (see attached-pic.ts). When
  // set, every video filter is emitted with a per-ordinal specifier
  // (`-filter:v:<n> <chain>`) instead of the bare `-vf <chain>`.
  // WHY THIS IS NOT COSMETIC: a bare `-vf` matches EVERY video output stream,
  // including a stream that carries `-c:v:N copy`. ffmpeg then refuses to open
  // the output at all:
  //   [vost#0:1/copy] Filtergraph 'crop=…' was specified, but codec copy was
  //   selected. Filtering and streamcopy cannot be used together.
  // That hits vaapi UNCONDITIONALLY (its `format=…,hwupload` chain is not
  // crop-dependent) and libx265/nvenc/qsv as soon as auto-crop resolves a
  // geometry. undefined / empty ⇒ bare `-vf` ⇒ BYTE-IDENTICAL to pre-49 (the
  // byte-identical default contract — same as `crop` 35-01, `tenBit` 43-01).
  videoFilterOrdinals?: ReadonlyArray<number>;
  // 49-02 (additive): pin the encoder to CLOSED GOP so every keyframe — the ones
  // `-force_key_frames` forces AND the encoder's own — is a real IDR, not an open
  // CRA. undefined/false ⇒ block BYTE-IDENTICAL to v2.45.0 for all four encoders
  // (the byte-identical default contract — same as `crop` 35-01, `tenBit` 43-01).
  //
  // WHY A SECOND KNOB: interval and IDR-ness are INDEPENDENT. Measured (M2,
  // ffmpeg 6.1.1, raw HEVC NAL types): `-force_key_frames` alone gives the right
  // 5 s spacing but 1 IDR + 5 CRA; `open-gop=0` alone gives 3 IDR / 0 CRA at the
  // WRONG 10.4 s spacing; both together give 6 IDR / 0 CRA at 5 s. CRA + RASL
  // leading pictures IS the "block garbage over the picture" signature.
  //
  // MUST NOT be read from process.env inside this module — see the note on
  // buildCodecBlock below (bench Pass-1 apples-to-apples).
  forceIdr?: boolean;
  // 49-03 (additive): pin the encoder input pixel format. undefined ⇒ block
  // BYTE-IDENTICAL to v2.46.0 for all four encoders (the byte-identical default
  // contract — same as `crop` 35-01, `tenBit` 43-01, `forceIdr` 49-02).
  //
  // WHY IT EXISTS (G3, N100 forum report): the two SYNTHETIC arg-builders feed
  // `testsrc`, which produces `rgb24`. Modern `hevc_qsv` builds list RGB in their
  // `pix_fmts` table, so ffmpeg does NOT auto-insert a converter — it hands RGB
  // straight to the runtime and iHD refuses it (`Current pixel format is
  // unsupported`). Boot detection and /diagnostics then report the encoder BROKEN
  // while the very same host's real encodes (whose sources are yuv420p) RUN.
  //
  // WHO SETS IT: `buildProbeEncodeArgs` (detection.ts) and `buildTestEncodeArgs`
  // (test-encode.ts) — the two synthetic builders — and NOBODY else.
  // WHO NEVER SETS IT: `buildArgs` (ffmpeg.ts, production) and the bench Pass-1
  // path (vmaf.ts encodeForBench + the orchestrator CRF sweep). The production
  // argv is therefore byte-identical to v2.46.0 and NEEDS NO kill-switch (D6).
  //
  // Consumed by qsv + nvenc ONLY. libx265 and vaapi deliberately ignore it — see
  // the per-builder comments; a pin would BREAK both rather than be neutral.
  pixFmt?: string;
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
  videoFilterOrdinals?: ReadonlyArray<number>,
  // 49-02: NINTH positional parameter. The positional signature is kept for
  // consistency with the eight existing parameters (minimal diff); a refactor to
  // an options object is deliberately DEFERRED.
  forceIdr?: boolean,
  // 49-03: TENTH positional parameter. Same reasoning as the ninth — positional
  // for consistency, the options-object refactor stays DEFERRED.
  pixFmt?: string,
) => string[];

// 49-01: the ONE place that turns a filter chain into argv tokens. All four
// builders route through it so a future builder cannot silently keep emitting
// the bare specifier. No ordinals ⇒ the bare `-vf` pair ⇒ byte-identical to pre-49.
// With ordinals ⇒ one `-filter:v:<n> <chain>` pair per ENCODED video ordinal;
// the chain itself is character-identical, only the specifier changes. Several
// encoded video streams are handled symmetrically to several covers: each gets
// its own pair with the same chain.
function videoFilterArgs(chain: string, ordinals?: ReadonlyArray<number>): string[] {
  if (!ordinals || ordinals.length === 0) return ['-vf', chain];
  return ordinals.flatMap((n) => [`-filter:v:${n}`, chain]);
}

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
  // 49-02: forceIdr appends `open-gop=0` as the LAST segment of that SAME single
  // token (43-04 merge rule — a second -x265-params would overwrite the first).
  // Measured (M2): open-gop=0 turns every keyframe into an IDR (CRA 0), the
  // forced ones AND the encoder's own. undefined/false → byte-identical to pre-49-02.
  // 49-03: `pixFmt` is deliberately NOT consumed. `nv12` is NOT in libx265's
  // `pix_fmts` table, so ffmpeg auto-inserts a converter for the rgb24 testsrc all
  // by itself — libx265 never had the G3 false-negative. Pinning nv12 here would
  // not be neutral, it would BREAK the block (unsupported input format).
  libx265: (
    crf,
    preset,
    _devicePath,
    _qsvRateControl,
    crop,
    tenBit,
    hdr10,
    videoFilterOrdinals,
    forceIdr,
    _pixFmt,
  ) => {
    const pools = x265Pools();
    const x265Params: string[] = [];
    if (pools != null) x265Params.push(`pools=${pools}`);
    if (hdr10?.masterDisplay) x265Params.push(`master-display=${hdr10.masterDisplay}`);
    if (hdr10?.maxCll) x265Params.push(`max-cll=${hdr10.maxCll}`);
    if (forceIdr) x265Params.push('open-gop=0');
    return [
      ...(crop ? videoFilterArgs(`crop=${crop}`, videoFilterOrdinals) : []),
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
  // 49-02: forceIdr appends `-forced-idr 1` LAST. NOTE THE HYPHEN — nvenc spells
  // the option `-forced-idr`, qsv spells it `-forced_idr`. Both forms are taken
  // verbatim from `ffmpeg -h encoder=…` (M3/M5d), NOT from memory.
  //
  // PROBE DIVERGENCE (same caveat as the qsv builder below, AC-18): `forceIdr` is
  // set ONLY by buildArgs, so detection.ts (probe), diagnostics/test-encode.ts and
  // vmaf.ts (bench Pass-1) never emit this token — the option ships to production
  // UNPROBED. Production nvenc additionally runs on the jellyfin `ffmpeg-nvenc`
  // binary (45-01), not on BtbN; `-forced-idr` is a long-standing NVENC option and
  // expected to be present there, but it was verified locally against ffmpeg 6.1.1
  // only. Recovery if a runtime rejects it: ENCODE_CLOSED_GOP_DISABLED=1 + restart.
  //
  // 49-03: `pixFmt` emits `-pix_fmt <value>` at EXACTLY the position tenBit's own
  // pin occupies (after `-b:v 0`, before the IDR token). Both flow through ONE
  // `pixFmtArgs` variable so no code path can ever produce TWO `-pix_fmt` tokens
  // (ffmpeg would take the last one → position-dependent instead of specified).
  // tenBit WINS: an explicit 10-bit request outranks the synthetic 8-bit probe pin.
  nvenc: (
    crf,
    preset,
    _devicePath,
    _qsvRateControl,
    crop,
    tenBit,
    _hdr10,
    videoFilterOrdinals,
    forceIdr,
    pixFmt,
  ) => {
    // AC-4: ONE source for the pin. tenBit → p010le (+ main10 profile); else the
    // synthetic pixFmt if the caller asked for one; else nothing (byte-identical).
    const pixFmtArgs = tenBit ? ['-pix_fmt', 'p010le'] : pixFmt ? ['-pix_fmt', pixFmt] : [];
    // `-profile:v main10` stays bound to tenBit ALONE — an 8-bit nv12 pin must
    // never drag a 10-bit profile in with it.
    const tenBitArgs = [...pixFmtArgs, ...(tenBit ? ['-profile:v', 'main10'] : [])];
    return [
      ...(crop ? videoFilterArgs(`crop=${crop}`, videoFilterOrdinals) : []),
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
      ...tenBitArgs,
      ...(forceIdr ? ['-forced-idr', '1'] : []),
    ];
  },

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
  // 49-02: forceIdr appends `-forced_idr 1` at the END of BOTH branches, after
  // tenBitArgs. UNDERSCORE here, HYPHEN for nvenc — both taken verbatim from
  // `ffmpeg -h encoder=hevc_qsv` / `=hevc_nvenc` (M3/M5d). `hevc_qsv` also has an
  // `-idr_interval` (default 0); it is deliberately NOT emitted — `-forced_idr` is
  // the direct knob and a redundant token would only create false confidence.
  //
  // ⚠ PROBE DIVERGENCE — AC-18, the reason ENCODE_CLOSED_GOP_DISABLED exists:
  // `-forced_idr` is set EXCLUSIVELY via buildArgs. The three OTHER buildCodecBlock
  // callers — detection.ts:403 (probe encode), diagnostics/test-encode.ts:110
  // (the /diagnostics test encode) and bench/vmaf.ts:197 (bench Pass-1) — never set
  // `forceIdr`, by this plan's own boundaries. So the option is ACTIVE in production
  // but NEVER PROBED: on a oneVPL/iHD runtime that rejects it, /diagnostics reports
  // "QSV healthy" while 100 % of real QSV jobs die. That is the 25-02 shape
  // (`-look_ahead` was MSDK-only, libvpl answered `(Invalid argument)`), only
  // INVERTED — back then the diagnosis was too pessimistic, now it is too
  // optimistic. Error signature in the job log: `Error setting option` /
  // `Unrecognized option` / `(Invalid argument)` around forced_idr.
  // Recovery: ENCODE_CLOSED_GOP_DISABLED=1 + container restart (CLAUDE.md).
  // HANDOVER TO 49-03: 49-03 touches detection.ts and test-encode.ts anyway
  // (`-pix_fmt` pin) and should carry `forceIdr` into them so diagnosis and
  // production say the same thing again. 49-02 does NOT rely on that — it ships
  // the recovery itself.
  //
  // 49-03: qsv is the encoder the G3 false-negative actually hit. `pixFmt` emits
  // `-pix_fmt <value>` at EXACTLY the position tenBit's own pin occupies (in the
  // icq-full branch after `-low_power 0`, in the cqp branch after `-q:v <crf>`,
  // in both BEFORE the IDR token). Both flow through ONE `pixFmtArgs` variable so
  // no code path can ever produce TWO `-pix_fmt` tokens. tenBit WINS.
  qsv: (
    crf,
    preset,
    devicePath,
    qsvRateControl,
    crop,
    tenBit,
    _hdr10,
    videoFilterOrdinals,
    forceIdr,
    pixFmt,
  ) => {
    const deviceInit =
      devicePath && devicePath.length > 0 ? ['-init_hw_device', `qsv=hw:${devicePath}`] : [];
    // 35-01: CPU `crop` AFTER the 34-01 deviceInit tokens, BEFORE `-c:v` → qsv
    // implicit hwupload (no hwdevice forced). undefined → byte-identical.
    const cropArgs = crop ? videoFilterArgs(`crop=${crop}`, videoFilterOrdinals) : [];
    // AC-4: ONE source for the pin; `-profile:v main10` stays bound to tenBit alone.
    const pixFmtArgs = tenBit ? ['-pix_fmt', 'p010le'] : pixFmt ? ['-pix_fmt', pixFmt] : [];
    const tenBitArgs = [...pixFmtArgs, ...(tenBit ? ['-profile:v', 'main10'] : [])];
    const idrArgs = forceIdr ? ['-forced_idr', '1'] : [];
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
          ...idrArgs,
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
          ...idrArgs,
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
  // 49-01: vaapi is the encoder that makes the filter narrowing MANDATORY — its
  // chain is emitted unconditionally, so a cover stream would collide with it on
  // EVERY vaapi job, not just cropped ones.
  // 49-02: vaapi is the ONE encoder that emits NO IDR token, even with forceIdr.
  // Reasons, from the binary's own option table (M3/M5d): `hevc_vaapi` has no
  // `forced_idr` at all — its only related knob is `-idr_interval <int>` whose
  // DEFAULT 0 already means "every I frame is an IDR" — and vaapi_encode sets
  // force_idr on a forced keyframe regardless. Emitting `-idr_interval 0` would be
  // a no-op token that manufactures false confidence, so it is deliberately absent.
  // OPEN CONTRADICTION, recorded not resolved: if that default really holds, VAAPI
  // should never have shown the reporter's stage-2 block garbage — yet it did.
  // Either the default behaves differently than documented, or VAAPI has a SECOND
  // cause. 49-02 does not claim to close the VAAPI case; the interval fix applies
  // to it either way (`-force_key_frames` is encoder-agnostic).
  // 49-03: `pixFmt` is deliberately NOT consumed. vaapi hands HW frames to the
  // encoder and ALREADY pins the format inside its own filter chain
  // (`format=nv12|p010le,hwupload`). A second `-pix_fmt nv12` on the encoder side
  // would fight that chain — harmful, not neutral. So vaapi is the one encoder
  // where BOTH 49-02's IDR token and 49-03's pin are absent by design.
  vaapi: (
    crf,
    preset,
    devicePath,
    _qsvRateControl,
    crop,
    tenBit,
    _hdr10,
    videoFilterOrdinals,
    _forceIdr,
    _pixFmt,
  ) => {
    const format = tenBit ? 'p010le' : 'nv12';
    return [
      '-vaapi_device',
      devicePath ?? DEFAULT_VAAPI_DEVICE,
      ...videoFilterArgs(
        crop ? `crop=${crop},format=${format},hwupload` : `format=${format},hwupload`,
        videoFilterOrdinals,
      ),
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

// 49-02 INVARIANT, not negotiable: neither this function nor any PROFILE_BUILDERS
// entry may read `ENCODE_CLOSED_GOP_DISABLED` (or any keyframe env) from
// process.env. `encodeForBench` (vmaf.ts:197) calls buildCodecBlock DIRECTLY — an
// env read inside the builder would push the IDR pin into every bench Pass-1
// encode and break the apples-to-apples measurement invariant (11-03 SR3 /
// 35-01 AC-6 / 43-01 AC-8). `forceIdr` is set by buildArgs (ffmpeg.ts) and by
// nothing else. Same rule the `crop` / `tenBit` / `hdr10` fields already follow.
//
// 49-03 EXTENDS THAT INVARIANT TO THE DETECTION CACHE (AC-22): this module must
// ALSO never reach into the cached detection result on globalThis, nor call the
// accessor that reads the forced-IDR verdict out of it. Same reason, one level
// deeper — `encodeForBench` calls buildCodecBlock DIRECTLY, so such a read HERE
// would push the IDR pin into every bench Pass-1 argv silently and without test
// coverage. Both verdict read sites live in ffmpeg.ts (`buildArgs`) and
// test-encode.ts (`runTestEncode`), the two NON-bench callers. The gate is an
// executed argv assertion in tests/encode/bench-argv-isolation.test.ts, with a
// name grep over this file as the second line of defence — so the identifiers
// are deliberately NOT spelled out here, not even in prose.
// `pixFmt` obeys the same rule: a plain input value like `crop`/`tenBit`, never
// resolved inside the builder.
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
    input.videoFilterOrdinals,
    input.forceIdr,
    input.pixFmt,
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
