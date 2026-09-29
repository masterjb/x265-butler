// 11-01: VMAF computation via libvmaf ffmpeg filter.
// libvmaf baked into ffmpeg via P10 BtbN static binary (Docker context).
// Tests mock spawn; probeLibvmafAvailability() used by API pre-flight.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { ffmpegBinary } from '../encode/ffmpeg-binary';
import { buildCodecBlock, DEFAULT_PRESET_BY_ENCODER, type EncoderId } from '../encode/profiles';
// 30-01: bench-verify reads the SAME validated qsv variant as production buildArgs
// so the two codepaths stay byte-identical (11-03 SR3). detection.ts is acyclic here.
import { getActiveQsvRateControl } from '../encode/detection';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class VmafComputeError extends Error {
  constructor(
    public readonly distortedPath: string,
    public readonly referencePath: string,
    public readonly rawJsonTail: string,
  ) {
    super(`VmafComputeError: vmaf_mean is not finite. json-tail=${rawJsonTail.slice(-200)}`);
    this.name = 'VmafComputeError';
  }
}

export interface VmafResult {
  vmafMean: number;
  vmafMin: number;
  vmafHarmonicMean: number;
}

export interface ComputeVmafOpts {
  model?: string;
  nThreads?: number;
  signal?: AbortSignal;
  durationSec?: number;
  // 11-02-FIX (UAT-001): per-phase progress callback for live bar motion.
  // phasePct ∈ [0, 100] derived from ffmpeg -progress out_time_ms (microseconds)
  // divided by (durationSec * 1_000_000). Single divide site — see audit M1.
  onProgress?: (phasePct: number) => void;
}

// 11-02-FIX: minimal -progress pipe:1 stdout parser for bench-channel.
// ffmpeg emits "out_time_ms=NNN\n" lines (microseconds despite the "ms" suffix).
// We compute phasePct = round(min(100, us / 1_000_000 / durationSec * 100)).
// Returns parser that consumes chunks from ffmpeg stdout pipe.
function makeBenchProgressParser(
  durationSec: number,
  onProgress: (phasePct: number) => void,
): (chunk: Buffer) => void {
  let buf = '';
  return (chunk: Buffer): void => {
    buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq);
      if (key !== 'out_time_ms') continue;
      const us = Number.parseInt(line.slice(eq + 1), 10);
      if (!Number.isFinite(us) || durationSec <= 0) continue;
      // Single divide by 1_000_000 (us → s). NO second /1000 — audit M1.
      const pct = Math.min(100, Math.round((us / 1_000_000 / durationSec) * 100));
      onProgress(pct);
    }
  };
}

export async function computeVmaf(
  referencePath: string,
  distortedPath: string,
  opts: ComputeVmafOpts = {},
): Promise<VmafResult> {
  const model = opts.model ?? 'vmaf_v0.6.1';
  const nThreads = opts.nThreads ?? 4;
  const timeoutMs = (opts.durationSec ?? 20) * 5 * 1000;

  const jsonPath = path.join(os.tmpdir(), `vmaf-${randomUUID()}.json`);

  const lavfi = `[0:v][1:v]libvmaf=model=version=${model}:n_threads=${nThreads}:log_fmt=json:log_path=${jsonPath}`;
  // 11-02-FIX: -progress pipe:1 -nostats added unconditionally; stdout piped if onProgress wired.
  const args = ['-i', distortedPath, '-i', referencePath, '-lavfi', lavfi];
  if (opts.onProgress) args.push('-progress', 'pipe:1', '-nostats');
  args.push('-f', 'null', '-');

  let jsonContent = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const signal = opts.signal
        ? AbortSignal.any([opts.signal, controller.signal])
        : controller.signal;

      let stderrBuf = '';
      const stdio: ['ignore', 'pipe' | 'ignore', 'pipe'] = opts.onProgress
        ? ['ignore', 'pipe', 'pipe']
        : ['ignore', 'ignore', 'pipe'];
      const child = spawn(ffmpegBinary(), args, { stdio, signal });
      if (opts.onProgress && child.stdout) {
        const parser = makeBenchProgressParser(opts.durationSec ?? 20, opts.onProgress);
        child.stdout.on('data', parser);
      }
      child.stderr?.on('data', (d: Buffer) => {
        stderrBuf += d.toString('utf8');
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new VmafComputeError(distortedPath, referencePath, stderrBuf));
        } else {
          resolve();
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new VmafComputeError(distortedPath, referencePath, err.message));
      });
    });

    jsonContent = await fs.readFile(jsonPath, 'utf8');

    interface VmafJson {
      pooled_metrics?: {
        vmaf?: { mean?: number; min?: number; harmonic_mean?: number };
      };
    }

    let parsed: VmafJson;
    try {
      parsed = JSON.parse(jsonContent) as VmafJson;
    } catch {
      throw new VmafComputeError(distortedPath, referencePath, jsonContent);
    }

    const vmafMean = parsed.pooled_metrics?.vmaf?.mean;
    const vmafMin = parsed.pooled_metrics?.vmaf?.min ?? vmafMean ?? NaN;
    const vmafHarmonicMean = parsed.pooled_metrics?.vmaf?.harmonic_mean ?? vmafMean ?? NaN;

    if (!Number.isFinite(vmafMean)) {
      throw new VmafComputeError(distortedPath, referencePath, jsonContent);
    }

    return { vmafMean: vmafMean!, vmafMin, vmafHarmonicMean };
  } finally {
    fs.unlink(jsonPath).catch(() => undefined);
  }
}

export async function probeLibvmafAvailability(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(ffmpegBinary(), ['-hide_banner', '-filters'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.on('close', () => {
      resolve(stdout.includes('libvmaf'));
    });
    child.on('error', () => {
      resolve(false);
    });
  });
}

export async function encodeForBench(opts: {
  inputPath: string;
  outputPath: string;
  // HW-bench-fix: callers now pass production EncoderId (libx265/nvenc/qsv/vaapi).
  // Bench DB stores ffmpeg-encoder-names ("hevc_vaapi" etc.) so callers must
  // normalize via normalizeBenchEncoderToProductionId() at the boundary first.
  // Internal pre-fix shape (`encoder: string` + `nativeQualityParam` + literal
  // `-c:v <name>`) bypassed buildCodecBlock — VAAPI/QSV invocations missed
  // `-vaapi_device`/`-init_hw_device`/`-vf format=nv12,hwupload`/`-rc_mode CQP`
  // etc. and ffmpeg failed at spawn → markComboFailed on every HW combo.
  encoder: EncoderId;
  preset?: string | null;
  // crf carries the encoder-native quality value (CRF for libx265, CQ for
  // nvenc, global_quality for qsv, QP for vaapi). buildCodecBlock owns the
  // flag-name dispatch; nativeQualityParam is no longer needed at this layer.
  crf: number;
  vaapiDevice?: string;
  signal?: AbortSignal;
  // 11-02-FIX (UAT-001): per-phase progress callback for live bar motion.
  // durationSec MUST be provided when onProgress is wired (sample-length anchor).
  onProgress?: (phasePct: number) => void;
  durationSec?: number;
}): Promise<{ sizeBytes: number; encodeSec: number }> {
  const { inputPath, outputPath, encoder, crf } = opts;
  const preset = opts.preset ?? DEFAULT_PRESET_BY_ENCODER[encoder];

  const codecBlock = buildCodecBlock({
    encoder,
    crf,
    preset,
    devicePath: opts.vaapiDevice,
    // 30-01: thread the detection-validated qsv variant (no-op for other encoders).
    qsvRateControl: encoder === 'qsv' ? getActiveQsvRateControl() : undefined,
  });
  const args: string[] = ['-i', inputPath, ...codecBlock];
  // 11-02-FIX: -progress pipe:1 -nostats only when onProgress wired (else preserve pre-FIX behavior).
  if (opts.onProgress) args.push('-progress', 'pipe:1', '-nostats');
  args.push('-an', '-y', outputPath);

  const start = Date.now();

  await new Promise<void>((resolve, reject) => {
    let stderrBuf = '';
    const stdio: ['ignore', 'pipe' | 'ignore', 'pipe'] = opts.onProgress
      ? ['ignore', 'pipe', 'pipe']
      : ['ignore', 'ignore', 'pipe'];
    const child = spawn(ffmpegBinary(), args, {
      stdio,
      signal: opts.signal,
    });
    if (opts.onProgress && child.stdout) {
      const parser = makeBenchProgressParser(opts.durationSec ?? 20, opts.onProgress);
      child.stdout.on('data', parser);
    }
    child.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString('utf8');
    });
    child.on('close', (code) => {
      if (code !== 0)
        reject(new Error(`ffmpeg bench-encode exited ${code ?? 'null'}: ${stderrBuf.slice(-500)}`));
      else resolve();
    });
    child.on('error', (err) => reject(err));
  });

  const encodeSec = (Date.now() - start) / 1000;
  const stat = await fs.stat(outputPath);
  return { sizeBytes: stat.size, encodeSec };
}
