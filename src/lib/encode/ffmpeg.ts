import { spawn } from 'node:child_process';
import { logger } from '../logger';
import { ffmpegBinaryFor } from './ffmpeg-binary';
import { reniceChild } from './child-priority';
import {
  buildCodecBlock,
  DEFAULT_PRESET_BY_ENCODER,
  type EncoderId,
  type QsvRateControl,
} from './profiles';
// Real qsv encodes resolve the detection-validated ratecontrol variant.
// detection.ts does NOT import ffmpeg.ts, so this edge is acyclic.
import {
  getActiveQsvRateControl,
  isQsvRateControlValidated,
  // The forced-IDR verdict (fail-OPEN when nothing was proven).
  isForcedIdrSupported,
} from './detection';
// The two keyframe env levers. Read HERE (buildArgs = the production
// path) and never inside profiles.ts — see the invariant note on buildCodecBlock.
// forceKeyFrameArgs MOVED into the keyframe leaf (pulled, not copied) so
// the /diagnostics test encode emits the SAME token from the SAME source.
import { closedGopEnabled, forceKeyFrameArgs, keyframeIntervalSec } from './keyframe';
import { muxerArgsFor, type OutputContainer } from './output-container';
import { vaapiDecodeInputArgs, type VaapiHwDecodeArgvMode } from './hw-decode';
import type { AudioAutoTranscodeTarget } from './audio-compat';
// Type-only — the runtime spawn half of cover-extract.ts is never pulled
// into buildArgs, which stays a pure function of its options.
import type { CoverAttachment } from './cover-extract';
import type { SourceColor, SourceHdr10 } from '../scan/ffprobe';

// Process-once guard so a cold-cache qsv encode logs the
// defaulted-variant fact exactly once per process, not per-encode.
let qsvDefaultedWarned = false;
function warnQsvRateControlDefaultedOnce(): void {
  if (qsvDefaultedWarned) return;
  qsvDefaultedWarned = true;
  logger.warn(
    { action: 'qsv_ratecontrol_defaulted' },
    'qsv ratecontrol defaulted to icq-full — no validated variant in the detection cache (cold process / detection not run / qsv was probe-inconclusive)',
  );
}

// Test-only reset of the once-flag (never barrel-exported).
export function __forTests_resetQsvDefaultedWarn(): void {
  qsvDefaultedWarned = false;
}

// ProgressEvent shape.
export type ProgressEvent = {
  frame: number | null;
  fps: number | null;
  outTimeMs: number | null;
  totalSize: number | null;
  // ffmpeg's native speed multiplier (e.g. "1.23x"→1.23, "N/A"→null,
  // absent→null, "0x"→0). Already in the -progress stream → no new flag, argv
  // byte-identical. Guarded out downstream (ETA needs speed>0).
  speed: number | null;
  progress: 'continue' | 'end';
};

export type EncodeOptions = {
  input: string;
  output: string;
  crf: number;
  preset?: string;
  // Encoder + VAAPI device path. When `encoder` is
  // undefined the dispatch defaults to 'libx265' and the produced args are
  // BYTE-IDENTICAL to the original libx265 buildArgs output (regression
  // gate enforced by tests/encode/ffmpeg.test.ts byte-identical assertion).
  encoder?: EncoderId;
  vaapiDevice?: string;
  // Optional MKV global tags appended after `-map_metadata 0`
  // (last-write-wins overrides input metadata for keys we explicitly set).
  // When undefined, buildArgs output is BYTE-IDENTICAL to the output without
  // tags (tests/encode/ffmpeg.test.ts byte-identical args).
  metadata?: ReadonlyArray<readonly [string, string]>;
  onProgress?: (ev: ProgressEvent) => void;
  signal?: AbortSignal;
  // Optional per-job log capture. When provided, every
  // stdout+stderr chunk is written to this stream (alongside the existing
  // byte-cap + tail logic). When undefined, ffmpeg.ts behaves exactly as
  // without capture.
  onLogChunk?: (chunk: Buffer | string) => void;
  // Output container — controls muxer-args plumbing. When
  // omitted, defaults to 'mkv' for back-compat with direct test callers; the
  // orchestrator always passes the resolved container at the dispatch
  // boundary.
  outputContainer?: OutputContainer;
  // Drop incompatible subtitle streams pre-mux. Honored
  // ONLY when outputContainer === 'mp4' (defensive — combination is
  // nonsensical for MKV which accepts virtually all subtitle codecs).
  dropIncompatibleSubtitles?: boolean;
  // Metadata payload for the dropped-subs pino warn — the
  // orchestrator computes these via `analyzeStreams` at dispatch and passes
  // them through so the warn carries forensic context (jobId + droppedCount
  // + codec list).
  jobId?: number | string;
  droppedSubtitleCount?: number;
  droppedSubtitleCodecs?: ReadonlyArray<string>;
  // Metadata payload for the `incompatible_streams_dropped`
  // pino warn (MKV only). The orchestrator computes these via
  // `analyzeIncompatibleStreams` at the MKV dispatch boundary and threads them
  // through so the warn carries forensic context (jobId + droppedCount +
  // codec_type:codec_name descriptors). Observability ONLY — the MKV `-map`
  // whitelist is unconditional, so the mapping is correct even when these are
  // absent (undefined → no warn).
  droppedIncompatibleStreamCount?: number;
  droppedIncompatibleStreamDescriptors?: ReadonlyArray<string>;
  // Embedded cover art. `attachedPicVideoOrdinals` lists the
  // VIDEO ORDINALS (position among video streams, NOT source indices) that carry
  // cover art and must be stream-copied; `encodedVideoOrdinals` is the exact
  // complement and narrows the video filter.
  //
  // THESE TWO FIELDS ARE SET TOGETHER OR NOT AT ALL. A set
  // `attachedPicVideoOrdinals` without `encodedVideoOrdinals` builds precisely
  // the breakage the narrowing exists to prevent: the bare `-vf` would still
  // match the copied cover stream and ffmpeg would refuse to open the output
  // ("Filtering and streamcopy cannot be used together"). Both undefined ⇒ argv
  // BYTE-IDENTICAL to the output without covers (the byte-identical regression gate).
  //
  // The coupling above is now CONTAINER-DEPENDENT. On MP4 it holds
  // verbatim (the cover is still copied, so the filter must still be narrowed).
  // On MKV the cover is UNMAPPED instead of copied, so no stream-copied video
  // stream remains and `encodedVideoOrdinals` is deliberately IGNORED there —
  // the specifiers go back to their bare form (measured). Passing it on
  // an MKV encode is harmless, not an error.
  attachedPicVideoOrdinals?: ReadonlyArray<number>;
  encodedVideoOrdinals?: ReadonlyArray<number>;
  // The successfully EXTRACTED covers, ready to be re-attached
  // as matroska AttachedFile elements. Honored ONLY together with
  // `attachedPicVideoOrdinals` on an MKV output — a cover that is attached
  // without being unmapped would end up in the file TWICE.
  //
  // undefined / empty ⇒ no `-attach` at all ⇒ the cover is simply dropped. That
  // is the deliberate fallback shared by three cases: extraction failed, the
  // kill-switch is set, and the codec was not attachable. There is NO path back
  // to the plain stream-copy form — it is measured broken, not a safe harbour.
  coverAttachments?: ReadonlyArray<CoverAttachment>;
  // The number of ATTACHMENT-typed streams in the SOURCE — the
  // base index for `-metadata:s:t:<n>`. REQUIRED whenever coverAttachments are
  // passed: a wrong index is exit 234 with a 0-byte output, so a missing
  // value drops the covers rather than guessing 0. A value of 0 is valid.
  sourceAttachmentCount?: number;
  // Normalized `"W:H:X:Y"` auto-crop geometry. Threaded into
  // buildCodecBlock → per-encoder CPU-crop filter. When undefined, buildArgs
  // output is BYTE-IDENTICAL to the output without crop (byte-identical
  // regression gate). The orchestrator resolves the effective crop (override-wins → detect →
  // none + full-frame guard) and passes it ONLY on the production encode — the
  // bench path (vmaf.ts) never sets it, so VMAF stays apples-to-apples.
  crop?: string;
  // Per-stream audio targets from analyzeAudioStreams auto_transcode
  // outcome. When present replaces the unconditional `-c:a copy` with per-stream
  // specifiers. When undefined buildArgs output is BYTE-IDENTICAL to the plain
  // `-c:a copy` output. Channel-layout preserved via
  // absence of `-ac` arg (ffmpeg defaults to source layout).
  audioPerStreamTargets?: ReadonlyArray<AudioAutoTranscodeTarget>;
  // Force a 10-bit HEVC Main10 output regardless of source
  // depth. Threaded into buildCodecBlock → per-encoder 10-bit args. When
  // undefined/false, buildArgs output is BYTE-IDENTICAL to the 8-bit output for
  // all four encoders (regression gate). The orchestrator threads this ONLY on the
  // production encode; bench (vmaf.ts) never sets it → VMAF stays source-depth.
  force10bit?: boolean;
  // Source VUI color tags to preserve on the output. Emitted as
  // output-side `-colorspace/-color_primaries/-color_trc/-color_range` for each
  // non-null field (output VUI, NOT inside the per-encoder codec block — composes
  // with force10bit's pix_fmt/profile tokens). When undefined or all fields null,
  // buildArgs output is BYTE-IDENTICAL to the output without color tags. The
  // orchestrator threads this ONLY on the production encode when color_passthrough
  // is ON; bench (vmaf.ts) never sets it → bench stays source-color-follow.
  color?: SourceColor;
  // Source HDR10 static metadata (mastering-display + MaxCLL).
  // Threaded into buildCodecBlock → the libx265 `-x265-params master-display=…:
  // max-cll=…` merge. HW encoders ignore it (ride ffmpeg auto SEI passthrough —
  // byte-identical). When undefined or both fields null, buildArgs output is
  // BYTE-IDENTICAL to the output without HDR10 for all four encoders. Production-only:
  // the orchestrator threads it ONLY when color_passthrough is ON; bench (vmaf.ts)
  // never sets it → bench stays HDR10-free.
  hdr10?: SourceHdr10;
  // VAAPI hardware decode, resolved by the orchestrator from the
  // `vaapi_hw_decode` setting and the source codecs. Honored for encoder vaapi
  // only; undefined ⇒ argv BYTE-IDENTICAL to the argv without it. Production
  // only: bench, boot probe and test encode never set it.
  vaapiHwDecode?: VaapiHwDecodeArgvMode;
};

export type EncodeResult = {
  exitCode: number;
  durationMs: number;
  logTail: string;
};

// Same pattern as the ffprobe wrapper: byte caps prevent memory DoS.
const STDOUT_CAP_BYTES = 8 * 1024 * 1024; // 8 MiB
const STDERR_TAIL_BYTES = 16 * 1024; // 16 KiB sliding window
const SIGKILL_GRACE_MS = 5000;

function safeParseInt(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function safeParseFloat(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// AbortError compatible with Node's runtime checks.
class AbortError extends Error {
  override name = 'AbortError';
  // stderr tail up to the abort. A stopped stalled encode is recorded as a
  // failure, and its log_tail should show what ffmpeg printed last.
  logTail?: string;
  constructor(message = 'aborted', logTail?: string) {
    super(message);
    this.logTail = logTail;
  }
}

// `-tag:v hvc1` (mp4 muxer args) is the THIRD global video-stream
// specifier — after `-c:v` and `-vf` — and it breaks on a copied cover for the
// same reason. The output-container.ts module header predicted exactly this: the static `hvc1`
// fourcc "is correct ONLY because buildArgs always encodes an HEVC video stream".
// With a stream-copied mjpeg cover that precondition no longer holds, and the mp4
// muxer refuses to write the header at all:
//   [mp4 @ …] Tag hvc1 incompatible with output codec id '7' (mp4v)
//   Could not write header (incorrect codec parameters ?)
// So the tag is narrowed to the ENCODED ordinals, exactly like the video filter.
// The narrowing happens HERE rather than in output-container.ts so the container
// module stays ordinal-agnostic (it knows nothing about source streams).
// undefined / empty ordinals ⇒ the token list is returned UNCHANGED ⇒ argv
// byte-identical to the output without covers, including for mkv (which has no
// video tag).
function narrowVideoTagSpecifier(args: string[], ordinals?: ReadonlyArray<number>): string[] {
  if (!ordinals || ordinals.length === 0) return args;
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-tag:v' && i + 1 < args.length) {
      const value = args[i + 1];
      for (const n of ordinals) out.push(`-tag:v:${n}`, value);
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

// Exported so Pass-2 orchestrator can assert
// byte-identical args between bench-verify and production-encode codepaths.
export function buildArgs(opts: EncodeOptions): string[] {
  // Codec block dispatched via profiles.ts buildCodecBlock.
  // CodecBlockInput threads `preset` for ALL 4
  // encoders (libx265 / nvenc / qsv / vaapi) via a single uniform call site.
  // When opts.preset is omitted, DEFAULT_PRESET_BY_ENCODER fallback preserves
  // the original byte-identical args. Invalid preset → defensive fallback inside
  // PROFILE_BUILDERS (resolvePreset). Default encoder='libx265' preserves the
  // byte-identical regression gate.
  const encoder = opts.encoder ?? 'libx265';

  // The container is resolved FIRST because the cover-art handling
  // FORKS on it. MKV and MP4 need opposite treatments:
  //
  //   MP4 — the mp4 muxer PRESERVES `attached_pic`, so the cover stream-copy
  //         produces a correct file. Nothing to fix, nothing changes here.
  //   MKV — the matroska muxer does NOT write the disposition back, so the
  //         copied cover lands as a SECOND REAL VIDEO TRACK (a 600x900 mjpeg
  //         claiming 90000 fps; VLC crashes, mpv stays black with sound). The
  //         cover is therefore taken OUT of the video mapping (`-map -0:v:N`)
  //         and re-attached as a genuine AttachedFile (measured).
  const container: OutputContainer = opts.outputContainer ?? 'mkv';
  const coverVideoOrdinals: ReadonlyArray<number> = opts.attachedPicVideoOrdinals ?? [];
  const isMkvCoverBranch = container === 'mkv' && coverVideoOrdinals.length > 0;

  // Measured: in the MKV cover branch the ORDINAL NARROWING IS
  // GONE — bare `-vf` / `-force_key_frames` / `-tag:v`, exactly as without covers.
  //
  // This is not a simplification, it is the CORRECT form. `encodedVideoOrdinals`
  // are SOURCE-side ordinals, and once `-map -0:v:N` removes a stream the OUTPUT
  // ordinals shift. A cover at ordinal 0 (the mp4-source case)
  // would leave `-filter:v:1` pointing at a stream that no longer exists, and
  // crop plus keyframe policy would fall away SILENTLY. The narrowing existed
  // only because a stream-COPIED cover sat in the video set ("Filtering and
  // streamcopy cannot be used together"); with the cover unmapped there is no
  // copied video stream left, and a measured run did exactly that: bare `-vf crop`,
  // exit 0, output video cropped, cover untouched at its own geometry.
  //
  // The MP4 branch keeps `opts.encodedVideoOrdinals` verbatim — there the cover
  // IS still copied, so there the narrowing is still mandatory.
  const videoFilterOrdinals = isMkvCoverBranch ? undefined : opts.encodedVideoOrdinals;

  // qsv encodes resolve the detection-validated ratecontrol variant
  // from the global cache. This makes buildArgs cache-dependent (no longer a pure
  // fn of opts) — a DOCUMENTED behavior change. The global-read seam (vs threading
  // through EncodeOptions) keeps the change small, and bench-
  // verify (vmaf.ts encodeForBench) reads the SAME accessor so prod↔bench argv stay
  // consistent by construction. Non-qsv encoders are unaffected
  // (undefined variant → byte-identical args).
  // A crop forces the download form even if zero-copy was requested: GPU frames
  // would never reach the CPU crop filter.
  const hwDecode: VaapiHwDecodeArgvMode | undefined =
    encoder === 'vaapi' && opts.vaapiHwDecode
      ? opts.crop
        ? 'download'
        : opts.vaapiHwDecode
      : undefined;

  let qsvRateControl: QsvRateControl | undefined;
  if (encoder === 'qsv') {
    qsvRateControl = getActiveQsvRateControl();
    if (!isQsvRateControlValidated()) warnQsvRateControlDefaultedOnce();
  }
  const codecBlock = buildCodecBlock({
    encoder,
    crf: opts.crf,
    preset: opts.preset ?? DEFAULT_PRESET_BY_ENCODER[encoder],
    devicePath: opts.vaapiDevice,
    qsvRateControl,
    // undefined → byte-identical to the output without crop for all four encoders.
    crop: opts.crop,
    // undefined/false → byte-identical to the 8-bit output for all four encoders.
    tenBit: opts.force10bit,
    // HDR10 static metadata → libx265 -x265-params merge (HW ignores it).
    // undefined/both-null → byte-identical without HDR10 for all four encoders.
    hdr10: opts.hdr10,
    // Narrow the video filter to the ENCODED ordinals whenever a cover
    // stream is present. undefined/empty → bare `-vf` → byte-identical.
    // In the MKV cover branch this resolves to undefined ON PURPOSE — the
    // cover is unmapped there, so no stream-copied video stream remains.
    videoFilterOrdinals,
    // The closed-GOP (IDR) pin. Resolved HERE, from the env lever, so it
    // reaches the production path ONLY — bench Pass-1 (vmaf.ts encodeForBench)
    // never sets it. ENCODE_CLOSED_GOP_DISABLED=1 ⇒ false ⇒ no IDR token at all.
    //
    // AND the detection verdict. Two INDEPENDENT gates — the
    // operator lever and the runtime's own answer — because the token first
    // shipped unprobed, so a runtime that rejects it would kill 100 % of real jobs
    // while /diagnostics stayed green. A host whose confirm spawn proved the
    // rejection now degrades ITSELF to open GOPs instead.
    //
    // WHY THE CACHE READ IS SAFE HERE: the orchestrator AWAITS
    // detectEncoders() before dispatch, so the verdict is resolved by the time a
    // real encode is built; and a cold cache falls OPEN to `true`, i.e. to
    // the exact v2.46.0 argv. This is the SAME global-read seam as for
    // qsvRateControl — and it lives HERE, never inside profiles.ts, because
    // encodeForBench calls buildCodecBlock directly.
    forceIdr: closedGopEnabled() && isForcedIdrSupported(encoder),
    hwDecode,
  });

  // The forced-keyframe interval. ENCODE_KEYFRAME_INTERVAL_SEC=0 ⇒ empty
  // array ⇒ no token at all. Narrowed to the ENCODED ordinals when a cover is
  // present (class rule — see forceKeyFrameArgs).
  const keyframeArgs = forceKeyFrameArgs(keyframeIntervalSec(), videoFilterOrdinals);

  // Per-cover `-c:v:N copy`. Embedded cover art demuxes as a VIDEO stream,
  // so `-map 0:v` picks it up and the global `-c:v <enc>` would push a 600x900
  // yuvj444p mjpeg through the HEVC encoder — QSV/NVENC/VAAPI refuse it and the
  // whole job dies ("Could not open encoder before EOF → Conversion failed!").
  //
  // MP4 ONLY. In the MKV branch the cover is removed from the mapping and
  // re-attached instead — a copy there produces the two-video-track output that
  // breaks players (measured), so the copy form is not a fallback, it is the defect.
  const attachedPicArgs: string[] = isMkvCoverBranch
    ? []
    : coverVideoOrdinals.flatMap((n) => [`-c:v:${n}`, 'copy']);

  // Output-side VUI color flags. Emit `-colorspace/-color_primaries/
  // -color_trc/-color_range` ONLY for each non-null source field. opts.color
  // undefined OR all fields null ⇒ empty array ⇒ byte-identical without color
  // flags. Per-field independence: a partially-specified source emits flags
  // ONLY for its known fields. Values pass through VERBATIM
  // from ffprobe — safe because the same ffmpeg binary probes and encodes
  // (same libavutil enum tables), so no allowlist/translation is needed.
  const colorArgs: string[] = [];
  const color = opts.color;
  if (color) {
    if (color.space !== null) colorArgs.push('-colorspace', color.space);
    if (color.primaries !== null) colorArgs.push('-color_primaries', color.primaries);
    if (color.transfer !== null) colorArgs.push('-color_trc', color.transfer);
    if (color.range !== null) colorArgs.push('-color_range', color.range);
  }
  // Tag args inserted AFTER `-map_metadata 0` so our keys
  // override input metadata (last-write-wins). Empty array when undefined —
  // byte-identical without tags.
  const metaArgs: string[] = (opts.metadata ?? []).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);

  // Output container — selects muxer args. MKV → no extra
  // muxer flags (the formerly unconditional `-movflags +faststart` was
  // an MP4-specific flag that MKV silently ignores; its removal from the
  // MKV path is intentional). MP4 → `-movflags +faststart`
  // for streaming-friendly faststart-positioned moov atom.
  const muxerArgs: string[] = narrowVideoTagSpecifier(
    [...muxerArgsFor(container)],
    videoFilterOrdinals,
  );

  // Drop incompatible subtitle streams pre-mux. Honored
  // ONLY for MP4 — the combination is nonsensical for MKV. When triggered,
  // appends `-sn` AFTER the input args (canonical position for stream-disable
  // flags in the ffmpeg argv ordering) and emits a single pino warn for the
  // job's audit-trail. The audit-trail event also satisfies the SOC-2
  // reconstruction requirement (pino-only audit-trail; no SQL audit_log table
  // for v1.0).
  const wantsDropSubs = opts.dropIncompatibleSubtitles === true && container === 'mp4';
  const subtitleDisableArgs: string[] = wantsDropSubs ? ['-sn'] : [];
  // When subtitles are disabled, also drop `-c:s copy` from the codec block —
  // ffmpeg warns when both `-sn` and an explicit subtitle codec are present.
  const includeSubtitleCodecCopy = !wantsDropSubs;

  if (wantsDropSubs) {
    logger.warn(
      {
        action: 'subtitle_streams_dropped_for_mp4',
        jobId: opts.jobId,
        droppedCount: opts.droppedSubtitleCount,
        codecs: opts.droppedSubtitleCodecs ? [...opts.droppedSubtitleCodecs] : undefined,
        container: 'mp4',
      },
      'subtitle streams dropped for mp4 mux compatibility',
    );
  }

  // Container-aware `-map`. Matroska rejects DATA/unknown streams (iPhone
  // `mebx` timed-metadata, mov `tmcd` timecode) → a blanket `-map 0` aborts the
  // mux header (`Only audio, video, and subtitles are supported for Matroska`,
  // exit 234). For MKV, map a declarative whitelist of the matroska-compatible
  // types: video (REQUIRED, no `?` — a zero-video source hard-fails by
  // design; scan only enqueues video-bearing files), audio/subtitle/attachment
  // optional (`?` so audio-less / sub-less / attachment-less sources don't
  // error). `-map 0:t?` preserves font AttachedFile elements — anime ASS fonts
  // survive the re-encode. MP4 keeps the bare `-map 0` (MP4 holds timed
  // metadata).
  //
  // In the MKV cover branch each cover ordinal is EXCLUDED again right
  // after the `-map 0:v` include — `-map -0:v:N`. Order matters: ffmpeg applies
  // the map options left to right, so the negative selector must follow the
  // positive one. The covers come back at the end of the argv as `-attach`.
  // Covers beyond COVER_ATTACH_MAX are excluded here too and simply never
  // re-attached (they are dropped, not smuggled back into the video set).
  const coverExclusionArgs: string[] = isMkvCoverBranch
    ? coverVideoOrdinals.flatMap((n) => ['-map', `-0:v:${n}`])
    : [];
  const mapArgs: string[] =
    container === 'mkv'
      ? ['-map', '0:v', ...coverExclusionArgs, '-map', '0:a?', '-map', '0:s?', '-map', '0:t?']
      : ['-map', '0'];

  // Emit ONE `incompatible_streams_dropped` warn when the MKV dispatch
  // probe found data/unknown streams (count-gated; observability only — the
  // whitelist above maps correctly regardless). Mirrors the
  // `subtitle_streams_dropped_for_mp4` shape/placement.
  if (container === 'mkv' && (opts.droppedIncompatibleStreamCount ?? 0) > 0) {
    logger.warn(
      {
        action: 'incompatible_streams_dropped',
        jobId: opts.jobId,
        droppedCount: opts.droppedIncompatibleStreamCount,
        descriptors: opts.droppedIncompatibleStreamDescriptors
          ? [...opts.droppedIncompatibleStreamDescriptors]
          : undefined,
        container: 'mkv',
      },
      'incompatible (data/unknown) streams dropped for matroska mux compatibility',
    );
  }

  // Emit ONE `attached_pic_streams_copied` warn per job when cover art was
  // found. Count-gated — no cover ⇒ no warn ⇒ no noise in the regular case.
  // Shape/placement mirror `incompatible_streams_dropped`; logger.warn
  // rides the existing multistream fan-out into the ring-buffer and therefore
  // into the diagnostics copy-report — no new /api/diagnostics field needed.
  //
  // EXPECTED, NOT A REGRESSION: ffmpeg now writes one stderr line per cover —
  //   Multiple -c, -codec, -acodec, -vcodec, -scodec or -dcodec options
  //   specified for stream N, only the last option '-c:v:N copy' will be used.
  // That line is the runtime CONFIRMATION of the ordering invariant (ffmpeg
  // evaluates the LAST matching -c option), not an error. Do not "fix" it.
  if (attachedPicArgs.length > 0) {
    logger.warn(
      {
        action: 'attached_pic_streams_copied',
        jobId: opts.jobId,
        copiedCount: opts.attachedPicVideoOrdinals?.length,
        videoOrdinals: opts.attachedPicVideoOrdinals
          ? [...opts.attachedPicVideoOrdinals]
          : undefined,
        // This warn is MP4-ONLY. It says "copied", and
        // only the mp4 branch copies — leaving it on the mkv branch would
        // make the log claim a copy that did not happen.
        container: 'mp4',
      },
      'embedded cover-art streams stream-copied instead of encoded',
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The MKV attach block. THREE MEASURED CONSTRAINTS SIT ON THESE FOUR
  // LINES, and every one of them is a job-killer or a data-loss when violated:
  //
  //   1. an `-attach` whose `mimetype=` tag is MISSING ⇒ exit 234, 0-byte
  //         output ("Attachment stream N has no mimetype tag and it cannot be
  //         deduced from the codec id"). Hence a cover with an unknown codec is
  //         dropped upstream, never attached with a guessed mimetype.
  //   2. a WRONG `-metadata:s:t:<n>` index ⇒ the SAME exit 234. The index is
  //         therefore COMPUTED from the source attachment count, never assumed.
  //   3. the UNINDEXED form `-metadata:s:t` is worse than a wrong mimetype:
  //         it renames the source FONTS to the cover's filename and the demuxer
  //         turns them into phantom `attached_pic` video streams. NEVER emit the
  //         bare specifier.
  //
  // The base index is the number of ATTACHMENT-typed source streams: `-map 0:t?`
  // carries those over first, our `-attach` blocks land after them, in order. An
  // image cover does not count there — it demuxes as a video stream.
  // ───────────────────────────────────────────────────────────────────────────
  const coverAttachments = opts.coverAttachments ?? [];
  const attachArgs: string[] = [];
  if (isMkvCoverBranch) {
    const base = opts.sourceAttachmentCount;
    if (typeof base !== 'number' || !Number.isInteger(base) || base < 0) {
      // NO `?? 0`. A missing count is a WIRING BUG at one of the
      // two container seams, and defaulting it to 0 would convert that bug into
      // exit 234 on precisely the sources this block exists for — the ones with
      // fonts. So: attach nothing. The cover stays out of the mapping (the
      // `-map -0:v:N` above already ran), which is the same dropped-cover state a
      // failed extraction produces. A count of 0 is a VALID value and attaches
      // normally — the check is on the TYPE, never on truthiness.
      logger.warn(
        {
          action: 'cover_attach_skipped',
          reason: 'attachment_count_unknown',
          jobId: opts.jobId,
          coverCount: coverAttachments.length,
          videoOrdinals: [...coverVideoOrdinals],
        },
        'cover art: source attachment count unknown — cover dropped instead of attached at a guessed index',
      );
    } else {
      for (let i = 0; i < coverAttachments.length; i += 1) {
        const a = coverAttachments[i];
        attachArgs.push(
          '-attach',
          a.path,
          `-metadata:s:t:${base + i}`,
          `mimetype=${a.mimetype}`,
          `-metadata:s:t:${base + i}`,
          `filename=${a.filename}`,
        );
      }
      if (attachArgs.length > 0) {
        logger.warn(
          {
            action: 'attached_pic_streams_attached',
            jobId: opts.jobId,
            coverCount: coverAttachments.length,
            baseIndex: base,
            droppedOrdinals: [...coverVideoOrdinals],
            container: 'mkv',
          },
          'embedded cover art re-attached as a matroska AttachedFile',
        );
      }
    }
  }

  // Per-stream audio args. When audioPerStreamTargets present,
  // emit `-c:a:N aac -b:a:N {bitrate}` or `-c:a:N copy` per stream. No `-ac`
  // arg so ffmpeg preserves source channel-layout. When absent, fall
  // back to unconditional `-c:a copy`.
  const audioArgs: string[] = opts.audioPerStreamTargets
    ? opts.audioPerStreamTargets.flatMap((t) =>
        t.action === 'aac'
          ? [
              `-c:a:${t.sourceStreamIndex}`,
              'aac',
              `-b:a:${t.sourceStreamIndex}`,
              String(t.bitrate ?? 192000),
            ]
          : [`-c:a:${t.sourceStreamIndex}`, 'copy'],
      )
    : ['-c:a', 'copy'];

  return [
    '-hide_banner',
    '-nostats',
    '-y',
    // Input options, so they must stand before `-i`. Empty without hwDecode.
    ...vaapiDecodeInputArgs(hwDecode),
    '-i',
    opts.input,
    ...subtitleDisableArgs,
    ...codecBlock,
    // POSITION IS FUNCTIONAL, NOT COSMETIC. ffmpeg evaluates the LAST
    // matching `-c` option for a stream, so `-c:v:N copy` MUST follow the global
    // `-c:v <enc>` inside codecBlock. Moving it before the codec block — or
    // reordering the codec block so `-c:v` lands last — makes the fix silently
    // inert. Frozen as an assertion in tests/encode/ffmpeg.test.ts.
    ...attachedPicArgs,
    // POSITION IS DELIBERATE BUT NOT ORDER-CRITICAL — do not read it as
    // arbitrary either. `-force_key_frames` is NOT a `-c` token, so the
    // "ffmpeg evaluates the LAST matching -c option" invariant above does not
    // apply to it and it cannot invalidate the `-c:v:N copy` placement. It sits
    // right after the cover-copy block because both are per-video-ordinal output
    // options, keeping the video-stream options contiguous and ahead of the
    // colour / audio / mapping tail.
    ...keyframeArgs,
    ...colorArgs,
    ...audioArgs,
    ...(includeSubtitleCodecCopy ? ['-c:s', 'copy'] : []),
    ...mapArgs,
    '-map_metadata',
    '0',
    ...metaArgs,
    // POSITION IS THE MEASURED ONE — after `-map_metadata 0` and
    // the metadata tags, before the muxer args. Frozen as an assertion in
    // tests/encode/ffmpeg-cover-attach.test.ts.
    ...attachArgs,
    ...muxerArgs,
    '-progress',
    'pipe:1',
    // Throttle the -progress emission to one block / 30s (ffmpeg default
    // is 0.5s). A 5.5h 4K encode emitted ~40k blocks ≈ 8.4 MiB of progress
    // stream → tripped the 8 MiB STDOUT_CAP_BYTES → SIGKILL ("stdout exceeded
    // cap"). At 30s the same encode emits ~660 blocks ≈ 140 KiB — the cap is
    // never approached, while 30s UI-progress granularity is fine for an
    // hours-long batch transcode.
    '-stats_period',
    '30',
    opts.output,
  ];
}

// Parse `-progress pipe:1` key=value lines. ffmpeg emits a group of lines
// terminated by `progress=continue` or `progress=end`. We accumulate a buffer
// and emit on those terminator lines.
function makeProgressParser(onProgress: (ev: ProgressEvent) => void): (chunk: string) => void {
  let lineBuf = '';
  let kv: Record<string, string> = {};

  function flushEvent(progress: 'continue' | 'end'): void {
    const ev: ProgressEvent = {
      frame: safeParseInt(kv.frame),
      fps: safeParseFloat(kv.fps),
      outTimeMs:
        kv.out_time_ms !== undefined
          ? (() => {
              const us = safeParseInt(kv.out_time_ms);
              return us === null ? null : Math.floor(us / 1000);
            })()
          : null,
      totalSize: safeParseInt(kv.total_size),
      // Strip optional trailing 'x' then parse; "N/A"→null, absent→null.
      speed: kv.speed !== undefined ? safeParseFloat(kv.speed.replace(/x$/, '')) : null,
      progress,
    };
    onProgress(ev);
    kv = {};
  }

  return (chunk: string) => {
    lineBuf += chunk;
    let nlIdx;
    while ((nlIdx = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, nlIdx).trim();
      lineBuf = lineBuf.slice(nlIdx + 1);
      if (!line) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;
      const key = line.slice(0, eqIdx).trim();
      const value = line.slice(eqIdx + 1).trim();
      if (key === 'progress') {
        if (value === 'continue' || value === 'end') {
          flushEvent(value);
        }
        continue;
      }
      kv[key] = value;
    }
  };
}

export async function runEncode(opts: EncodeOptions): Promise<EncodeResult> {
  const startMs = Date.now();
  const args = buildArgs(opts);

  return new Promise<EncodeResult>((resolve, reject) => {
    // nvenc → jellyfin ffmpeg-nvenc (Pascal floor); else BtbN. undefined→libx265→BtbN.
    // Resolved ONCE and shared by the log line and the spawn.
    // ffmpegBinaryFor reads FFMPEG_NVENC_PATH PER CALL (not memoized), so
    // two calls could read two different values and the log would then claim a
    // binary other than the one that ran — which is the single reason the line
    // names the binary at all.
    const bin = ffmpegBinaryFor(opts.encoder);
    // The complete argv as the FIRST line of the job log. Until v2.46.0
    // the argv was logged NOWHERE, which is why the 17-frame report could not be
    // analysed at all. Job log ONLY — NOT via the logger, so it never enters
    // the ring buffer and therefore never the diagnostics copy-report, which is
    // meant for sharing and would otherwise carry absolute share paths and file
    // names. Emitted BEFORE the spawn so it is there even when the spawn
    // fails instantly. The line is deliberately NOT shell-quoted: it is
    // diagnostic output, not a copy-and-run command. try/catch mirrors the
    // existing stderr onLogChunk call — a log write must never abort an encode.
    try {
      opts.onLogChunk?.(`ffmpeg argv: ${bin} ${args.join(' ')}\n`);
    } catch {
      // never abort the encode over a log write
    }
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    reniceChild(child); // Lower OS priority so the encode never starves the Node web UI

    let stdoutBytes = 0;
    let stdoutCapped = false;
    let stderrTail = Buffer.alloc(0);
    let aborted = false;
    let sigkillTimer: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = (): void => {
      if (sigkillTimer) {
        clearTimeout(sigkillTimer);
        sigkillTimer = null;
      }
      if (opts.signal && abortListener) {
        try {
          opts.signal.removeEventListener('abort', abortListener);
        } catch {
          // ignore
        }
      }
    };

    const safeResolve = (v: EncodeResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(v);
    };
    const safeReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const parser = opts.onProgress ? makeProgressParser(opts.onProgress) : null;

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        // stdout is the machine-only `-progress pipe:1` stream — it is
        // parsed below for UI progress but DELIBERATELY NOT forwarded to the
        // job log. Previously it was, making the captured log ~99.88% progress
        // spam (40k blocks) that drowned the real stderr diagnostics and made
        // the "copy job log" surface useless. The job log now captures stderr
        // only (see the stderr handler's onLogChunk below).
        if (stdoutCapped) return;
        stdoutBytes += Buffer.byteLength(chunk, 'utf8');
        if (stdoutBytes > STDOUT_CAP_BYTES) {
          stdoutCapped = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // child may already be gone
          }
          return;
        }
        if (parser) parser(chunk);
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        // Forward to log-capture if provided.
        if (opts.onLogChunk) {
          try {
            opts.onLogChunk(chunk);
          } catch {
            // log-capture failure must not abort encoding
          }
        }
        // Sliding window: only keep tail.
        stderrTail = Buffer.concat([stderrTail, chunk]);
        if (stderrTail.length > STDERR_TAIL_BYTES) {
          stderrTail = stderrTail.subarray(stderrTail.length - STDERR_TAIL_BYTES);
        }
      });
    }

    child.on('error', (err: Error) => {
      logger.warn({ err: err.message, args }, 'ffmpeg: spawn failed');
      safeReject(err);
    });

    let abortListener: (() => void) | null = null;
    if (opts.signal) {
      if (opts.signal.aborted) {
        // Pre-aborted before spawn — mimic the abort path.
        aborted = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        sigkillTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, SIGKILL_GRACE_MS);
      } else {
        abortListener = (): void => {
          aborted = true;
          try {
            child.kill('SIGTERM');
          } catch {
            // ignore
          }
          sigkillTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
          }, SIGKILL_GRACE_MS);
        };
        opts.signal.addEventListener('abort', abortListener);
      }
    }

    // Only resolve on `close`,
    // even after kill. Prevents zombie accumulation.
    child.once('close', (code: number | null) => {
      const durationMs = Date.now() - startMs;
      const logTail = stderrTail.toString('utf8');

      if (stdoutCapped) {
        safeReject(new Error('stdout exceeded cap'));
        return;
      }
      if (aborted) {
        safeReject(new AbortError('encode aborted', logTail));
        return;
      }
      safeResolve({ exitCode: code ?? -1, durationMs, logTail });
    });
  });
}
