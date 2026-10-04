// Phase 21 Plan 21-01 — synthetic test-encode runner with hard-mutex.
//
// V2 hard-mutex prevents concurrent test-encode (one slot per process).
// HMR-safe globalThis-singleton mirrors 02-03 / 05-01 / ring-buffer patterns.
//
// Spawn safety (AC-10):
//   - child_process.spawn with arg array — NO shell interpolation
//   - AbortController 10s timeout → SIGKILL on hang
//   - stdout/stderr byte-capped at 4 KB each (FIFO truncate)
//   - pipes closed deterministically before resolve

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
  buildCodecBlock,
  DEFAULT_CRF_BY_ENCODER,
  DEFAULT_PRESET_BY_ENCODER,
  PROBE_FRAME_SIZE,
  SYNTHETIC_PROBE_PIX_FMT,
  usesSyntheticPixFmtPin,
  detectEncoders,
  // 49-03 (D7/AC-13): the forced-IDR verdict, so runTestEncode resolves the SAME
  // value buildArgs resolves. Fail-OPEN when nothing was proven.
  isForcedIdrSupported,
  type EncoderId,
  type QsvRateControl,
} from '@/src/lib/encode';
// 49-03: the operator lever half of the same resolution. keyframe.ts is a leaf.
// 50-06: forceKeyFrameArgs + keyframeIntervalSec come from the SAME leaf the
// production path uses, so the test encode emits the identical token.
import {
  closedGopEnabled,
  forceKeyFrameArgs,
  keyframeIntervalSec,
} from '@/src/lib/encode/keyframe';
// 50-06: the shared settings resolvers — the production dispatch calls these very
// functions (orchestrator.ts resolveEncoderFor / resolveEncodeParams).
import {
  resolveCrfForEncoder,
  resolveForce10bit,
  resolvePresetForEncoder,
  resolveRequestedEncoder,
} from '@/src/lib/encode/encode-settings-resolve';
import { ffmpegBinaryFor } from '@/src/lib/encode/ffmpeg-binary';
import { settingRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import type { TestEncodeOutcome } from './types';
import { mapTestEncodeError } from './test-encode-error-map';

const STDIO_CAP_BYTES = 4 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

interface MutexState {
  held: boolean;
}

declare global {
  var __x265butler_test_encode_mutex: MutexState | undefined;
}

function getMutex(): MutexState {
  if (!globalThis.__x265butler_test_encode_mutex) {
    globalThis.__x265butler_test_encode_mutex = { held: false };
  }
  return globalThis.__x265butler_test_encode_mutex;
}

export function tryAcquireMutex(): boolean {
  const m = getMutex();
  if (m.held) return false;
  m.held = true;
  return true;
}

export function releaseMutex(): void {
  getMutex().held = false;
}

export function _resetMutexForTesting(): void {
  if (process.env.NODE_ENV === 'production' && process.env.VITEST !== 'true') return;
  getMutex().held = false;
}

export function mapEncoderIdToFfmpegCodec(id: EncoderId): string {
  switch (id) {
    case 'nvenc':
      return 'hevc_nvenc';
    case 'qsv':
      return 'hevc_qsv';
    case 'vaapi':
      return 'hevc_vaapi';
    case 'libx265':
      return 'libx265';
  }
}

// 24-02 F4: pure, exported, unit-testable arg-builder mirroring the 23-04
// buildProbeEncodeArgs pattern. Reuses buildCodecBlock (the shared codec-block
// source-of-truth) so the VAAPI `-vaapi_device <dev>` + `-vf format=nv12,hwupload`
// init chain — and any future per-encoder init flag — flows in automatically.
// The original 21-01 hand-built argv emitted only `-c:v hevc_vaapi`, causing a
// false ffmpeg `-38` on perfectly-good VAAPI hardware.
//
// The test envelope (testsrc 320x240 per the 21-02 NVENC-minimum boundary-deviation,
// 5s, `-t 5`, `-f null /dev/null`) is preserved.
// devicePath is threaded to buildCodecBlock so the operator test-encode probes
// the SAME discovered /dev/dri/renderD* node as the boot-probe + production
// encode (a no-op for nvenc/qsv/libx265 — only the vaapi block reads it).
// 30-01 (SR-3): qsvRateControl is THREADED in (NOT global-read) so this pure
// 24-02 builder keeps its deterministic unit test. runTestEncode passes the
// detection-validated det.qsvRateControl; undefined ⇒ buildCodecBlock's
// 'icq-full' default. No-op for nvenc/vaapi/libx265.
// 49-03 (G3, AC-6): pin `-pix_fmt nv12` for qsv/nvenc — same fix as the boot
// probe, same shared const. libx265/vaapi deliberately get no pin (profiles.ts).
// 49-03 (D7, AC-13): `forceIdr` is THREADED IN (not global-read) so this builder
// stays pure/deterministic per 30-01 SR-3.
//
// ─── 50-06 ────────────────────────────────────────────────────────────────────
// The builder now answers "does MY configuration run", not "does some
// configuration run". Everything it needs is still THREADED — the purity
// contract is unchanged, only the input widened, and the positional form gave
// way to an options object because five more positional parameters would be
// unreadable.
//
// (a) `,format=yuv420p` in the LAVFI GRAPH. `testsrc` emits rgb24 and, measured
//     locally against ffmpeg 6.1.1, libx265 then ENCODES `gbrp` — RGB planar
//     4:4:4 — while every real source is 4:2:0 YUV. The other three encoders were
//     already converting on their own (qsv/nvenc via the 49-03 `-pix_fmt` pin,
//     vaapi inside its own `format=nv12,hwupload` chain), so this pin changes the
//     ARGV for all four but the ENCODED FORMAT only for libx265. Stated plainly
//     because a future reader will otherwise assume it fixed more than it did.
//     It lives in the INPUT graph, so it cannot collide with the codec blocks'
//     own output-side `-vf` (measured: `-i "...,format=yuv420p" -vf crop=...`
//     exits 0).
// (b) The format stays 8-BIT even when tenBit is on. `force_10bit` means "encode
//     my 8-bit source as 10-bit", so an 8-bit input IS the faithful simulation;
//     the encoder-side pin does the conversion (measured: auto_scale
//     yuv420p -> yuv420p10le, exit 0).
// (c) `crf` / `preset` are now REQUIRED — no default hides in this builder. The
//     caller resolves them from the operator's settings; a builder-side default
//     is exactly how the hard-pinned `crf: 28` survived two phases unnoticed.
export const SYNTHETIC_INPUT_PIX_FMT = 'yuv420p';

export interface TestEncodeArgsInput {
  encoder: EncoderId;
  /** Resolved from `crf_<encoder>` — see encode-settings-resolve.ts. */
  crf: number;
  /** Resolved from `preset_<encoder>`, Catalog-guarded. */
  preset: string;
  devicePath?: string;
  qsvRateControl?: QsvRateControl;
  forceIdr?: boolean;
  /** `force_10bit`. The lavfi input stays 8-bit regardless — see (b) above. */
  tenBit?: boolean;
  /** Seconds; 0 (or omitted) emits NO `-force_key_frames` token at all. */
  keyframeIntervalSec?: number;
}

export function buildTestEncodeArgs(input: TestEncodeArgsInput): string[] {
  const { encoder, crf, preset, devicePath, qsvRateControl, forceIdr, tenBit } = input;
  return [
    '-hide_banner',
    '-loglevel',
    'info',
    '-y',
    '-f',
    'lavfi',
    '-i',
    // 21-02 UAT-finding: 128x72 < hevc_nvenc minimum frame dimensions (NVENC HEVC
    // requires >=144x144 on Maxwell+, >=256x256 on older GPUs per NVENC SDK docs).
    // Bumped to 320x240 — safely above all NVENC minimums, still no PII, multiple-of-2
    // width+height, classic test-pattern aspect-ratio. Boundary-deviation 21-02.
    // 29-01: the value now lives in the shared PROBE_FRAME_SIZE const (profiles.ts),
    // also consumed by the detection boot-probe so the two can never drift apart.
    // 50-06: + the 4:2:0 conversion — see (a) in the block above.
    `testsrc=size=${PROBE_FRAME_SIZE}:rate=1:duration=5,format=${SYNTHETIC_INPUT_PIX_FMT}`,
    ...buildCodecBlock({
      encoder,
      crf,
      preset,
      devicePath,
      qsvRateControl,
      pixFmt: usesSyntheticPixFmtPin(encoder) ? SYNTHETIC_PROBE_PIX_FMT : undefined,
      forceIdr,
      tenBit,
    }),
    // 50-06: same relative position as buildArgs — after the codec block, before
    // the envelope tail. No ordinals exist here (one synthetic video stream).
    ...forceKeyFrameArgs(input.keyframeIntervalSec ?? 0),
    '-t',
    '5',
    '-f',
    'null',
    '/dev/null',
  ];
}

export interface RunTestEncodeOptions {
  // 45-01: OPTIONAL test-override only. Production leaves it unset → the internal
  // selector picks by the RESOLVED encoder (nvenc → jellyfin ffmpeg-nvenc, else
  // BtbN) so the diagnostics test-encode agrees with the real encode on Pascal hosts.
  ffmpegPath?: string;
  timeoutMs?: number;
  // 50-06 DI seam (mirrors ffmpegPath). Production leaves it unset ⇒ the real
  // `settingRepo().getAll()`. The ROUTE MUST NEVER PASS IT — a production caller
  // handing in settings would be a bypass around the single read. It exists so a
  // unit test can drive the resolution without opening a SQLite file, and so the
  // fail-open path below is testable at all.
  settingsReader?: () => Record<string, string>;
}

export type TestEncodeAuditOutcome = 'success' | 'failed' | 'killed_timeout';

export interface RunTestEncodeResult {
  body: TestEncodeOutcome;
  auditOutcome: TestEncodeAuditOutcome;
}

/**
 * 50-06: read the operator's settings ONCE, FAIL-OPEN.
 *
 * Before 50-06 `runTestEncode` had NO database dependency at all. This plan adds
 * one — and this endpoint is, since 21-05, the evidence gate that unlocks the
 * bug-report button. A diagnostic that dies with the patient is worse than a
 * diagnostic that runs on defaults and says so, therefore a throwing read
 * degrades to the exact v2.46.4 behaviour and reports `settingsSource:
 * 'unavailable'` instead of failing the request.
 */
function readSettingsFailOpen(opts: RunTestEncodeOptions): {
  settingsAll: Record<string, string>;
  settingsSource: 'settings' | 'unavailable';
} {
  const reader = opts.settingsReader ?? (() => settingRepo().getAll());
  try {
    return { settingsAll: reader(), settingsSource: 'settings' };
  } catch (err) {
    // Exactly ONE warn — the run continues, so this must not become per-call noise.
    logger.warn(
      {
        action: 'test_encode_settings_unavailable',
        err: err instanceof Error ? err.message : String(err),
      },
      'test-encode: settings could not be read — running on factory defaults (the reported values are NOT the operator configuration)',
    );
    return { settingsAll: {}, settingsSource: 'unavailable' };
  }
}

export async function runTestEncode(opts: RunTestEncodeOptions): Promise<RunTestEncodeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const det = await detectEncoders();

  const { settingsAll, settingsSource } = readSettingsFailOpen(opts);

  // 50-06 (AC-10/11/12): resolve the encoder the OPERATOR configured, not simply
  // `det.activeFromAuto`. Until v2.46.x this function ignored `settings.encoder`
  // entirely, so an operator who pinned vaapi while auto-detection preferred qsv
  // was told "hevc_qsv" about a host that never runs qsv.
  //
  // The PIN half of production's `resolveEncoderFor` is mirrored; the CAPACITY
  // WALK is deliberately NOT — concurrency is a runtime condition, not a
  // configuration, and a diagnostic occupies no encode slot.
  const encoderRequested = settingsSource === 'settings' ? (settingsAll.encoder ?? 'auto') : 'auto';
  const requested = resolveRequestedEncoder(
    settingsSource === 'settings' ? settingsAll.encoder : undefined,
  );
  const resolvedEncoder: EncoderId =
    requested === 'auto' || requested === 'invalid'
      ? det.activeFromAuto
      : det.detected.includes(requested)
        ? requested
        : // Same fallback production takes for a pinned-but-undetected encoder.
          // It is SURFACED (encoderRequested vs encoderPicked) rather than silently
          // swallowed — introducing a fallback without showing it is how a green
          // result comes to read as "my nvenc works".
          'libx265';

  // AC-28: a pinned encoder that detection did not find fell back. Recorded here,
  // where both halves are still in scope, so the surfaces can MARK the divergence
  // instead of leaving the operator to compare two fields himself.
  const encoderFallback =
    requested !== 'auto' && requested !== 'invalid' && !det.detected.includes(requested);

  // encoderPicked stays the ffmpeg codec string for body.encoderPicked +
  // mapTestEncodeError (AC-4). The argv now comes from the shared builder.
  const encoderPicked = mapEncoderIdToFfmpegCodec(resolvedEncoder);

  // 50-06: crf/preset/10-bit through the SAME leaf the production dispatch uses.
  // On the fail-open path `settingsAll` is empty, so these resolve to the factory
  // defaults — which is precisely the v2.46.4 behaviour, minus the hard-pinned 28.
  const crf =
    settingsSource === 'settings'
      ? resolveCrfForEncoder(resolvedEncoder, settingsAll)
      : DEFAULT_CRF_BY_ENCODER[resolvedEncoder];
  const preset =
    settingsSource === 'settings'
      ? resolvePresetForEncoder(resolvedEncoder, settingsAll).preset
      : DEFAULT_PRESET_BY_ENCODER[resolvedEncoder];
  const force10bit = settingsSource === 'settings' ? resolveForce10bit(settingsAll) : false;
  const keyframeSec = keyframeIntervalSec();

  // 24-02 F4: thread the DISCOVERED det.vaapiDevice (same field the boot-probe and
  // the production encode consume) — NOT the hardcoded DEFAULT_VAAPI_DEVICE.
  // 30-01: thread the detection-validated qsv variant (SR-3 — no global-read in
  // the pure builder). No-op for nvenc/vaapi/libx265.
  // 49-03 (D7/AC-13): resolve the closed-GOP pin EXACTLY as buildArgs does —
  // env lever AND runtime verdict.
  const args = buildTestEncodeArgs({
    encoder: resolvedEncoder,
    crf,
    preset,
    devicePath: det.vaapiDevice,
    qsvRateControl: det.qsvRateControl,
    forceIdr: closedGopEnabled() && isForcedIdrSupported(resolvedEncoder),
    tenBit: force10bit,
    keyframeIntervalSec: keyframeSec,
  });

  // 45-01 M1: route the test-encode through the SAME selector as the real encode —
  // an nvenc test-encode on Pascal must use jellyfin ffmpeg-nvenc, else it fails on
  // BtbN and the 21-05 CopyReport gate reports nvenc broken, contradicting the real
  // encode. opts.ffmpegPath stays an optional unit-test override.
  //
  // 50-06 (AC-27): resolved ONCE and shared by the spawn AND the reported command
  // line. `ffmpegBinaryFor` reads FFMPEG_NVENC_PATH per call, so two calls could
  // legitimately disagree — and a reported command line that names a different
  // binary than the one that ran is worse than none.
  const binary = opts.ffmpegPath ?? ffmpegBinaryFor(resolvedEncoder);
  const commandLine = [binary, ...args];

  const startedAt = performance.now();
  // 45-01 M1: route the test-encode through the SAME selector as the real encode —
  // an nvenc test-encode on Pascal must use jellyfin ffmpeg-nvenc, else it fails on
  // BtbN and the 21-05 CopyReport gate reports nvenc broken, contradicting the real
  // encode. opts.ffmpegPath stays an optional unit-test override.
  const child = spawn(binary, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  const appendCapped = (buf: 'stdout' | 'stderr', chunk: string): void => {
    if (buf === 'stdout') {
      stdout = (stdout + chunk).slice(-STDIO_CAP_BYTES);
    } else {
      stderr = (stderr + chunk).slice(-STDIO_CAP_BYTES);
    }
  };

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (c: string) => appendCapped('stdout', c));
  child.stderr?.on('data', (c: string) => appendCapped('stderr', c));

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  const exitPromise: Promise<{ exitCode: number | null; closed: boolean }> = new Promise(
    (resolve) => {
      let closed = false;
      child.once('close', (code: number | null) => {
        closed = true;
        resolve({ exitCode: code, closed });
      });
      child.once('error', () => {
        resolve({ exitCode: null, closed });
      });
    },
  );

  const timeoutPromise: Promise<{ exitCode: number | null; closed: boolean }> = new Promise(
    (resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        // Wait for 'close' to fire so pipes are deterministically released
        // (zombie protection — close-await per P2 encode-engine pattern).
        child.once('close', (code: number | null) => {
          resolve({ exitCode: code, closed: true });
        });
      }, timeoutMs);
    },
  );

  const result = await Promise.race([exitPromise, timeoutPromise]);
  if (timer) clearTimeout(timer);

  const durationMs = Math.round(performance.now() - startedAt);
  const exitCode = timedOut ? null : result.exitCode;
  const success = !timedOut && exitCode === 0;

  const auditOutcome: TestEncodeAuditOutcome = success
    ? 'success'
    : timedOut
      ? 'killed_timeout'
      : 'failed';

  // 23-01: derive the human diagnosis server-side from the captured stderr.
  // Returns null on success / no-match (mapTestEncodeError already null-guards
  // exitCode 0), so the body field is the single source the route + UI consume.
  const mappedError = mapTestEncodeError(stderr, exitCode, encoderPicked);

  return {
    body: {
      success,
      encoderPicked,
      durationMs,
      ffmpegStdout: stdout,
      ffmpegStderr: stderr,
      exitCode,
      mappedError,
      // 50-06: the resolved configuration, taken from the SAME variables the argv
      // was built from — never re-resolved, or the report could describe a run
      // that did not happen.
      encoderRequested,
      encoderFallback,
      crf: Number.isFinite(crf) ? crf : 'unresolved',
      preset,
      force10bit,
      keyframeIntervalSec: keyframeSec,
      commandLine,
      settingsSource,
    },
    auditOutcome,
  };
}
