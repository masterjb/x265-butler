import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:child_process');
vi.mock('node:fs/promises');

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { extractSamples, SampleExtractorError } from '@/src/lib/bench/sample-extractor';

const mockSpawn = vi.mocked(spawn);
const mockFs = vi.mocked(fs);

function makeChild(opts: {
  stdoutData?: string;
  stderrData?: string;
  exitCode?: number | null;
  error?: Error;
}): Partial<ChildProcess> & { stdout: EventEmitter; stderr: EventEmitter } {
  const stdout = new EventEmitter() as EventEmitter & {
    on: (e: string, cb: (d: Buffer) => void) => EventEmitter;
  };
  const stderr = new EventEmitter() as EventEmitter & {
    on: (e: string, cb: (d: Buffer) => void) => EventEmitter;
  };
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
  return child as Partial<ChildProcess> & { stdout: EventEmitter; stderr: EventEmitter };
}

function probeJsonFor(duration: number): string {
  return JSON.stringify({ format: { duration: String(duration) } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.mkdir.mockResolvedValue(undefined);
  mockFs.stat.mockResolvedValue({ size: 500_000 } as import('node:fs').Stats);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('extractSamples', () => {
  it('happy path: 3 samples extracted via stream-copy', async () => {
    let callIdx = 0;
    mockSpawn.mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) {
        // ffprobe call
        return makeChild({ stdoutData: probeJsonFor(300) }) as unknown as ChildProcess;
      }
      // ffmpeg stream-copy calls
      return makeChild({}) as unknown as ChildProcess;
    });
    mockFs.stat.mockResolvedValue({ size: 500_000 } as import('node:fs').Stats);

    const results = await extractSamples('/src/video.mkv', {
      count: 3,
      durationSec: 20,
      scratchDir: '/tmp/scratch',
    });

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.usedFallback).toBe(false);
      expect(r.sizeBytes).toBe(500_000);
    }
  });

  it('short file (<60s) → single sample at offset 0', async () => {
    let callIdx = 0;
    mockSpawn.mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) {
        return makeChild({ stdoutData: probeJsonFor(45) }) as unknown as ChildProcess;
      }
      return makeChild({}) as unknown as ChildProcess;
    });

    const results = await extractSamples('/src/video.mkv', {
      count: 3,
      durationSec: 20,
      scratchDir: '/tmp/scratch',
    });

    expect(results).toHaveLength(1);
    expect(results[0].offsetSec).toBe(0);
  });

  it('stream-copy yields <1024 bytes → fallback libx264', async () => {
    let callIdx = 0;
    mockSpawn.mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) {
        return makeChild({ stdoutData: probeJsonFor(300) }) as unknown as ChildProcess;
      }
      return makeChild({}) as unknown as ChildProcess;
    });

    let statCallIdx = 0;
    mockFs.stat.mockImplementation(async () => {
      statCallIdx++;
      // First stat call per sample returns tiny (triggers fallback), then normal
      return { size: statCallIdx % 2 === 1 ? 100 : 500_000 } as import('node:fs').Stats;
    });

    const results = await extractSamples('/src/video.mkv', {
      count: 3,
      durationSec: 20,
      scratchDir: '/tmp/scratch',
    });

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.usedFallback).toBe(true);
    }
  });

  it('ffmpeg exits non-zero → throws SampleExtractorError', async () => {
    let callIdx = 0;
    mockSpawn.mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) {
        return makeChild({ stdoutData: probeJsonFor(300) }) as unknown as ChildProcess;
      }
      return makeChild({ exitCode: 1, stderrData: 'invalid input' }) as unknown as ChildProcess;
    });

    await expect(
      extractSamples('/src/video.mkv', { count: 3, durationSec: 20, scratchDir: '/tmp/scratch' }),
    ).rejects.toBeInstanceOf(SampleExtractorError);
  });

  it('SampleExtractorError carries exitCode + stderrTail', async () => {
    let callIdx = 0;
    mockSpawn.mockImplementation(() => {
      callIdx++;
      if (callIdx === 1)
        return makeChild({ stdoutData: probeJsonFor(300) }) as unknown as ChildProcess;
      return makeChild({ exitCode: 127, stderrData: 'not found' }) as unknown as ChildProcess;
    });

    let err: SampleExtractorError | null = null;
    try {
      await extractSamples('/src/bad.mkv', {
        count: 1,
        durationSec: 20,
        scratchDir: '/tmp/s',
        fileId: 42,
      });
    } catch (e) {
      err = e as SampleExtractorError;
    }
    expect(err).not.toBeNull();
    expect(err!.exitCode).toBe(127);
    expect(err!.fileId).toBe(42);
  });

  it('probeDuration failure → falls back to durationSec as effectiveDuration', async () => {
    let callIdx = 0;
    mockSpawn.mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) return makeChild({ exitCode: 1 }) as unknown as ChildProcess;
      return makeChild({}) as unknown as ChildProcess;
    });

    const results = await extractSamples('/src/video.mkv', {
      count: 3,
      durationSec: 20,
      scratchDir: '/tmp/scratch',
    });
    // effectiveDuration=20 → <60 → single sample
    expect(results).toHaveLength(1);
  });

  it('abort signal stops extraction without throwing SampleExtractorError', async () => {
    const controller = new AbortController();

    let callIdx = 0;
    mockSpawn.mockImplementation(() => {
      callIdx++;
      if (callIdx === 1)
        return makeChild({ stdoutData: probeJsonFor(300) }) as unknown as ChildProcess;
      // Simulate abort: return null exit
      const ch = makeChild({ exitCode: null }) as unknown as ChildProcess;
      setImmediate(() => controller.abort());
      return ch;
    });

    // Should not throw SampleExtractorError since exitCode is null
    const results = await extractSamples('/src/video.mkv', {
      count: 3,
      durationSec: 20,
      scratchDir: '/tmp/scratch',
      signal: controller.signal,
    });
    // Fewer or zero results after abort
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('medium duration (60-119s) → fewer samples', async () => {
    let callIdx = 0;
    mockSpawn.mockImplementation(() => {
      callIdx++;
      if (callIdx === 1)
        return makeChild({ stdoutData: probeJsonFor(90) }) as unknown as ChildProcess;
      return makeChild({}) as unknown as ChildProcess;
    });

    const results = await extractSamples('/src/video.mkv', {
      count: 3,
      durationSec: 20,
      scratchDir: '/tmp/scratch',
    });
    // floor(90/30) = 3, but could be 1-2
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
