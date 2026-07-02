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
// 30-01: real qsv encodes resolve the detection-validated ratecontrol variant.
// detection.ts does NOT import ffmpeg.ts, so this edge is acyclic.
import { getActiveQsvRateControl, isQsvRateControlValidated } from './detection';
import { muxerArgsFor, type OutputContainer } from './output-container';
import type { AudioAutoTranscodeTarget } from './audio-compat';
import type { SourceColor, SourceHdr10 } from '../scan/ffprobe';

// 30-01 (SR-2): process-once guard so a cold-cache qsv encode logs the
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

// 30-01 test-only reset of the once-flag (never barrel-exported).
export function __forTests_resetQsvDefaultedWarn(): void {
  qsvDefaultedWarned = false;
}

// 02-02 §2 — ProgressEvent shape per CONTEXT.md.
export type ProgressEvent = {
  frame: number | null;
  fps: number | null;
  outTimeMs: number | null;
  totalSize: number | null;
  // 43-02: ffmpeg's native speed multiplier (e.g. "1.23x"→1.23, "N/A"→null,
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
  // 03-01 audit M1 (additive): encoder + VAAPI device path. When `encoder` is
  // undefined the dispatch defaults to 'libx265' and the produced args are
  // BYTE-IDENTICAL to the pre-03-01 buildArgs output (Phase 2 regression
  // gate enforced by tests/encode/ffmpeg.test.ts byte-identical assertion).
  encoder?: EncoderId;
  vaapiDevice?: string;
  // 04-01 (additive): optional MKV global tags appended after `-map_metadata 0`
  // (last-write-wins overrides input metadata for keys we explicitly set).
  // When undefined, buildArgs output is BYTE-IDENTICAL to pre-04-01 — preserves
  // Phase 2 regression gate (tests/encode/ffmpeg.test.ts byte-identical args).
  metadata?: ReadonlyArray<readonly [string, string]>;
  onProgress?: (ev: ProgressEvent) => void;
  signal?: AbortSignal;
  // 05-03 (additive): optional per-job log capture. When provided, every
  // stdout+stderr chunk is written to this stream (alongside the existing
  // byte-cap + tail logic). When undefined, ffmpeg.ts emits BYTE-IDENTICAL
  // behavior to pre-05-03 — preserves Phase 2 regression gate.
  onLogChunk?: (chunk: Buffer | string) => void;
  // 05-14 (additive): output container — controls muxer-args plumbing. When
  // omitted, defaults to 'mkv' for back-compat with direct test callers; the
  // orchestrator always passes the resolved container at the dispatch
  // boundary (per AC-6).
  outputContainer?: OutputContainer;
  // 05-14 (additive): drop incompatible subtitle streams pre-mux. Honored
  // ONLY when outputContainer === 'mp4' (defensive — combination is
  // nonsensical for MKV which accepts virtually all subtitle codecs).
  dropIncompatibleSubtitles?: boolean;
  // 05-14 (additive): metadata payload for the dropped-subs pino warn — the
  // orchestrator computes these via `analyzeStreams` at dispatch and passes
  // them through so the warn carries forensic context (jobId + droppedCount
  // + codec list).
  jobId?: number | string;
  droppedSubtitleCount?: number;
  droppedSubtitleCodecs?: ReadonlyArray<string>;
  // 41-01 (additive): metadata payload for the `incompatible_streams_dropped`
  // pino warn (MKV only). The orchestrator computes these via
  // `analyzeIncompatibleStreams` at the MKV dispatch boundary and threads them
  // through so the warn carries forensic context (jobId + droppedCount +
  // codec_type:codec_name descriptors). Observability ONLY — the MKV `-map`
  // whitelist is unconditional, so the mapping is correct even when these are
  // absent (undefined → no warn → byte-identical to pre-41 on the warn path).
  droppedIncompatibleStreamCount?: number;
  droppedIncompatibleStreamDescriptors?: ReadonlyArray<string>;
  // 35-01 (additive): normalized `"W:H:X:Y"` auto-crop geometry. Threaded into
  // buildCodecBlock → per-encoder CPU-crop filter (D3). When undefined, buildArgs
  // output is BYTE-IDENTICAL to pre-35 (preserves the Phase-2 regression gate /
  // AC-1). The orchestrator resolves the effective crop (override-wins → detect →
  // none + full-frame guard) and passes it ONLY on the production encode — the
  // bench path (vmaf.ts) never sets it, so VMAF stays apples-to-apples (AC-6).
  crop?: string;
  // 10-02 E-D3: per-stream audio targets from analyzeAudioStreams auto_transcode
  // outcome. When present replaces the unconditional `-c:a copy` with per-stream
  // specifiers. When undefined buildArgs output is BYTE-IDENTICAL to pre-10-02
  // (preserves Phase-2 regression gate). SR2: channel-layout preserved via
  // absence of `-ac` arg (ffmpeg defaults to source layout).
  audioPerStreamTargets?: ReadonlyArray<AudioAutoTranscodeTarget>;
  // 43-01 (additive): force a 10-bit HEVC Main10 output regardless of source
  // depth. Threaded into buildCodecBlock → per-encoder 10-bit args. When
  // undefined/false, buildArgs output is BYTE-IDENTICAL to pre-43 for all four
  // encoders (AC-1 regression gate). The orchestrator threads this ONLY on the
  // production encode; bench (vmaf.ts) never sets it → VMAF stays source-depth
  // (AC-8).
  force10bit?: boolean;
  // 43-03 (additive): source VUI color tags to preserve on the output. Emitted as
  // output-side `-colorspace/-color_primaries/-color_trc/-color_range` for each
  // non-null field (output VUI, NOT inside the per-encoder codec block — composes
  // with force10bit's pix_fmt/profile tokens). When undefined or all fields null,
  // buildArgs output is BYTE-IDENTICAL to pre-43-03 (AC-1/AC-3). The orchestrator
  // threads this ONLY on the production encode when color_passthrough is ON; bench
  // (vmaf.ts) never sets it → bench stays source-color-follow (AC-8).
  color?: SourceColor;
  // 43-04 (additive): source HDR10 static metadata (mastering-display + MaxCLL).
  // Threaded into buildCodecBlock → the libx265 `-x265-params master-display=…:
  // max-cll=…` merge. HW encoders ignore it (ride ffmpeg auto SEI passthrough —
  // AC-6 byte-identical). When undefined or both fields null, buildArgs output is
  // BYTE-IDENTICAL to pre-43-04 for all four encoders (AC-1). Production-only: the
  // orchestrator threads it ONLY when color_passthrough is ON; bench (vmaf.ts)
  // never sets it → bench stays HDR10-free (AC-8).
  hdr10?: SourceHdr10;
};

export type EncodeResult = {
  exitCode: number;
  durationMs: number;
  logTail: string;
};

// audit pattern from 01-03 ffprobe S2: byte caps prevent memory DoS.
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
  constructor(message = 'aborted') {
    super(message);
  }
}

// 11-03 audit-added SR3: exported so Pass-2 orchestrator can assert
// byte-identical args between bench-verify and production-encode codepaths.
export function buildArgs(opts: EncodeOptions): string[] {
  // 03-01 audit M1: codec block dispatched via profiles.ts buildCodecBlock.
  // 12-03 audit M3: extended CodecBlockInput threads `preset` for ALL 4
  // encoders (libx265 / nvenc / qsv / vaapi) via a single uniform call site.
  // When opts.preset is omitted, DEFAULT_PRESET_BY_ENCODER fallback preserves
  // pre-12-03 byte-identical args. Invalid preset → defensive fallback inside
  // PROFILE_BUILDERS (resolvePreset). Default encoder='libx265' preserves
  // Phase-2 regression gate.
  const encoder = opts.encoder ?? 'libx265';
  // 30-01 (SR-1): qsv encodes resolve the detection-validated ratecontrol variant
  // from the global cache. This makes buildArgs cache-dependent (no longer a pure
  // fn of opts) — a DOCUMENTED behavior change. The global-read seam (vs threading
  // through EncodeOptions) keeps the change inside the 5 plan files, and bench-
  // verify (vmaf.ts encodeForBench) reads the SAME accessor so prod↔bench argv stay
  // consistent by construction (11-03 SR3). Non-qsv encoders are unaffected
  // (undefined variant → byte-identical to pre-30-01).
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
    // 35-01: undefined → byte-identical to pre-35 for all four encoders.
    crop: opts.crop,
    // 43-01: undefined/false → byte-identical to pre-43 for all four encoders.
    tenBit: opts.force10bit,
    // 43-04: HDR10 static metadata → libx265 -x265-params merge (HW ignores it).
    // undefined/both-null → byte-identical to pre-43-04 for all four encoders.
    hdr10: opts.hdr10,
  });

  // 43-03: output-side VUI color flags. Emit `-colorspace/-color_primaries/
  // -color_trc/-color_range` ONLY for each non-null source field. opts.color
  // undefined OR all fields null ⇒ empty array ⇒ byte-identical to pre-43-03
  // (AC-1/AC-3). Per-field independence: a partially-specified source emits flags
  // ONLY for its known fields (AC-3 partial cell). Values pass through VERBATIM
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
  // 04-01 (additive): tag args inserted AFTER `-map_metadata 0` so our keys
  // override input metadata (last-write-wins). Empty array when undefined —
  // byte-identical to pre-04-01.
  const metaArgs: string[] = (opts.metadata ?? []).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);

  // 05-14 (additive): output container — selects muxer args. MKV → no extra
  // muxer flags (the unconditional `-movflags +faststart` from pre-05-14 was
  // an MP4-specific flag that MKV silently ignores; its removal from the
  // MKV path is intentional per AC-1 + AC-2). MP4 → `-movflags +faststart`
  // for streaming-friendly faststart-positioned moov atom.
  const container: OutputContainer = opts.outputContainer ?? 'mkv';
  const muxerArgs: string[] = [...muxerArgsFor(container)];

  // 05-14 (additive): drop incompatible subtitle streams pre-mux. Honored
  // ONLY for MP4 — the combination is nonsensical for MKV. When triggered,
  // appends `-sn` AFTER the input args (canonical position for stream-disable
  // flags in the ffmpeg argv ordering) and emits a single pino warn for the
  // job's audit-trail. The audit-trail event also satisfies the SOC-2
  // reconstruction requirement per the APPLY-time spec-patch (pino-only
  // audit-trail; no SQL audit_log table for v1.0).
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

  // 41-01: container-aware `-map`. Matroska rejects DATA/unknown streams (iPhone
  // `mebx` timed-metadata, mov `tmcd` timecode) → a blanket `-map 0` aborts the
  // mux header (`Only audio, video, and subtitles are supported for Matroska`,
  // exit 234). For MKV, map a declarative whitelist of the matroska-compatible
  // types: video (REQUIRED, no `?` per D1.2 — a zero-video source hard-fails by
  // design; scan only enqueues video-bearing files), audio/subtitle/attachment
  // optional (`?` so audio-less / sub-less / attachment-less sources don't
  // error). `-map 0:t?` preserves font AttachedFile elements — anime ASS fonts
  // survive the re-encode (MH-1). MP4 keeps the bare `-map 0` (MP4 holds timed
  // metadata; D3 — byte-identical to pre-41).
  const mapArgs: string[] =
    container === 'mkv'
      ? ['-map', '0:v', '-map', '0:a?', '-map', '0:s?', '-map', '0:t?']
      : ['-map', '0'];

  // 41-01: emit ONE `incompatible_streams_dropped` warn when the MKV dispatch
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

  // 10-02 E-D3: per-stream audio args. When audioPerStreamTargets present,
  // emit `-c:a:N aac -b:a:N {bitrate}` or `-c:a:N copy` per stream. No `-ac`
  // arg so ffmpeg preserves source channel-layout (SR2). When absent, fall
  // back to unconditional `-c:a copy` (byte-identical to pre-10-02).
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
    '-i',
    opts.input,
    ...subtitleDisableArgs,
    ...codecBlock,
    ...colorArgs,
    ...audioArgs,
    ...(includeSubtitleCodecCopy ? ['-c:s', 'copy'] : []),
    ...mapArgs,
    '-map_metadata',
    '0',
    ...metaArgs,
    ...muxerArgs,
    '-progress',
    'pipe:1',
    // 41-02: throttle the -progress emission to one block / 30s (ffmpeg default
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
      // 43-02: strip optional trailing 'x' then parse; "N/A"→null, absent→null.
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
    // 45-01: nvenc → jellyfin ffmpeg-nvenc (Pascal floor); else BtbN. undefined→libx265→BtbN.
    const child = spawn(ffmpegBinaryFor(opts.encoder), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    reniceChild(child); // 38-01: lower OS priority so the encode never starves the Node web UI

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
        // 41-02: stdout is the machine-only `-progress pipe:1` stream — it is
        // parsed below for UI progress but DELIBERATELY NOT forwarded to the
        // job log. Pre-41-02 it was, making the captured log ~99.88% progress
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
        // 05-03 (additive): forward to log-capture if provided.
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

    // Audit M2 from 01-03 (carried into 02-02): only resolve on `close`,
    // even after kill. Prevents zombie accumulation.
    child.once('close', (code: number | null) => {
      const durationMs = Date.now() - startMs;
      const logTail = stderrTail.toString('utf8');

      if (stdoutCapped) {
        safeReject(new Error('stdout exceeded cap'));
        return;
      }
      if (aborted) {
        safeReject(new AbortError('encode aborted'));
        return;
      }
      safeResolve({ exitCode: code ?? -1, durationMs, logTail });
    });
  });
}
