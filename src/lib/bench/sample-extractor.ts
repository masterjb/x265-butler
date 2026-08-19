// 11-01: Sample extraction — ab-av1 3×20s pattern.
// Extracts evenly-spaced video-only samples from a source file via stream-copy.
// Falls back to libx264 re-encode if stream-copy yields a near-empty file
// (keyframe misalignment). ZERO audio in samples (-an flag).

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger';
import { ffmpegBinary, ffprobeBinary } from '../encode/ffmpeg-binary';

export class SampleExtractorError extends Error {
  constructor(
    public readonly fileId: number | string,
    public readonly exitCode: number | null,
    public readonly stderrTail: string,
    message?: string,
  ) {
    super(
      message ??
        `SampleExtractorError: exitCode=${exitCode ?? 'null'}, tail=${stderrTail.slice(-200)}`,
    );
    this.name = 'SampleExtractorError';
  }
}

export interface SampleExtractionResult {
  sampleIdx: number;
  offsetSec: number;
  path: string;
  sizeBytes: number;
  usedFallback: boolean;
}

export interface ExtractSamplesOpts {
  count?: number;
  durationSec?: number;
  scratchDir: string;
  fileId?: number | string;
  signal?: AbortSignal;
}

async function probeDuration(sourcePath: string): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', sourcePath];
    const child = spawn(ffprobeBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { format?: { duration?: string } };
        const d = parseFloat(parsed.format?.duration ?? '');
        resolve(Number.isFinite(d) ? d : null);
      } catch {
        resolve(null);
      }
    });
    child.on('error', () => resolve(null));
  });
}

function computeOffsets(totalDuration: number, count: number, sampleDurationSec: number): number[] {
  if (totalDuration < 60) {
    return [0];
  }
  const clampedCount = totalDuration < 120 ? Math.max(1, Math.floor(totalDuration / 30)) : count;
  const offsets: number[] = [];
  for (let i = 0; i < clampedCount; i++) {
    const frac = (i + 1) / (clampedCount + 1);
    const offset = Math.min(totalDuration * frac, Math.max(0, totalDuration - sampleDurationSec));
    offsets.push(Math.floor(offset));
  }
  return offsets;
}

async function runFfmpeg(
  args: string[],
  signal?: AbortSignal,
  timeoutMs = 60_000,
): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

    let stderrBuf = '';
    const child = spawn(ffmpegBinary(), args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      signal: combined,
    });
    child.stderr.on('data', (d: Buffer) => {
      stderrBuf += d.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stderr: stderrBuf });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      const isAbort =
        err.message?.includes('AbortError') || (err as NodeJS.ErrnoException).code === 'ABORT_ERR';
      resolve({ exitCode: isAbort ? null : -1, stderr: err.message });
    });
  });
}

export async function extractSamples(
  sourcePath: string,
  opts: ExtractSamplesOpts,
): Promise<SampleExtractionResult[]> {
  const count = opts.count ?? 3;
  const durationSec = opts.durationSec ?? 20;
  const fileId = opts.fileId ?? 'unknown';

  const totalDuration = await probeDuration(sourcePath);
  const effectiveDuration = totalDuration ?? durationSec;
  const sampleDuration =
    totalDuration !== null && totalDuration < durationSec ? totalDuration : durationSec;

  const offsets = computeOffsets(effectiveDuration, count, sampleDuration);

  await fs.mkdir(opts.scratchDir, { recursive: true });

  const results: SampleExtractionResult[] = [];

  for (let idx = 0; idx < offsets.length; idx++) {
    const offset = offsets[idx];
    const samplePath = path.join(opts.scratchDir, `sample-${idx}.mkv`);

    const streamCopyArgs = [
      '-ss',
      String(offset),
      '-i',
      sourcePath,
      '-t',
      String(sampleDuration),
      '-c',
      'copy',
      '-avoid_negative_ts',
      'make_zero',
      '-map',
      '0:v:0',
      '-an',
      '-y',
      samplePath,
    ];

    const { exitCode, stderr } = await runFfmpeg(streamCopyArgs, opts.signal, 60_000);
    if (exitCode !== 0 && exitCode !== null) {
      throw new SampleExtractorError(fileId, exitCode, stderr);
    }

    let stat = await fs.stat(samplePath).catch(() => null);
    let usedFallback = false;

    if (!stat || stat.size < 1024) {
      const originalSize = stat?.size ?? 0;
      logger.warn({
        action: 'bench_sample_streamcopy_fallback',
        fileId,
        sampleIdx: idx,
        offsetSec: offset,
        originalSize,
      });

      const fallbackArgs = [
        '-ss',
        String(offset),
        '-i',
        sourcePath,
        '-t',
        String(sampleDuration),
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '18',
        '-an',
        '-y',
        samplePath,
      ];
      const fallback = await runFfmpeg(fallbackArgs, opts.signal, 60_000);
      if (fallback.exitCode !== 0 && fallback.exitCode !== null) {
        throw new SampleExtractorError(fileId, fallback.exitCode, fallback.stderr);
      }
      stat = await fs.stat(samplePath).catch(() => null);
      usedFallback = true;
    }

    results.push({
      sampleIdx: idx,
      offsetSec: offset,
      path: samplePath,
      sizeBytes: stat?.size ?? 0,
      usedFallback,
    });
  }

  return results;
}
