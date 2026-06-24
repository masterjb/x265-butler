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
  DEFAULT_PRESET_BY_ENCODER,
  PROBE_FRAME_SIZE,
  detectEncoders,
  type EncoderId,
  type QsvRateControl,
} from '@/src/lib/encode';
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
// crf:28 mirrors the 23-04 probe: this is a functional pass/fail check, the
// quality value is irrelevant. The test envelope (testsrc 320x240 per the 21-02
// NVENC-minimum boundary-deviation, 5s, `-f null /dev/null`) is preserved.
// devicePath is threaded to buildCodecBlock so the operator test-encode probes
// the SAME discovered /dev/dri/renderD* node as the boot-probe + production
// encode (a no-op for nvenc/qsv/libx265 — only the vaapi block reads it).
// 30-01 (SR-3): qsvRateControl is THREADED in (NOT global-read) so this pure
// 24-02 builder keeps its deterministic unit test. runTestEncode passes the
// detection-validated det.qsvRateControl; undefined ⇒ buildCodecBlock's
// 'icq-full' default. No-op for nvenc/vaapi/libx265.
export function buildTestEncodeArgs(
  encoder: EncoderId,
  devicePath?: string,
  qsvRateControl?: QsvRateControl,
): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'info',
    '-y',
    '-f',
    'lavfi',
    '-i',
    // 21-02 UAT-finding: 128x72 < hevc_nvenc minimum frame dimensions (NVENC HEVC
    // requires ≥144x144 on Maxwell+, ≥256x256 on older GPUs per NVENC SDK docs).
    // Bumped to 320x240 — safely above all NVENC minimums, still no PII, multiple-of-2
    // width+height, classic test-pattern aspect-ratio. Boundary-deviation 21-02.
    // 29-01: the value now lives in the shared PROBE_FRAME_SIZE const (profiles.ts),
    // also consumed by the detection boot-probe so the two can never drift apart.
    `testsrc=size=${PROBE_FRAME_SIZE}:rate=1:duration=5`,
    ...buildCodecBlock({
      encoder,
      crf: 28,
      preset: DEFAULT_PRESET_BY_ENCODER[encoder],
      devicePath,
      qsvRateControl,
    }),
    '-t',
    '5',
    '-f',
    'null',
    '/dev/null',
  ];
}

export interface RunTestEncodeOptions {
  ffmpegPath: string;
  timeoutMs?: number;
}

export type TestEncodeAuditOutcome = 'success' | 'failed' | 'killed_timeout';

export interface RunTestEncodeResult {
  body: TestEncodeOutcome;
  auditOutcome: TestEncodeAuditOutcome;
}

export async function runTestEncode(opts: RunTestEncodeOptions): Promise<RunTestEncodeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const det = await detectEncoders();
  // encoderPicked stays the ffmpeg codec string for body.encoderPicked +
  // mapTestEncodeError (AC-4). The argv now comes from the shared builder.
  const encoderPicked = mapEncoderIdToFfmpegCodec(det.activeFromAuto);

  // 24-02 F4: thread the DISCOVERED det.vaapiDevice (same field the boot-probe at
  // detection.ts:534 and the production encode at ffmpeg.ts:110 consume) — NOT the
  // hardcoded DEFAULT_VAAPI_DEVICE. The 1-arg form would probe the wrong node on
  // any host whose VAAPI device is renderD129+, re-introducing the exact
  // false-negative mis-diagnosis this fix exists to kill. Harmless no-op for
  // nvenc/qsv/libx265 (only the vaapi codec block reads it).
  // 30-01: thread the detection-validated qsv variant (SR-3 — no global-read in
  // the pure builder). No-op for nvenc/vaapi/libx265.
  const args = buildTestEncodeArgs(det.activeFromAuto, det.vaapiDevice, det.qsvRateControl);

  const startedAt = performance.now();
  const child = spawn(opts.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

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
    },
    auditOutcome,
  };
}
