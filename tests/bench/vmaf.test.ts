import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:child_process');
vi.mock('node:fs/promises');

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import {
  computeVmaf,
  encodeForBench,
  probeLibvmafAvailability,
  VmafComputeError,
} from '@/src/lib/bench/vmaf';

const mockSpawn = vi.mocked(spawn);
const mockFs = vi.mocked(fs);

function makeChild(opts: {
  stdoutData?: string;
  stderrData?: string;
  exitCode?: number | null;
  error?: Error;
}): unknown {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as unknown as ChildProcess & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  (child as { stdout: EventEmitter }).stdout = stdout;
  (child as { stderr: EventEmitter }).stderr = stderr;

  setImmediate(() => {
    if (opts.stdoutData) stdout.emit('data', Buffer.from(opts.stdoutData));
    if (opts.stderrData) stderr.emit('data', Buffer.from(opts.stderrData));
    if (opts.error) {
      child.emit('error', opts.error);
    } else {
      child.emit('close', opts.exitCode ?? 0);
    }
  });
  return child;
}

const VMAF_JSON = JSON.stringify({
  pooled_metrics: {
    vmaf: { mean: 87.5, min: 82.0, harmonic_mean: 86.9 },
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.readFile.mockResolvedValue(VMAF_JSON);
  mockFs.unlink.mockResolvedValue(undefined);
  mockFs.stat.mockResolvedValue({ size: 200_000 } as import('node:fs').Stats);
});

describe('computeVmaf', () => {
  it('happy path: parses pooled_metrics and returns vmafMean/Min/HarmonicMean', async () => {
    mockSpawn.mockReturnValue(makeChild({}) as ReturnType<typeof spawn>);

    const result = await computeVmaf('/ref.mkv', '/dist.mkv', { durationSec: 20 });

    expect(result.vmafMean).toBeCloseTo(87.5);
    expect(result.vmafMin).toBeCloseTo(82.0);
    expect(result.vmafHarmonicMean).toBeCloseTo(86.9);
  });

  it('ffmpeg exits non-zero → throws VmafComputeError', async () => {
    mockSpawn.mockReturnValue(
      makeChild({ exitCode: 1, stderrData: 'bad filter' }) as ReturnType<typeof spawn>,
    );

    await expect(computeVmaf('/ref.mkv', '/dist.mkv')).rejects.toBeInstanceOf(VmafComputeError);
  });

  it('NaN vmaf_mean → throws VmafComputeError', async () => {
    mockFs.readFile.mockResolvedValue(JSON.stringify({ pooled_metrics: { vmaf: { mean: null } } }));
    mockSpawn.mockReturnValue(makeChild({}) as ReturnType<typeof spawn>);

    await expect(computeVmaf('/ref.mkv', '/dist.mkv')).rejects.toBeInstanceOf(VmafComputeError);
  });

  it('malformed JSON → throws VmafComputeError', async () => {
    mockFs.readFile.mockResolvedValue('not-json{{');
    mockSpawn.mockReturnValue(makeChild({}) as ReturnType<typeof spawn>);

    await expect(computeVmaf('/ref.mkv', '/dist.mkv')).rejects.toBeInstanceOf(VmafComputeError);
  });

  it('unlink called in finally even on error', async () => {
    mockSpawn.mockReturnValue(makeChild({ exitCode: 1 }) as ReturnType<typeof spawn>);

    await expect(computeVmaf('/ref.mkv', '/dist.mkv')).rejects.toBeInstanceOf(VmafComputeError);
    expect(mockFs.unlink).toHaveBeenCalled();
  });

  it('spawn error (e.g. ffmpeg not found) → throws VmafComputeError', async () => {
    mockSpawn.mockReturnValue(
      makeChild({ error: new Error('ENOENT') }) as ReturnType<typeof spawn>,
    );

    await expect(computeVmaf('/ref.mkv', '/dist.mkv')).rejects.toBeInstanceOf(VmafComputeError);
  });
});

describe('probeLibvmafAvailability', () => {
  it('returns true when ffmpeg -filters output contains libvmaf', async () => {
    mockSpawn.mockReturnValue(
      makeChild({ stdoutData: '... libvmaf ...' }) as ReturnType<typeof spawn>,
    );

    const result = await probeLibvmafAvailability();
    expect(result).toBe(true);
  });

  it('returns false when output does not contain libvmaf', async () => {
    mockSpawn.mockReturnValue(
      makeChild({ stdoutData: 'scale overlay drawtext' }) as ReturnType<typeof spawn>,
    );

    const result = await probeLibvmafAvailability();
    expect(result).toBe(false);
  });

  it('returns false on spawn error', async () => {
    mockSpawn.mockReturnValue(
      makeChild({ error: new Error('ENOENT') }) as ReturnType<typeof spawn>,
    );

    const result = await probeLibvmafAvailability();
    expect(result).toBe(false);
  });
});

describe('encodeForBench', () => {
  it('returns sizeBytes + encodeSec on success', async () => {
    mockSpawn.mockReturnValue(makeChild({}) as ReturnType<typeof spawn>);
    mockFs.stat.mockResolvedValue({ size: 123_456 } as import('node:fs').Stats);

    const result = await encodeForBench({
      inputPath: '/in.mkv',
      outputPath: '/out.mkv',
      encoder: 'libx265',
      preset: 'medium',
      crf: 28,
    });

    expect(result.sizeBytes).toBe(123_456);
    expect(result.encodeSec).toBeGreaterThanOrEqual(0);
  });

  it('ffmpeg failure → throws Error', async () => {
    mockSpawn.mockReturnValue(
      makeChild({ exitCode: 1, stderrData: 'encode failed' }) as ReturnType<typeof spawn>,
    );

    await expect(
      encodeForBench({
        inputPath: '/in.mkv',
        outputPath: '/out.mkv',
        encoder: 'libx265',
        preset: null,
        crf: 28,
      }),
    ).rejects.toThrow(/bench-encode exited 1/);
  });

  it('test_encodeForBench_when_vaapi_passes_codec_block_with_device_and_filter (HW-bench-fix regression)', async () => {
    mockSpawn.mockReturnValue(makeChild({}) as ReturnType<typeof spawn>);
    mockFs.stat.mockResolvedValue({ size: 100_000 } as import('node:fs').Stats);

    await encodeForBench({
      inputPath: '/in.mkv',
      outputPath: '/out.mkv',
      encoder: 'vaapi',
      preset: 'slow',
      crf: 23,
    });

    const args = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain('-vaapi_device');
    expect(args).toContain('-vf');
    expect(args.find((a) => a === 'format=nv12,hwupload')).toBeDefined();
    expect(args).toContain('-c:v');
    expect(args).toContain('hevc_vaapi');
    expect(args).toContain('-rc_mode');
    expect(args).toContain('CQP');
    expect(args).toContain('-qp');
    expect(args).toContain('23');
  });

  it('test_encodeForBench_when_qsv_passes_codec_block_with_global_quality (HW-bench-fix regression)', async () => {
    mockSpawn.mockReturnValue(makeChild({}) as ReturnType<typeof spawn>);
    mockFs.stat.mockResolvedValue({ size: 100_000 } as import('node:fs').Stats);

    await encodeForBench({
      inputPath: '/in.mkv',
      outputPath: '/out.mkv',
      encoder: 'qsv',
      preset: 'slow',
      crf: 22,
    });

    const args = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain('-c:v');
    expect(args).toContain('hevc_qsv');
    expect(args).toContain('-global_quality');
    expect(args).toContain('22');
    // 25-02: look_ahead removed (libvpl/oneVPL rejects MSDK-only option).
    expect(args).not.toContain('-look_ahead');
  });

  it('test_encodeForBench_when_nvenc_passes_codec_block_with_qp (HW-bench-fix regression)', async () => {
    mockSpawn.mockReturnValue(makeChild({}) as ReturnType<typeof spawn>);
    mockFs.stat.mockResolvedValue({ size: 100_000 } as import('node:fs').Stats);

    await encodeForBench({
      inputPath: '/in.mkv',
      outputPath: '/out.mkv',
      encoder: 'nvenc',
      preset: 'p5',
      crf: 26,
    });

    const args = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain('-c:v');
    expect(args).toContain('hevc_nvenc');
    expect(args).toContain('-rc');
    expect(args).toContain('constqp');
    expect(args).toContain('-qp');
    expect(args).toContain('26');
  });

  // 35-01 AC-6: the bench path NEVER threads a crop (no crop param on
  // encodeForBench → buildCodecBlock crop undefined) so the bench-encode argv is
  // byte-identical to pre-35 and computeVmaf compares like-for-like frames. This
  // holds REGARDLESS of auto_crop being on for the production encode.
  it.each(['libx265', 'nvenc', 'qsv', 'vaapi'] as const)(
    'AC-6: bench argv carries NO crop token (%s)',
    async (encoder) => {
      mockSpawn.mockReturnValue(makeChild({}) as ReturnType<typeof spawn>);
      mockFs.stat.mockResolvedValue({ size: 100_000 } as import('node:fs').Stats);

      await encodeForBench({
        inputPath: '/in.mkv',
        outputPath: '/out.mkv',
        encoder,
        preset: 'slow',
        crf: 23,
      });

      const args = mockSpawn.mock.calls[0]?.[1] as string[];
      expect(args.join(' ')).not.toContain('crop=');
    },
  );
});
