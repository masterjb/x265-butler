// Phase 3 Plan 03-01 Task 1 — encoder detection helper.
//
// Probes available HW encoders at runtime (NVENC via nvidia-smi, QSV/VAAPI via
// /dev/dri/renderD* + vainfo) and returns a preference-ranked list with libx265
// ALWAYS as the last entry (universal fallback).
//
// Result is cached on globalThis (HMR-safe per audit S12 declare in
// src/lib/global-runtime-state.d.ts) so subsequent calls in the same Node
// process return synchronously without spawning new probe children.
//
// Audit notes:
//  M3 — child_process spawn ENOENT fires the 'error' event, NOT a sync throw or
//       async rejection. Both nvidia-smi and vainfo probes wire `child.on('error',
//       ...)` so missing binaries do not crash the orchestrator boot path.
//  S2 — exports ENCODER_IDS runtime tuple so callers can validate untrusted
//       strings before casting to EncoderId.
//  S3 — per-probe AbortController timeout = 5 seconds (local sysfs/devfs queries
//       are millisecond-scale; 30s ceiling would punish container boot).
//  S4 — invalidateEncoderCache() non-test export for the future Settings UI in
//       03-03 (operator GPU-swap path).
//  S6 — DetectionResult.vaapiDevice captures the FIRST detected /dev/dri/renderD*
//       so the VAAPI profile builder can use it instead of hardcoding renderD128.
//  S8 — top-of-file `typeof window` guard against accidental client-component
//       import of a node:child_process side-effect.
//  S14 — single structured `encoder_detection_complete` info log at the end of
//        each detection run for operator visibility in container logs.

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { logger } from '../logger';
// 34-01 (MH-1): single-source gpu_device read INSIDE detection so every bare
// detectEncoders() call site is device-aware with no per-call-site threading and
// no cache-poison race. Cycle-checked: db/index.ts does NOT import encode/*.
import { settingRepo } from '@/src/lib/db';
import {
  ENCODER_IDS,
  type EncoderId,
  type QsvRateControl,
  buildCodecBlock,
  DEFAULT_PRESET_BY_ENCODER,
  PROBE_FRAME_SIZE,
} from './profiles';
import { ffmpegBinary } from './ffmpeg-binary';
import { reniceChild } from './child-priority';

// audit-added S8: defense-in-depth against accidental client-component import.
// Vitest-aware: jsdom environment defines `window` for component tests, so we
// only fire in real-browser contexts. Detection-specific tests run under the
// `// @vitest-environment node` directive, where `window` is undefined.
if (typeof window !== 'undefined' && !process.env.VITEST) {
  throw new Error('detection: server-only module imported into a browser context');
}

// Re-export for callers that import from this module historically.
export { ENCODER_IDS };
export type { EncoderId };
// 30-01: re-export so real-encode call sites (ffmpeg.ts/vmaf.ts/test-encode.ts)
// can type the validated variant without a second deep import into profiles.
export type { QsvRateControl };

// Phase 18 additive: structured detection warnings. Always present (empty
// array when no warnings) so consumers can iterate without an optional-chain.
export type DetectionWarningCode =
  | 'dri_present_no_driver'
  | 'qsv_only_legacy_intel'
  | 'vainfo_binary_missing'
  | 'nvenc_no_runtime'
  // 23-04: a feature-present HW encoder whose runtime probe-encode failed
  // (compiled-in but broken — e.g. `Error creating a MFX session: -9`).
  | 'encoder_runtime_broken'
  // 34-01: operator-configured gpu_device names a /dev/dri/renderD* node that is
  // NOT present among the enumerated render nodes → detection fell back to the
  // first node so the encode never breaks. Fires ONLY when render nodes EXIST but
  // the wanted one is absent (never when /dev/dri is unreadable / has no nodes).
  | 'gpu_device_not_found';

export const DETECTION_WARNING_CODES: readonly DetectionWarningCode[] = [
  'dri_present_no_driver',
  'qsv_only_legacy_intel',
  'vainfo_binary_missing',
  'nvenc_no_runtime',
  'encoder_runtime_broken',
  'gpu_device_not_found',
] as const;

// 23-04 (audit SR1): four-state runtime-truth label per encoder.
//  'functional'         = probe-encode exited 0 (runtime-VERIFIED).
//  'compiled-in-broken' = probe-encode exited non-zero (runtime-VERIFIED broken,
//                         gated OUT of detected[]; carries a stderr excerpt).
//  'probe-inconclusive' = probe timed out / could not spawn (TRUSTED feature-parse,
//                         NOT verified — fail-open, stays in detected[]). Also the
//                         label under the kill-switch (nothing was probed).
//  'missing'            = not feature-present.
export type EncoderOutcome = 'functional' | 'compiled-in-broken' | 'probe-inconclusive' | 'missing';

export interface DetectionWarning {
  code: DetectionWarningCode;
  severity: 'info' | 'warn';
  detail?: string;
}

export interface DetectionResult {
  detected: EncoderId[];
  activeFromAuto: EncoderId;
  vaapiDevice?: string;
  // Stable-shape contract per AC-4 (Plan 18-01): ALWAYS emitted, NEVER omitted.
  warnings: DetectionWarning[];
  // 23-04: stable-shape per-encoder runtime outcome — ALWAYS all four EncoderId
  // keys, NEVER omitted (same contract style as `warnings`).
  outcome: Record<EncoderId, EncoderOutcome>;
  // 23-04 (audit M2): per-encoder broken stderr excerpt, keyed BY ENCODER (NOT by
  // warning-code — multiple broken encoders share the identical
  // `encoder_runtime_broken` code). Populated only for 'compiled-in-broken'.
  brokenExcerpts: Partial<Record<EncoderId, string>>;
  // 23-04 (audit SR2/AC-12): true when X265_PROBE_ENCODE_DISABLED=1 — surfaced so
  // the diagnostics layer can flag that outcomes are feature-parse-only.
  probeEncodeDisabled: boolean;
  // 30-01: the qsv ratecontrol variant the two-tier probe validated. Set ONLY
  // when qsv is detected (functional/probe-inconclusive); undefined when qsv is
  // missing or both variants probed compiled-in-broken (stable-shape style
  // mirroring brokenExcerpts). Real qsv encodes read it via getActiveQsvRateControl().
  qsvRateControl?: QsvRateControl;
}

// PROBE_TIMEOUT_MS is the FEATURE-PARSE timeout (S3): nvidia-smi / vainfo are
// millisecond-scale sysfs/devfs queries, so 5 s is a generous ceiling. The REAL
// 1-frame ffmpeg encode probe gets its OWN, larger ENCODE_PROBE_TIMEOUT_MS (R1)
// because a cold NVENC/QSV/VAAPI session-init can exceed 5 s on slow hardware and
// a too-short timeout would falsely degrade a working encoder to
// 'probe-inconclusive' (losing the 23-04 runtime-'functional' verification).
const PROBE_TIMEOUT_MS = 5000;
// 28-07 (R1): separate, larger timeout for the ffmpeg encode probe only. See the
// PROBE_TIMEOUT_MS comment above — the encode probe pays a real codec-init cost.
// Parallel probing (P3) caps the all-hang worst case at this single 10 s, not
// 3×10 s sequential, so the larger value is affordable.
const ENCODE_PROBE_TIMEOUT_MS = 10000;
const PROBE_STDOUT_CAP_BYTES = 1 * 1024 * 1024; // 1 MiB

// ── 28-07 (L5): shared low-level spawn skeleton ─────────────────────────────
// runProbe (stdout/nvidia-smi/vainfo) and runEncodeProbe (stderr/ffmpeg) were two
// near-identical copies of the same settled-guard + spawn-try/catch +
// 'error'-event + SIGKILL-timeout + once('close') discipline, differing ONLY in
// which stream they capture, how they cap it, and the timeout. They are now thin
// adapters over this single skeleton. The neutral ChildRunResult union carries
// every terminal the two callers need; each adapter maps it to its own result
// shape. Behavior is byte-identical — the unchanged detection test suites are the
// parity sentinel (AC-1).
type ChildRunResult =
  | { kind: 'close'; exitCode: number | null; captured: string }
  | { kind: 'cap_exceeded' }
  | { kind: 'timeout' }
  | { kind: 'enoent'; err?: string }
  | { kind: 'error'; err?: string };

interface ChildRunOpts {
  capture: 'stdout' | 'stderr';
  // 'hard-kill'   = accumulate up to capBytes, then SIGKILL + cap_exceeded (stdout).
  // 'rolling-tail' = keep a rolling last-capBytes tail, never kill (stderr).
  capMode: 'hard-kill' | 'rolling-tail';
  capBytes: number;
  timeoutMs: number;
}

function runChildProcess(
  bin: string,
  args: readonly string[],
  opts: ChildRunOpts,
): Promise<ChildRunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: ChildRunResult): void => {
      if (settled) return;
      settled = true;
      try {
        clearTimeout(timer);
      } catch {
        // ignore
      }
      resolve(r);
    };

    const stdio: ['ignore', 'pipe' | 'ignore', 'pipe' | 'ignore'] =
      opts.capture === 'stdout' ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'ignore', 'pipe'];

    let child;
    try {
      child = spawn(bin, args as string[], { stdio });
    } catch (err) {
      settle({ kind: 'error', err: err instanceof Error ? err.message : String(err) });
      return;
    }
    reniceChild(child); // 38-01: covers detection probes AND test-encode (uniform priority)

    let captured = '';
    let capturedBytes = 0;
    let capped = false;
    const stream = opts.capture === 'stdout' ? child.stdout : child.stderr;
    if (stream) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        if (opts.capMode === 'hard-kill') {
          if (capped) return;
          capturedBytes += Buffer.byteLength(chunk, 'utf8');
          if (capturedBytes > opts.capBytes) {
            capped = true;
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
            return;
          }
          captured += chunk;
        } else {
          // rolling-tail: keep the LAST capBytes (the fatal ffmpeg line is last).
          captured += chunk;
          if (captured.length > opts.capBytes) {
            captured = captured.slice(-opts.capBytes);
          }
        }
      });
    }

    // audit-added M3: child_process.spawn ENOENT comes via 'error' event.
    child.on('error', (err: NodeJS.ErrnoException) => {
      settle(
        err && err.code === 'ENOENT'
          ? { kind: 'enoent', err: err?.message }
          : { kind: 'error', err: err?.message },
      );
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      settle({ kind: 'timeout' });
    }, opts.timeoutMs);

    child.once('close', (code: number | null) => {
      if (capped) {
        settle({ kind: 'cap_exceeded' });
        return;
      }
      settle({ kind: 'close', exitCode: code, captured });
    });
  });
}

type SpawnResult =
  | { ok: true; exitCode: number; stdout: string }
  | { ok: false; cause: 'ENOENT' | 'EXIT_NONZERO' | 'TIMEOUT' | 'ERROR'; err?: string };

// 28-07 (L5): thin adapter over runChildProcess — stdout, hard-cap at 1 MiB,
// feature-parse timeout. Maps the neutral result to SpawnResult byte-identically
// to the pre-28-07 inline implementation.
async function runProbe(bin: string, args: readonly string[]): Promise<SpawnResult> {
  const r = await runChildProcess(bin, args, {
    capture: 'stdout',
    capMode: 'hard-kill',
    capBytes: PROBE_STDOUT_CAP_BYTES,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  switch (r.kind) {
    case 'cap_exceeded':
      return { ok: false, cause: 'ERROR', err: 'stdout exceeded probe cap' };
    case 'timeout':
      return { ok: false, cause: 'TIMEOUT' };
    case 'enoent':
      return { ok: false, cause: 'ENOENT', err: r.err };
    case 'error':
      return { ok: false, cause: 'ERROR', err: r.err };
    case 'close':
      return r.exitCode === 0
        ? { ok: true, exitCode: 0, stdout: r.captured }
        : { ok: false, cause: 'EXIT_NONZERO', err: `exit_code=${r.exitCode}` };
  }
}

// ── 23-04: runtime probe-encode gate ───────────────────────────────────────
// A REAL 1-frame testsrc encode through the actual codec block. Unlike runProbe
// (which captures STDOUT for vainfo/nvidia-smi parse), this captures STDERR —
// ffmpeg prints the fatal diagnostic line (`Error creating a MFX session: -9`,
// `OpenEncodeSessionEx failed`, …) to stderr at the END of the run.

const PROBE_STDERR_CAP_BYTES = 4 * 1024; // rolling tail; the fatal line is LAST.

type EncodeProbeResult =
  | { ok: true }
  | { ok: false; cause: 'EXIT_NONZERO' | 'TIMEOUT' | 'ENOENT' | 'ERROR'; stderrTail?: string };

// audit-added F4 (Plan 25-01): named, per-line-documented denylist — NOT an
// inline opaque regex. Each entry is a distinct ffmpeg-epilogue class with a
// known wording that the parametrized test in 25-01 locks. A future ffmpeg
// version-bump that renames a class fails THAT test case loudly instead of
// silently re-introducing front-truncation.
const FFMPEG_EPILOGUE_NOISE: readonly RegExp[] = [
  /^frame=/i, // per-frame progress stats
  /^size=/i, // size= progress (no leading frame=)
  /^\[out#/i, // muxer summary ("Nothing was written…")
  /^Nothing was written into output file/i, // old-ffmpeg variant w/o [out#] prefix
  /^video:\s*\d/i, // "video:0kB audio:0kB …" tally
  /^muxing overhead/i, // trailing muxing-overhead line
  /^Conversion failed/i, // terminal failure banner
  /^\[q\]/i, // interactive [q] echo (defensive)
];

// audit-added M1 (23-04): the excerpt MUST favour the codec-init fatal line.
// ffmpeg prints that line MID-run for qsv, then a GENERIC muxer epilogue AFTER
// (out# muxer summary + frame= stats + "Conversion failed!"). A blind tail-slice
// captures the epilogue and front-truncates the real error (2026-05-31 report:
// "qsv: d argument) … Nothing was written …"). So drop epilogue lines first,
// THEN tail-slice the remaining signal. NOTE (25-01): the "fatal line is LAST"
// assumption holds for nvenc/vaapi single-line failures but NOT for qsv, which
// appends the muxer epilogue — hence the denylist pass.
function tailExcerpt(stderr: string | undefined): string {
  if (!stderr) return '';
  const lines = stderr
    // audit-added F2 (25-01): ffmpeg overwrites the progress line with CARRIAGE
    // RETURN (\r), not \n — split on BOTH or a "frame= …\r<codec error>" run
    // stays one physical line and the denylist mis-classifies it.
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const signal = lines.filter((l) => !FFMPEG_EPILOGUE_NOISE.some((re) => re.test(l)));
  // Fail-soft (AC-3): if EVERYTHING was boilerplate, keep the raw lines so the
  // excerpt is never empty — a generic message still beats nothing.
  const picked = signal.length ? signal : lines;
  return picked.join(' ').replace(/\s+/g, ' ').trim().slice(-240);
}

// 28-07 (L5): thin adapter over runChildProcess — stderr, rolling-tail at 4 KiB,
// and the SEPARATE ENCODE_PROBE_TIMEOUT_MS (R1) for the real codec-init cost. Maps
// the neutral result to EncodeProbeResult byte-identically to the pre-28-07 inline
// implementation. DO NOT inline this back — runProbe + runEncodeProbe now share
// one skeleton on purpose (the two copies drifted independently before).
async function runEncodeProbe(bin: string, args: readonly string[]): Promise<EncodeProbeResult> {
  const r = await runChildProcess(bin, args, {
    capture: 'stderr',
    capMode: 'rolling-tail',
    capBytes: PROBE_STDERR_CAP_BYTES,
    timeoutMs: ENCODE_PROBE_TIMEOUT_MS,
  });
  switch (r.kind) {
    case 'timeout':
      return { ok: false, cause: 'TIMEOUT' };
    case 'enoent':
      return { ok: false, cause: 'ENOENT', stderrTail: r.err };
    case 'error':
      return { ok: false, cause: 'ERROR', stderrTail: r.err };
    case 'cap_exceeded':
      // Unreachable for rolling-tail (never kills), but the union demands it.
      return { ok: false, cause: 'ERROR' };
    case 'close':
      return r.exitCode === 0
        ? { ok: true }
        : { ok: false, cause: 'EXIT_NONZERO', stderrTail: r.captured };
  }
}

// Build the probe argv reusing the REAL codec block (buildCodecBlock) so the
// probe init-path matches the production encode (qsv→hevc_qsv, nvenc→hevc_nvenc,
// vaapi→-vaapi_device+format=nv12,hwupload). `-i` precedes the codec block —
// identical ordering to buildEncodeArgs (audit-verified arg-order faithfulness).
// 29-01: frame size now comes from the shared PROBE_FRAME_SIZE const (matches
// the test-encode builder) — was a hardcoded 16x16, below HW-HEVC minimum frame
// dims → false `compiled-in-broken`. Stays a 1-frame fast probe (-frames:v 1).
// 30-01: qsvRateControl threads into buildCodecBlock so the qsv probe argv
// matches whichever variant this tier is testing (icq-full → `-low_power 0
// -global_quality`; cqp → `-q:v`). No-op for nvenc/vaapi/libx265.
function buildProbeEncodeArgs(
  encoder: EncoderId,
  devicePath?: string,
  qsvRateControl?: QsvRateControl,
): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=${PROBE_FRAME_SIZE}:rate=1:duration=1`,
    ...buildCodecBlock({
      encoder,
      crf: 28,
      preset: DEFAULT_PRESET_BY_ENCODER[encoder],
      devicePath,
      qsvRateControl,
    }),
    '-frames:v',
    '1',
    '-f',
    'null',
    '-',
  ];
}

interface ProbeEncodeOutcome {
  outcome: EncoderOutcome;
  detected: boolean;
  excerpt?: string;
  warning?: DetectionWarning;
  // 30-01: the validated qsv variant (qsv only). Set on functional / fail-open
  // inconclusive; undefined when BOTH variants probed compiled-in-broken.
  qsvRateControl?: QsvRateControl;
}

// 30-01: single-shot probe of ONE codec-block variant. For qsv the caller
// (probeEncodeFunctional) drives the two-tier ICQ-full→CQP retry; nvenc/vaapi
// stay single-shot. Body is byte-identical to the pre-30-01 probeEncodeFunctional
// except the threaded qsvRateControl on the argv build.
async function probeEncodeOnce(
  encoder: EncoderId,
  devicePath?: string,
  qsvRateControl?: QsvRateControl,
): Promise<ProbeEncodeOutcome> {
  const r = await runEncodeProbe(
    ffmpegBinary(),
    buildProbeEncodeArgs(encoder, devicePath, qsvRateControl),
  );
  if (r.ok) {
    return { outcome: 'functional', detected: true };
  }
  if (r.cause === 'EXIT_NONZERO') {
    const excerpt = tailExcerpt(r.stderrTail);
    // audit-added F1 (Plan 25-01 / AC-5): tailExcerpt is now a LOSSY transform.
    // Persist the RAW (pre-strip) capped stderrTail so the source-of-truth
    // evidence survives even if the denylist mis-fires on a future ffmpeg
    // wording — and so the denylist stays tunable from field logs. Additive
    // ONLY: the returned outcome/warning/brokenExcerpts shape is unchanged.
    // Mirrors the existing `encoder_probe_inconclusive` log below.
    logger.warn(
      {
        action: 'encoder_probe_broken',
        encoder,
        rawStderr: r.stderrTail ?? '', // pre-strip ≤4 KiB rolling tail
        excerpt, // what the operator-facing surface shows
      },
      'encoder probe-encode failed (raw stderr captured for forensics)',
    );
    return {
      outcome: 'compiled-in-broken',
      detected: false,
      excerpt,
      // audit SR4: detail carries a RAW stderr excerpt — rendered as opaque text,
      // NEVER through next-intl/ICU (which throws on stray `{`/`}`).
      warning: {
        code: 'encoder_runtime_broken',
        severity: 'warn',
        detail: `${encoder}: ${excerpt}`,
      },
    };
  }
  // TIMEOUT / ENOENT / ERROR → FAIL-OPEN (AC-3): trust the feature-parse, keep the
  // encoder, but label it 'probe-inconclusive' (NOT 'functional' — preserve the
  // verified-vs-trusted distinction for post-incident reconstruction, audit SR1).
  logger.warn(
    { action: 'encoder_probe_inconclusive', encoder, cause: r.cause },
    'encoder probe inconclusive (fail-open)',
  );
  return { outcome: 'probe-inconclusive', detected: true };
}

// 30-01: two-tier qsv ratecontrol probe (single-shot for every other encoder).
// ICQ-full is probed FIRST (the quality default). The CQP retry fires ONLY on a
// definitive ICQ-full EXIT_NONZERO (outcome==='compiled-in-broken') — NOT on a
// fail-open 'probe-inconclusive' (TIMEOUT/ENOENT/ERROR), which is not an
// ICQ-rejection signal and would only burn a second ENCODE_PROBE_TIMEOUT_MS
// budget (AC-7). An ICQ-full success spends exactly ONE probe (AC-8). When both
// variants EXIT_NONZERO, the LAST (CQP) attempt's warning + excerpt surface (the
// final failure operators should see) and qsvRateControl stays undefined.
async function probeEncodeFunctional(
  encoder: EncoderId,
  devicePath?: string,
): Promise<ProbeEncodeOutcome> {
  if (encoder !== 'qsv') {
    return probeEncodeOnce(encoder, devicePath);
  }

  const icq = await probeEncodeOnce('qsv', devicePath, 'icq-full');
  // AC-8 happy path: ICQ-full ran → exactly one spawn, persist 'icq-full'.
  if (icq.outcome === 'functional') {
    return { ...icq, qsvRateControl: 'icq-full' };
  }
  // AC-7 fail-open: ICQ-full inconclusive is NOT an ICQ-rejection → do NOT retry
  // CQP. qsv stays detected as 'probe-inconclusive'; variant defaults to the
  // documented production default 'icq-full' (never undefined-while-detected).
  if (icq.outcome === 'probe-inconclusive') {
    return { ...icq, qsvRateControl: 'icq-full' };
  }

  // ICQ-full EXIT_NONZERO (compiled-in-broken) → the rasalf signal: ICQ rejected
  // on the auto-selected low-power path. Retry the CQP variant.
  const cqp = await probeEncodeOnce('qsv', devicePath, 'cqp');
  if (cqp.outcome === 'functional') {
    return { ...cqp, qsvRateControl: 'cqp' };
  }
  if (cqp.outcome === 'probe-inconclusive') {
    // CQP couldn't be verified (timeout/enoent) but ICQ-full is KNOWN broken, so
    // bias the fail-open default to 'cqp' (the not-known-broken variant) rather
    // than re-emitting the proven-rejected ICQ-full block at production time.
    return { ...cqp, qsvRateControl: 'cqp' };
  }
  // BOTH variants compiled-in-broken → gate out; surface the CQP (last) failure;
  // qsvRateControl stays undefined (AC-4).
  return cqp;
}

// Phase 18 audit-fix M3: widened return type — caller needs ENOENT vs
// EXIT_NONZERO vs NO_GPU to decide whether to emit `nvenc_no_runtime`.
async function probeNvenc(): Promise<{
  ok: boolean;
  cause?: 'ENOENT' | 'EXIT_NONZERO' | 'NO_GPU';
}> {
  const r = await runProbe('nvidia-smi', ['-L']);
  if (r.ok && r.stdout.includes('GPU')) return { ok: true };
  if (r.ok) {
    // exit 0 but no GPU line — host has nvidia-smi but no GPU.
    return { ok: false, cause: 'NO_GPU' };
  }
  logger.warn(
    { action: 'encoder_probe_failed', probe: 'nvenc', cause: r.cause, err: r.err },
    'encoder probe failed (nvenc)',
  );
  if (r.cause === 'ENOENT') return { ok: false, cause: 'ENOENT' };
  return { ok: false, cause: 'EXIT_NONZERO' };
}

// Phase 18 additive: detect `/dev/nvidia*` device-file presence without
// spawning. Used to emit `nvenc_no_runtime` when devices exist but the userland
// binary is missing (host-side NVIDIA-driver-plugin uninstalled or container
// passthrough not wired).
async function probeNvidiaDevicesPresent(): Promise<boolean> {
  try {
    const entries = await fsp.readdir('/dev');
    return entries.some((f) => /^nvidia(\d+|ctl|-uvm.*|-modeset)$/.test(f));
  } catch {
    return false;
  }
}

interface VaInfoProbeResult {
  qsv: boolean;
  vaapi: boolean;
  warning?: DetectionWarning;
}

// 27-01: pure classifier — decouples the two orthogonal capabilities advertised
// by `vainfo` on a single /dev/dri device.
//
//   QSV-capable   ⇔ stdout includes 'iHD'                  (oneVPL/MSDK is Intel-iHD-only)
//   VAAPI-capable ⇔ stdout includes 'VAEntrypointEncSlice' (generic VAAPI: ANY driver)
//
// Pre-27-01 this mapping treated iHD as qsv XOR vaapi (any iHD driver early-
// returned {qsv:true, vaapi:false}), so an iHD host whose QSV (oneVPL/MFX) stack
// is broken at runtime fell ALL the way back to libx265 — even when hevc_vaapi
// works perfectly on the same device. Both are now candidates; the 23-04
// probe-encode gate verifies which actually runs and QSV stays preferred
// (ENCODER_IDS lists qsv before vaapi) when both pass.
export function classifyVaInfo(stdout: string, driPresent: boolean): VaInfoProbeResult {
  const hasIhd = stdout.includes('iHD');
  const hasI965 = stdout.includes('i965');
  const hasEncEntrypoints = stdout.includes('VAEntrypointEncSlice');
  const qsv = hasIhd; // QSV (oneVPL/MSDK) is iHD-only
  const vaapi = hasEncEntrypoints; // generic VAAPI: any driver with encode entrypoints
  // Legacy Intel i965: VAAPI works, QSV/AV1 unavailable — INFO only.
  if (vaapi && hasI965 && !hasIhd) {
    return {
      qsv,
      vaapi,
      warning: {
        code: 'qsv_only_legacy_intel',
        severity: 'info',
        detail: 'legacy i965 driver only; AV1 unavailable',
      },
    };
  }
  // Driver loaded but no usable encode surface at all.
  if (!qsv && !vaapi && driPresent) {
    return {
      qsv,
      vaapi,
      warning: {
        code: 'dri_present_no_driver',
        severity: 'warn',
        detail: 'vainfo enumerated no encode entrypoints',
      },
    };
  }
  return { qsv, vaapi };
}

async function probeVaInfo(driPresent: boolean): Promise<VaInfoProbeResult> {
  const r = await runProbe('vainfo', ['--display', 'drm']);
  if (!r.ok) {
    logger.warn(
      { action: 'encoder_probe_failed', probe: 'vainfo', cause: r.cause, err: r.err },
      'encoder probe failed (vainfo)',
    );
    if (r.cause === 'ENOENT') {
      return {
        qsv: false,
        vaapi: false,
        warning: {
          code: 'vainfo_binary_missing',
          severity: 'warn',
          detail: 'vainfo not installed',
        },
      };
    }
    if (r.cause === 'EXIT_NONZERO' && driPresent) {
      return {
        qsv: false,
        vaapi: false,
        warning: {
          code: 'dri_present_no_driver',
          severity: 'warn',
          detail: 'vainfo failed to enumerate entrypoints',
        },
      };
    }
    return { qsv: false, vaapi: false };
  }
  return classifyVaInfo(r.stdout, driPresent);
}

// 34-01: device-aware render-node resolver. With no override (gpuDevice empty/
// undefined) returns the FIRST enumerated renderD node — byte-identical to the
// pre-34 auto-pick for single-GPU hosts (AC-1). With an override: returns the
// named node when present (AC-2); falls back to the first node when absent
// (AC-3 — NEVER break the encode; resolveVaapi raises the gpu_device_not_found
// warning). Return type stays `string | undefined` to minimise blast radius —
// the not-found signal is derived by resolveVaapi (wanted-basename ≠ resolved).
async function findRenderDDevice(gpuDevice?: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fsp.readdir('/dev/dri');
  } catch {
    return undefined;
  }
  // 34-01 (SR-2): deterministic order (mirror render-device-probe.ts sort) so the
  // "first" node is stable/testable, NOT readdir() enumeration order.
  const nodes = entries.filter((f) => /^renderD\d+$/.test(f)).sort();
  if (nodes.length === 0) return undefined;
  if (gpuDevice && gpuDevice.length > 0) {
    const wanted = gpuDevice.split('/').pop();
    if (wanted && nodes.includes(wanted)) return `/dev/dri/${wanted}`;
  }
  return `/dev/dri/${nodes[0]}`;
}

// 23-04: backend kill-switch (NOT NEXT_PUBLIC — detection.ts is server-only).
// Read at detection-time (not module-load) so it is honoured on the next
// cache-miss/invalidate after a container restart, and is unit-testable per-case.
// Restart is still required in practice because detection is globalThis-cached.
function isProbeEncodeDisabled(): boolean {
  return process.env.X265_PROBE_ENCODE_DISABLED === '1';
}

// 28-07 (P3): nvenc-chain resolver — probeNvenc, and on ENOENT the
// /dev/nvidia*-presence check that drives the nvenc_no_runtime warning. Returns a
// neutral struct so the candidate/warning assembly happens AFTER both chains
// settle (deterministic order, independent of which chain finished first).
async function resolveNvenc(): Promise<{ ok: boolean; warning?: DetectionWarning }> {
  const nvenc = await probeNvenc();
  if (nvenc.ok) return { ok: true };
  if (nvenc.cause === 'ENOENT' && (await probeNvidiaDevicesPresent())) {
    // Devices passed through but userland missing — actionable for operator.
    return {
      ok: false,
      warning: {
        code: 'nvenc_no_runtime',
        severity: 'warn',
        detail: '/dev/nvidia* present but nvidia-smi binary missing',
      },
    };
  }
  return { ok: false };
}

// 28-07 (P3): vaapi-chain resolver — find the renderD device, then vainfo-classify.
// Carries the UNsuppressed warning; the suppressDri rule (keyed on nvenc.ok) is
// applied by the caller after both chains settle so its semantics stay identical.
// 34-01: gpuDevice override threads in here. resolveVaapi keeps its single
// `warning?` slot for the vainfo path UNTOUCHED and instead exposes two additive
// optional fields the caller (runDetection) uses to assemble the
// gpu_device_not_found DetectionWarning explicitly (SR-2). gpuDeviceNotFound is
// derived without a second readdir: when an override was requested but the
// resolved node's basename differs from the wanted one, the wanted node was
// absent and findRenderDDevice fell back to the first node. A `vaapiDevice ===
// undefined` short-circuit means no render nodes exist at all → NO
// gpu_device_not_found (the no-DRI edge — existing warnings cover that case).
async function resolveVaapi(gpuDevice?: string): Promise<{
  vaapiDevice?: string;
  qsv: boolean;
  vaapi: boolean;
  warning?: DetectionWarning;
  gpuDeviceNotFound?: boolean;
  gpuDeviceWanted?: string;
}> {
  const vaapiDevice = await findRenderDDevice(gpuDevice);
  if (vaapiDevice === undefined) return { vaapiDevice, qsv: false, vaapi: false };
  const probe = await probeVaInfo(true);
  // 34-01 (SR-2): not-found iff an override was requested AND the resolved node
  // differs from it (= wanted absent → first-node fallback). Nodes exist here
  // (vaapiDevice !== undefined), so this never fires on the no-DRI edge.
  const wanted = gpuDevice && gpuDevice.length > 0 ? gpuDevice.split('/').pop() : undefined;
  const resolvedBasename = vaapiDevice.split('/').pop();
  const gpuDeviceNotFound = wanted !== undefined && wanted !== resolvedBasename;
  return {
    vaapiDevice,
    qsv: probe.qsv,
    vaapi: probe.vaapi,
    warning: probe.warning,
    gpuDeviceNotFound: gpuDeviceNotFound || undefined,
    gpuDeviceWanted: gpuDeviceNotFound ? gpuDevice : undefined,
  };
}

async function runDetection(gpuDevice?: string): Promise<DetectionResult> {
  const startMs = Date.now();
  const probeEncodeDisabled = isProbeEncodeDisabled();
  const detected: EncoderId[] = [];
  const warnings: DetectionWarning[] = [];
  // Stable-shape: all four keys ALWAYS present (AC-6). libx265 is never probed
  // (AC-4) so it starts — and stays — 'functional'.
  const outcome: Record<EncoderId, EncoderOutcome> = {
    nvenc: 'missing',
    qsv: 'missing',
    vaapi: 'missing',
    libx265: 'functional',
  };
  const brokenExcerpts: Partial<Record<EncoderId, string>> = {};
  // 30-01: the qsv ratecontrol variant the two-tier probe validated; stays
  // undefined unless qsv is a candidate (then set below from the probe / default).
  let qsvRateControl: QsvRateControl | undefined;

  // ── 28-07 (P3) Feature-parse, parallel → produces CANDIDATE set, not final. ──
  // The nvenc-chain and the vaapi-chain are independent, so they run concurrently
  // and the candidate set + warnings are assembled deterministically AFTER both
  // settle. Result is byte-identical to the prior sequential path (AC-3).
  //
  // SR-4: resolveNvenc MUST stay at array-index-0. Its nvidia-smi spawn is
  // SYNCHRONOUS (inside runChildProcess's Promise executor), while resolveVaapi
  // awaits readdir('/dev/dri') BEFORE spawning vainfo — so index-0 establishes the
  // nvidia-smi-before-vainfo spawn order AC-3 asserts and the FIFO spawn mocks
  // rely on. Reordering this array silently breaks both.
  // SR-1: Promise.all (NOT allSettled) is DELIBERATE here. Unlike 28-04/28-06 which
  // fan out over UNBOUNDED file lists (where one file's failure must not abort the
  // batch), this set is domain-bounded and the contract is byte-identical-to-
  // sequential — a probe throw MUST propagate exactly as the sequential `await`
  // did. allSettled would CHANGE semantics by swallowing a real boot-path error.
  // (Every current probe catches internally and is non-throwing by construction;
  // this guards a future regression. See AC-7.)
  const candidates: EncoderId[] = [];
  const [nv, va] = await Promise.all([resolveNvenc(), resolveVaapi(gpuDevice)]);

  if (nv.ok) {
    candidates.push('nvenc');
  } else if (nv.warning) {
    warnings.push(nv.warning);
  }

  const vaapiDevice = va.vaapiDevice;
  if (va.qsv) candidates.push('qsv');
  if (va.vaapi) candidates.push('vaapi');
  if (va.warning) {
    // 18-02 false-positive suppression: NVIDIA hosts have /dev/dri/* nodes
    // registered by the NVIDIA DRM driver, but vainfo cannot enumerate VA-API
    // entrypoints on them (NVIDIA uses NVENC, not VAAPI). When NVENC was
    // detected, the dri_present_no_driver warning is noise — suppress it.
    // Other warnings (vainfo_binary_missing, qsv_only_legacy_intel) still
    // fire because they remain actionable even on NVIDIA hosts.
    const suppressDri = va.warning.code === 'dri_present_no_driver' && nv.ok;
    if (!suppressDri) {
      warnings.push(va.warning);
    }
  }
  // 34-01 (SR-2): assemble the gpu_device_not_found warning explicitly here
  // (mirror the suppressDri assembly above), pushing AFTER the vaapi va.warning so
  // ordering is deterministic. Fires ONLY when render nodes EXIST but the wanted
  // override was absent (va.gpuDeviceNotFound) — never on the no-DRI edge.
  if (va.gpuDeviceNotFound) {
    warnings.push({
      code: 'gpu_device_not_found',
      severity: 'warn',
      detail: `configured gpu_device ${va.gpuDeviceWanted} not present in /dev/dri; using ${va.vaapiDevice}`,
    });
  }

  // ── 23-04 probe-encode gate: detected[] membership is GATED on probe exit=0. ──
  // 28-07 (P3): the ≤3 HW candidate probes now run via an ORDER-PRESERVING
  // Promise.all (dispatch is synchronous in candidate order → FIFO spawn; results
  // are consumed in candidate order regardless of completion order, so
  // detected[]/outcome/warnings/brokenExcerpts stay byte-identical — AC-4).
  // SR-1: Promise.all (NOT allSettled) deliberately, for the same reason as the
  // feature-parse fan-out above — preserve the sequential `for await` throw-
  // semantics so a probe throw aborts detection (and does NOT poison the cache,
  // AC-7). Do NOT swap to allSettled.
  const gateStart = Date.now();
  if (probeEncodeDisabled) {
    // Kill-switch: revert to feature-parse-only. Nothing was probed, so the
    // honest outcome is 'probe-inconclusive' (audit SR1/SR2 — NOT 'functional').
    for (const enc of candidates) {
      detected.push(enc);
      outcome[enc] = 'probe-inconclusive';
      // 30-01: nothing was probed, but a disabled-probe host must still emit a
      // coherent qsv variant — default to the production default 'icq-full'.
      if (enc === 'qsv') qsvRateControl = 'icq-full';
    }
  } else {
    const settled = await Promise.all(
      candidates.map((enc) =>
        // 34-01: thread the resolved render node into the QSV probe too (was
        // undefined) so the boot probe verifies the SELECTED node, not the
        // default. nvenc/libx265 stay undefined.
        probeEncodeFunctional(enc, enc === 'vaapi' || enc === 'qsv' ? vaapiDevice : undefined).then(
          (res) => ({
            enc,
            res,
          }),
        ),
      ),
    );
    for (const { enc, res } of settled) {
      // 30-01: persist the winning qsv variant (functional / fail-open default).
      if (enc === 'qsv' && res.qsvRateControl) qsvRateControl = res.qsvRateControl;
      if (res.detected) {
        detected.push(enc);
        outcome[enc] = res.outcome; // 'functional' (exit 0) or 'probe-inconclusive' (fail-open)
      } else {
        // EXIT_NONZERO → compiled-in-but-broken: gate OUT, record warning + excerpt.
        outcome[enc] = 'compiled-in-broken';
        if (res.warning) warnings.push(res.warning);
        if (res.excerpt) brokenExcerpts[enc] = res.excerpt;
      }
    }
  }
  // 28-07 (SR-3): probeDurationMs is now PARALLEL wall-clock (max of the fan-out),
  // NOT the old sequential sum of per-probe durations — see the S14 log comment.
  const probeDurationMs = probeEncodeDisabled ? 0 : Date.now() - gateStart;

  detected.push('libx265'); // AC-4: never probed; outcome stays 'functional'.
  const activeFromAuto = detected[0];

  const result: DetectionResult = {
    detected,
    activeFromAuto,
    vaapiDevice,
    warnings,
    outcome,
    brokenExcerpts,
    probeEncodeDisabled,
    qsvRateControl,
  };

  // audit-added S14 (extended 23-04 audit D1): boot-time visibility for operator
  // container logs. probeDurationMs surfaces the un-capped per-probe boot cost.
  // 28-07 (SR-3): since P3 parallelized BOTH the feature-parse and the encode-gate,
  // durationMs AND probeDurationMs are now PARALLEL wall-clock (the MAX of the
  // fan-out), NOT a sequential SUM of per-probe times. Do not read them as
  // per-probe cost — a single slow probe now dominates the figure.
  logger.info(
    {
      action: 'encoder_detection_complete',
      detected,
      activeFromAuto,
      vaapiDevice,
      warningCount: warnings.length,
      outcome,
      probeEncodeDisabled,
      // 30-01 (AC-6): surface the resolved qsv ratecontrol variant.
      qsvRateControl,
      probeDurationMs,
      durationMs: Date.now() - startMs,
    },
    'encoder detection complete',
  );

  return result;
}

export async function detectEncoders(opts?: {
  force?: boolean;
  gpuDevice?: string;
}): Promise<DetectionResult> {
  if (!opts?.force && globalThis.__x265butler_encoder_cache) {
    return globalThis.__x265butler_encoder_cache;
  }
  // 39-01: boot-race single-flight. A concurrent NON-force caller joins the one
  // in-flight runDetection instead of launching its own (collapses the boot
  // double-probe that lost the AMD card). force:true skips the join — it always
  // runs a strictly-fresh probe and is never the shared join target.
  if (!opts?.force && globalThis.__x265butler_encoder_detect_inflight) {
    return globalThis.__x265butler_encoder_detect_inflight;
  }
  // 34-01 (MH-1): single-source resolution. When no explicit gpuDevice is passed
  // (every PRODUCTION caller stays bare), read it from the setting repo HERE so
  // ALL ≥10 bare call sites are device-aware with ZERO call-site threading and no
  // cold-cache / post-invalidate poison race (AC-7/AC-9). The explicit `gpuDevice`
  // param is the unit-test injection seam ONLY. Empty string → first node
  // (AC-1 byte-identical), exactly as an undefined param would. The settings read
  // is wrapped: detection must NEVER crash because the settings DB is momentarily
  // unavailable — degrade to auto (first node = byte-identical) instead.
  let gpuDevice = opts?.gpuDevice;
  if (gpuDevice === undefined) {
    try {
      gpuDevice = settingRepo().get('gpu_device') ?? '';
    } catch {
      gpuDevice = '';
    }
  }
  // 39-01: build the work as a bare IIFE promise. The cache-set sits AFTER the
  // `await runDetection` — a reject throws before it, so a FAILED detection is
  // never cached (AC-5, the inverse of the Defect-B permanent-cache trap).
  const p = (async () => {
    const result = await runDetection(gpuDevice);
    globalThis.__x265butler_encoder_cache = result;
    return result;
  })();
  // Only a NON-force call publishes EXACTLY THIS bare `p` to the in-flight slot,
  // so force stays isolated and never becomes a join target. The .finally is a
  // discarded SIDE EFFECT (we store/await/return the bare `p`, not the chained
  // promise) and clears the slot on BOTH resolve and reject (AC-5). The identity
  // guard (=== p) stops a later normal/force cycle's promise from being stomped.
  if (!opts?.force) {
    globalThis.__x265butler_encoder_detect_inflight = p;
    p.finally(() => {
      if (globalThis.__x265butler_encoder_detect_inflight === p) {
        globalThis.__x265butler_encoder_detect_inflight = undefined;
      }
    }).catch(() => {
      // 39-01 (AC-5): the .finally chain is a DISCARDED side-effect that mirrors
      // p's rejection. Swallow it HERE so this side-channel promise is never an
      // unhandled rejection — real callers still observe the rejection via the
      // `return await p` below (shared-fate is the accepted boot semantics).
    });
  }
  return await p;
}

// audit-added S4: non-test export for the future Settings UI in 03-03.
export function invalidateEncoderCache(): void {
  globalThis.__x265butler_encoder_cache = undefined;
}

// 30-01: single point that reads the global detection cache for the qsv
// ratecontrol variant, so real-encode leaves (profiles.ts) stay pure and
// callers never reach into globalThis themselves. Returns the production default
// 'icq-full' when the cache is absent (cold process / detection not yet run) or
// qsv was never validated.
export function getActiveQsvRateControl(): QsvRateControl {
  return globalThis.__x265butler_encoder_cache?.qsvRateControl ?? 'icq-full';
}

// 30-01 (audit SR-2): distinguishes a VALIDATED qsv variant from a silent
// default for post-incident reconstruction. False when the cache is cold or qsv
// was never probed-functional — the real-encode layer logs once when it defaults.
export function isQsvRateControlValidated(): boolean {
  return globalThis.__x265butler_encoder_cache?.qsvRateControl !== undefined;
}

// Test-only escape hatch — never exported via the barrel.
export function __forTests_resetEncoderCache(): void {
  globalThis.__x265butler_encoder_cache = undefined;
  // 39-01: also clear the single-flight guard so each spec starts hermetic.
  globalThis.__x265butler_encoder_detect_inflight = undefined;
}

// 29-01 test-only escape hatch — never exported via the barrel. Exposes the
// module-private buildProbeEncodeArgs so the probe-frame-size regression
// (size=320x240, no 16x16, 1-frame, vaapi hwupload chain) can be asserted on the
// real argv. Mirrors __forTests_resetEncoderCache above (barrel-excluded idiom).
// 30-01 (audit MH-2): forwards the qsvRateControl so detection.test.ts can
// assert the REAL ICQ-full (`-low_power 0`/`-global_quality`) vs CQP (`-q:v`)
// probe argv against the actual builder.
export function __forTests_buildProbeEncodeArgs(
  encoder: EncoderId,
  devicePath?: string,
  qsvRateControl?: QsvRateControl,
): string[] {
  return buildProbeEncodeArgs(encoder, devicePath, qsvRateControl);
}
