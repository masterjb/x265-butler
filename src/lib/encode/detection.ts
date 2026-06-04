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
import {
  ENCODER_IDS,
  type EncoderId,
  buildCodecBlock,
  DEFAULT_PRESET_BY_ENCODER,
} from './profiles';
import { ffmpegBinary } from './ffmpeg-binary';

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

// Phase 18 additive: structured detection warnings. Always present (empty
// array when no warnings) so consumers can iterate without an optional-chain.
export type DetectionWarningCode =
  | 'dri_present_no_driver'
  | 'qsv_only_legacy_intel'
  | 'vainfo_binary_missing'
  | 'nvenc_no_runtime'
  // 23-04: a feature-present HW encoder whose runtime probe-encode failed
  // (compiled-in but broken — e.g. `Error creating a MFX session: -9`).
  | 'encoder_runtime_broken';

export const DETECTION_WARNING_CODES: readonly DetectionWarningCode[] = [
  'dri_present_no_driver',
  'qsv_only_legacy_intel',
  'vainfo_binary_missing',
  'nvenc_no_runtime',
  'encoder_runtime_broken',
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
}

const PROBE_TIMEOUT_MS = 5000;
const PROBE_STDOUT_CAP_BYTES = 1 * 1024 * 1024; // 1 MiB

type SpawnResult =
  | { ok: true; exitCode: number; stdout: string }
  | { ok: false; cause: 'ENOENT' | 'EXIT_NONZERO' | 'TIMEOUT' | 'ERROR'; err?: string };

function runProbe(bin: string, args: readonly string[]): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: SpawnResult): void => {
      if (settled) return;
      settled = true;
      try {
        clearTimeout(timer);
      } catch {
        // ignore
      }
      resolve(r);
    };

    let child;
    try {
      child = spawn(bin, args as string[], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      settle({
        ok: false,
        cause: 'ERROR',
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let stdout = '';
    let stdoutBytes = 0;
    let capped = false;

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (capped) return;
        stdoutBytes += Buffer.byteLength(chunk, 'utf8');
        if (stdoutBytes > PROBE_STDOUT_CAP_BYTES) {
          capped = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
          return;
        }
        stdout += chunk;
      });
    }

    // audit-added M3: child_process.spawn ENOENT comes via 'error' event.
    child.on('error', (err: NodeJS.ErrnoException) => {
      settle({
        ok: false,
        cause: err && err.code === 'ENOENT' ? 'ENOENT' : 'ERROR',
        err: err?.message,
      });
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      settle({ ok: false, cause: 'TIMEOUT' });
    }, PROBE_TIMEOUT_MS);

    child.once('close', (code: number | null) => {
      if (capped) {
        settle({ ok: false, cause: 'ERROR', err: 'stdout exceeded probe cap' });
        return;
      }
      if (code === 0) {
        settle({ ok: true, exitCode: 0, stdout });
      } else {
        settle({ ok: false, cause: 'EXIT_NONZERO', err: `exit_code=${code}` });
      }
    });
  });
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

// Sibling of runProbe — DO NOT modify runProbe (used by probeNvenc/probeVaInfo).
// Pipes stderr (not stdout); same settled-guard + SIGKILL-on-timeout discipline.
function runEncodeProbe(bin: string, args: readonly string[]): Promise<EncodeProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: EncodeProbeResult): void => {
      if (settled) return;
      settled = true;
      try {
        clearTimeout(timer);
      } catch {
        // ignore
      }
      resolve(r);
    };

    let child;
    try {
      child = spawn(bin, args as string[], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      settle({
        ok: false,
        cause: 'ERROR',
        stderrTail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let stderr = '';
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        // Keep a rolling last-PROBE_STDERR_CAP_BYTES tail (the fatal line is last).
        if (stderr.length > PROBE_STDERR_CAP_BYTES) {
          stderr = stderr.slice(-PROBE_STDERR_CAP_BYTES);
        }
      });
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      settle({
        ok: false,
        cause: err && err.code === 'ENOENT' ? 'ENOENT' : 'ERROR',
        stderrTail: err?.message,
      });
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      settle({ ok: false, cause: 'TIMEOUT' });
    }, PROBE_TIMEOUT_MS);

    child.once('close', (code: number | null) => {
      if (code === 0) {
        settle({ ok: true });
      } else {
        settle({ ok: false, cause: 'EXIT_NONZERO', stderrTail: stderr });
      }
    });
  });
}

// Build the probe argv reusing the REAL codec block (buildCodecBlock) so the
// probe init-path matches the production encode (qsv→hevc_qsv, nvenc→hevc_nvenc,
// vaapi→-vaapi_device+format=nv12,hwupload). `-i` precedes the codec block —
// identical ordering to buildEncodeArgs (audit-verified arg-order faithfulness).
function buildProbeEncodeArgs(encoder: EncoderId, devicePath?: string): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=16x16:rate=1:duration=1',
    ...buildCodecBlock({
      encoder,
      crf: 28,
      preset: DEFAULT_PRESET_BY_ENCODER[encoder],
      devicePath,
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
}

async function probeEncodeFunctional(
  encoder: EncoderId,
  devicePath?: string,
): Promise<ProbeEncodeOutcome> {
  const r = await runEncodeProbe(ffmpegBinary(), buildProbeEncodeArgs(encoder, devicePath));
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

async function findRenderDDevice(): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fsp.readdir('/dev/dri');
  } catch {
    return undefined;
  }
  const match = entries.find((f) => /^renderD\d+$/.test(f));
  return match ? `/dev/dri/${match}` : undefined;
}

// 23-04: backend kill-switch (NOT NEXT_PUBLIC — detection.ts is server-only).
// Read at detection-time (not module-load) so it is honoured on the next
// cache-miss/invalidate after a container restart, and is unit-testable per-case.
// Restart is still required in practice because detection is globalThis-cached.
function isProbeEncodeDisabled(): boolean {
  return process.env.X265_PROBE_ENCODE_DISABLED === '1';
}

async function runDetection(): Promise<DetectionResult> {
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

  // ── Feature-parse (UNCHANGED probes) → produces CANDIDATE set, not final. ──
  const candidates: EncoderId[] = [];

  const nvenc = await probeNvenc();
  if (nvenc.ok) {
    candidates.push('nvenc');
  } else if (nvenc.cause === 'ENOENT' && (await probeNvidiaDevicesPresent())) {
    // Devices passed through but userland missing — actionable for operator.
    warnings.push({
      code: 'nvenc_no_runtime',
      severity: 'warn',
      detail: '/dev/nvidia* present but nvidia-smi binary missing',
    });
  }

  const vaapiDevice = await findRenderDDevice();
  const driPresent = vaapiDevice !== undefined;
  if (driPresent) {
    const probe = await probeVaInfo(driPresent);
    if (probe.qsv) candidates.push('qsv');
    if (probe.vaapi) candidates.push('vaapi');
    if (probe.warning) {
      // 18-02 false-positive suppression: NVIDIA hosts have /dev/dri/* nodes
      // registered by the NVIDIA DRM driver, but vainfo cannot enumerate VA-API
      // entrypoints on them (NVIDIA uses NVENC, not VAAPI). When NVENC was
      // detected, the dri_present_no_driver warning is noise — suppress it.
      // Other warnings (vainfo_binary_missing, qsv_only_legacy_intel) still
      // fire because they remain actionable even on NVIDIA hosts.
      const suppressDri = probe.warning.code === 'dri_present_no_driver' && nvenc.ok;
      if (!suppressDri) {
        warnings.push(probe.warning);
      }
    }
  }

  // ── 23-04 probe-encode gate: detected[] membership is GATED on probe exit=0. ──
  const gateStart = Date.now();
  for (const enc of candidates) {
    if (probeEncodeDisabled) {
      // Kill-switch: revert to feature-parse-only. Nothing was probed, so the
      // honest outcome is 'probe-inconclusive' (audit SR1/SR2 — NOT 'functional').
      detected.push(enc);
      outcome[enc] = 'probe-inconclusive';
      continue;
    }
    const res = await probeEncodeFunctional(enc, enc === 'vaapi' ? vaapiDevice : undefined);
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
  };

  // audit-added S14 (extended 23-04 audit D1): boot-time visibility for operator
  // container logs. probeDurationMs surfaces the un-capped per-probe boot cost.
  logger.info(
    {
      action: 'encoder_detection_complete',
      detected,
      activeFromAuto,
      vaapiDevice,
      warningCount: warnings.length,
      outcome,
      probeEncodeDisabled,
      probeDurationMs,
      durationMs: Date.now() - startMs,
    },
    'encoder detection complete',
  );

  return result;
}

export async function detectEncoders(opts?: { force?: boolean }): Promise<DetectionResult> {
  if (!opts?.force && globalThis.__x265butler_encoder_cache) {
    return globalThis.__x265butler_encoder_cache;
  }
  const result = await runDetection();
  globalThis.__x265butler_encoder_cache = result;
  return result;
}

// audit-added S4: non-test export for the future Settings UI in 03-03.
export function invalidateEncoderCache(): void {
  globalThis.__x265butler_encoder_cache = undefined;
}

// Test-only escape hatch — never exported via the barrel.
export function __forTests_resetEncoderCache(): void {
  globalThis.__x265butler_encoder_cache = undefined;
}
