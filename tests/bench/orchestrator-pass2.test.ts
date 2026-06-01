// 11-03 T2 verify: orchestrator.runFullFileVerify + cancelPass2 + 4 SSE events.
// Covers AC-3 + AC-10 + audit gates M3 (finally cleanup) / M4 (pino lifecycle) /
// SR2 (cancel) / SR4 (monotonic overallPct) / SR5 (errorReason sanitization).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/src/lib/bench/vmaf', () => ({
  encodeForBench: vi.fn(),
  computeVmaf: vi.fn(),
}));
vi.mock('@/src/lib/bench/sample-extractor', () => ({
  extractSamples: vi.fn(),
  SampleExtractorError: class SampleExtractorError extends Error {},
}));
vi.mock('@/src/lib/encode/ffmpeg', () => ({
  runEncode: vi.fn(),
  buildArgs: vi.fn(() => []),
}));
vi.mock('@/src/lib/db', () => ({
  benchRunRepo: vi.fn(),
  benchComboRepo: vi.fn(),
  fileRepo: () => ({
    getById: vi.fn().mockReturnValue({ id: 10, path: '/media/big.mkv' }),
  }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));
vi.mock('node:fs/promises');

import fs from 'node:fs/promises';
import { BenchOrchestrator, sanitizePass2ErrorMessage } from '@/src/lib/bench/orchestrator';
import { computeVmaf } from '@/src/lib/bench/vmaf';
import { runEncode } from '@/src/lib/encode/ffmpeg';
import {
  engineEvents,
  __forTests_resetEngineEvents,
  type EngineEvent,
} from '@/src/lib/encode/events';
import { logger } from '@/src/lib/logger';
import type { BenchRunRow, BenchComboRow } from '@/src/lib/db/schema';

const mockFs = vi.mocked(fs);
const mockRunEncode = vi.mocked(runEncode);
const mockVmaf = vi.mocked(computeVmaf);

function makeRunRow(overrides: Partial<BenchRunRow> = {}): BenchRunRow {
  return {
    id: 1,
    status: 'complete',
    mode: 'native-sweep',
    matrix: { encoders: ['libx265'], presets: ['medium'], nativeValues: [28] },
    fileIds: [10],
    sample_count: 3,
    sample_duration_seconds: 20,
    vmaf_buckets_json: null,
    vmaf_model: 'vmaf_v0.6.1',
    actor_id: null,
    version: 1,
    created_at: 1000,
    started_at: 1001,
    completed_at: 2000,
    error_reason: null,
    ...overrides,
  };
}

function makeComboRow(overrides: Partial<BenchComboRow> = {}): BenchComboRow {
  return {
    id: 42,
    run_id: 1,
    file_id: 10,
    encoder: 'libx265',
    preset: 'medium',
    native_quality_param: '-crf',
    native_quality_value: 23,
    vmaf_target: null,
    sample_idx: 0,
    vmaf: 90,
    size_bytes: 1000,
    encode_seconds: 5,
    source_sample_bytes: 2000,
    pass2_vmaf: null,
    pass2_size_bytes: null,
    pass2_encode_seconds: null,
    pass2_completed_at: null,
    status: 'complete',
    error_reason: null,
    is_pareto: 1,
    top3_role: 'balanced',
    created_at: 1000,
    completed_at: 1500,
    ...overrides,
  };
}

function makeOrch(run: BenchRunRow, combo: BenchComboRow) {
  const benchRunRepo = {
    findById: vi.fn().mockReturnValue(run),
  };
  const benchComboRepo = {
    findById: vi.fn().mockReturnValue(combo),
    markPass2Complete: vi.fn(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orch = new BenchOrchestrator(benchRunRepo as any, benchComboRepo as any);
  return { orch, benchRunRepo, benchComboRepo };
}

function captureEvents(): EngineEvent[] {
  const events: EngineEvent[] = [];
  engineEvents.subscribe((ev) => events.push(ev));
  return events;
}

beforeEach(() => {
  __forTests_resetEngineEvents();
  mockRunEncode.mockReset();
  mockVmaf.mockReset();
  mockFs.mkdir.mockResolvedValue(undefined);
  mockFs.rm.mockResolvedValue(undefined);
  mockFs.stat.mockResolvedValue({ size: 4_500_000_000 } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sanitizePass2ErrorMessage (SR5)', () => {
  it('strips absolute filesystem paths', () => {
    const out = sanitizePass2ErrorMessage(
      'ffmpeg failed at /var/lib/x265-butler/scratch/out.mkv reading from /mnt/cache/movies/x.mkv',
    );
    expect(out).not.toContain('/var/lib');
    expect(out).not.toContain('/mnt/cache');
    expect(out).toContain('<path>');
  });

  it('strips pid values', () => {
    expect(sanitizePass2ErrorMessage('ffmpeg crashed pid=12345')).toContain('pid=<n>');
  });

  it('strips env-style variables', () => {
    expect(sanitizePass2ErrorMessage('PATH=$HOME/bin/ffmpeg broke')).toContain('<env>');
  });

  it('caps reason at 500 chars', () => {
    const long = 'x'.repeat(2000);
    expect(sanitizePass2ErrorMessage(long).length).toBeLessThanOrEqual(500);
  });
});

describe('BenchOrchestrator.runFullFileVerify (AC-3)', () => {
  it('happy path: emits started → complete + writes markPass2Complete', async () => {
    const run = makeRunRow();
    const combo = makeComboRow();
    const { orch, benchComboRepo } = makeOrch(run, combo);
    const events = captureEvents();
    mockRunEncode.mockResolvedValue({ exitCode: 0, durationMs: 1000, logTail: '' });
    mockVmaf.mockResolvedValue({ vmafMean: 92.5, vmafMin: 91, vmafHarmonicMean: 92 });

    await orch.runFullFileVerify(1, 42);

    expect(benchComboRepo.markPass2Complete).toHaveBeenCalledTimes(1);
    const writeArgs = benchComboRepo.markPass2Complete.mock.calls[0];
    expect(writeArgs[0]).toBe(42);
    expect(writeArgs[1].vmaf).toBeCloseTo(92.5, 2);
    expect(writeArgs[1].sizeBytes).toBe(4_500_000_000);

    const started = events.find((e) => e.type === 'bench.pass2_started');
    const complete = events.find((e) => e.type === 'bench.pass2_complete');
    expect(started).toBeDefined();
    expect(complete).toBeDefined();
  });

  it('rejects when pass2_completed_at already set (one-shot semantics)', async () => {
    const run = makeRunRow();
    const combo = makeComboRow({ pass2_completed_at: 1700000000 });
    const { orch } = makeOrch(run, combo);
    await expect(orch.runFullFileVerify(1, 42)).rejects.toThrow(/already verified/);
  });

  it('rejects with pass2_busy when lock held (AC-4 contract)', async () => {
    const run = makeRunRow();
    const combo = makeComboRow();
    const { orch } = makeOrch(run, combo);
    // First call hangs on encode
    let releaseEncode!: () => void;
    mockRunEncode.mockImplementation(
      () =>
        new Promise<{ exitCode: number; durationMs: number; logTail: string }>((resolve) => {
          releaseEncode = () => resolve({ exitCode: 0, durationMs: 1, logTail: '' });
        }),
    );
    mockVmaf.mockResolvedValue({ vmafMean: 90, vmafMin: 88, vmafHarmonicMean: 89 });

    const first = orch.runFullFileVerify(1, 42);
    await new Promise((r) => setImmediate(r));
    // Second call must reject as pass2_busy without engaging encode
    await expect(orch.runFullFileVerify(1, 42)).rejects.toThrow(/pass2_busy/);
    releaseEncode();
    await first;
  });

  it('rejects when run.status !== complete', async () => {
    const run = makeRunRow({ status: 'running' });
    const combo = makeComboRow();
    const { orch } = makeOrch(run, combo);
    await expect(orch.runFullFileVerify(1, 42)).rejects.toThrow(/expected complete/);
  });

  it('rejects when combo.run_id !== runId', async () => {
    const run = makeRunRow();
    const combo = makeComboRow({ run_id: 999 });
    const { orch } = makeOrch(run, combo);
    await expect(orch.runFullFileVerify(1, 42)).rejects.toThrow(/belongs to run 999/);
  });
});

// 11-03 UAT regression: bench DB encoder strings are ffmpeg-encoder-names
// ("hevc_nvenc"/"hevc_qsv"/"hevc_vaapi"/"libx265") but production EncoderId
// is the internal short-form ("nvenc"/"qsv"/"vaapi"/"libx265"). runEncode
// dispatches via EncoderId → buildCodecBlock throws "unknown encoder" on
// the raw bench string. Fix: normalize at orchestrator boundary.
describe('runFullFileVerify encoder-name normalization (UAT regression)', () => {
  it('test_runEncode_called_with_internal_EncoderId_when_combo_encoder_is_hevc_nvenc', async () => {
    const run = makeRunRow();
    const combo = makeComboRow({ encoder: 'hevc_nvenc' });
    const { orch } = makeOrch(run, combo);
    mockRunEncode.mockResolvedValue({ exitCode: 0, durationMs: 1, logTail: '' });
    mockVmaf.mockResolvedValue({ vmafMean: 90, vmafMin: 88, vmafHarmonicMean: 89 });

    await orch.runFullFileVerify(1, 42);

    expect(mockRunEncode).toHaveBeenCalledTimes(1);
    const opts = mockRunEncode.mock.calls[0][0];
    expect(opts.encoder).toBe('nvenc');
  });

  it('test_runEncode_called_with_qsv_when_combo_encoder_is_hevc_qsv', async () => {
    const run = makeRunRow();
    const combo = makeComboRow({ encoder: 'hevc_qsv' });
    const { orch } = makeOrch(run, combo);
    mockRunEncode.mockResolvedValue({ exitCode: 0, durationMs: 1, logTail: '' });
    mockVmaf.mockResolvedValue({ vmafMean: 90, vmafMin: 88, vmafHarmonicMean: 89 });

    await orch.runFullFileVerify(1, 42);
    expect(mockRunEncode.mock.calls[0][0].encoder).toBe('qsv');
  });

  it('test_runEncode_called_with_vaapi_when_combo_encoder_is_hevc_vaapi', async () => {
    const run = makeRunRow();
    const combo = makeComboRow({ encoder: 'hevc_vaapi' });
    const { orch } = makeOrch(run, combo);
    mockRunEncode.mockResolvedValue({ exitCode: 0, durationMs: 1, logTail: '' });
    mockVmaf.mockResolvedValue({ vmafMean: 90, vmafMin: 88, vmafHarmonicMean: 89 });

    await orch.runFullFileVerify(1, 42);
    expect(mockRunEncode.mock.calls[0][0].encoder).toBe('vaapi');
  });

  it('test_runEncode_called_with_libx265_when_combo_encoder_is_libx265_passthrough', async () => {
    const run = makeRunRow();
    const combo = makeComboRow({ encoder: 'libx265' });
    const { orch } = makeOrch(run, combo);
    mockRunEncode.mockResolvedValue({ exitCode: 0, durationMs: 1, logTail: '' });
    mockVmaf.mockResolvedValue({ vmafMean: 90, vmafMin: 88, vmafHarmonicMean: 89 });

    await orch.runFullFileVerify(1, 42);
    expect(mockRunEncode.mock.calls[0][0].encoder).toBe('libx265');
  });
});

// 11-03 UAT regression: computeVmaf default timeout is durationSec * 5 * 1000;
// without an explicit durationSec, it defaults to 100s — fatally short for
// full-file Pass-2 VMAF compute on movie-length sources. Fix passes the
// file's duration_seconds (with generous fallback when missing).
describe('runFullFileVerify VMAF-timeout regression (UAT)', () => {
  it('test_computeVmaf_receives_file_duration_seconds_so_timeout_scales_with_source', async () => {
    const run = makeRunRow();
    const combo = makeComboRow();
    const { orch } = makeOrch(run, combo);
    mockRunEncode.mockResolvedValue({ exitCode: 0, durationMs: 1, logTail: '' });
    mockVmaf.mockResolvedValue({ vmafMean: 90, vmafMin: 88, vmafHarmonicMean: 89 });

    await orch.runFullFileVerify(1, 42);
    // fileRepo mock returns { id: 10, path: '/media/big.mkv' } — without
    // duration_seconds. Orchestrator must fall back to a generous default
    // (≥ 600s so timeout ≥ 3000s — survives any reasonable movie length).
    const opts = mockVmaf.mock.calls[0][2];
    expect(opts?.durationSec).toBeGreaterThanOrEqual(600);
  });
});

describe('runFullFileVerify (AC-10 SSE contract + SR4 monotonic)', () => {
  it('overallPct is monotonic non-decreasing across encode→vmaf', async () => {
    const run = makeRunRow();
    const combo = makeComboRow();
    const { orch } = makeOrch(run, combo);
    const events: EngineEvent[] = [];
    engineEvents.subscribe((ev) => events.push(ev));

    // Drive several encode progress emits + several vmaf emits
    mockRunEncode.mockImplementation(async (opts) => {
      // Simulate progress ticks: ffmpeg parser would normally emit a chain
      opts.onProgress?.({
        frame: 100,
        fps: 30,
        outTimeMs: 1000,
        totalSize: 1,
        progress: 'continue',
      });
      // Throttle is 1Hz — back-to-back calls collapse to one emit
      await new Promise((r) => setTimeout(r, 1100));
      opts.onProgress?.({ frame: 200, fps: 30, outTimeMs: 2000, totalSize: 2, progress: 'end' });
      return { exitCode: 0, durationMs: 1200, logTail: '' };
    });
    mockVmaf.mockImplementation(async (_ref, _dist, opts) => {
      opts?.onProgress?.(10);
      await new Promise((r) => setTimeout(r, 1100));
      opts?.onProgress?.(50);
      await new Promise((r) => setTimeout(r, 1100));
      opts?.onProgress?.(100);
      return { vmafMean: 95, vmafMin: 94, vmafHarmonicMean: 94 };
    });

    await orch.runFullFileVerify(1, 42);

    const progressEvents = events.filter(
      (e): e is Extract<EngineEvent, { type: 'bench.pass2_progress' }> =>
        e.type === 'bench.pass2_progress',
    );
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);

    // overallPct monotonic non-decreasing
    let prev = -1;
    for (const ev of progressEvents) {
      expect(ev.overallPct).toBeGreaterThanOrEqual(prev);
      prev = ev.overallPct;
    }
    // Encode-phase ≤ 80, vmaf-phase ≥ 80
    for (const ev of progressEvents) {
      if (ev.currentPhase === 'encode') expect(ev.overallPct).toBeLessThanOrEqual(80);
      if (ev.currentPhase === 'vmaf') expect(ev.overallPct).toBeGreaterThanOrEqual(80);
    }
  }, 10000);
});

describe('runFullFileVerify cleanup (M3 finally) + pino audit (M4)', () => {
  it('emits failed + finally cleanup runs on encode error', async () => {
    const run = makeRunRow();
    const combo = makeComboRow();
    const { orch, benchComboRepo } = makeOrch(run, combo);
    const events = captureEvents();
    mockRunEncode.mockRejectedValue(new Error('ffmpeg failed at /var/scratch/out.mkv'));

    await orch.runFullFileVerify(1, 42);

    const failed = events.find((e) => e.type === 'bench.pass2_failed');
    expect(failed).toBeDefined();
    expect(benchComboRepo.markPass2Complete).not.toHaveBeenCalled();
    // M3: rm called on outDir regardless of error
    expect(mockFs.rm).toHaveBeenCalled();
  });

  it('SR5: errorReason is sanitized — no raw path leaks into SSE', async () => {
    const run = makeRunRow();
    const combo = makeComboRow();
    const { orch } = makeOrch(run, combo);
    const events = captureEvents();
    mockRunEncode.mockRejectedValue(new Error('ENOENT at /mnt/cache/scratch/output-42.mkv'));

    await orch.runFullFileVerify(1, 42);

    const failed = events.find(
      (e): e is Extract<EngineEvent, { type: 'bench.pass2_failed' }> =>
        e.type === 'bench.pass2_failed',
    );
    expect(failed?.errorReason).not.toContain('/mnt/cache');
    expect(failed?.errorReason).toContain('<path>');
  });

  it('M4: pino logger emits audit rows for started + complete', async () => {
    const run = makeRunRow();
    const combo = makeComboRow();
    const { orch } = makeOrch(run, combo);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    mockRunEncode.mockResolvedValue({ exitCode: 0, durationMs: 1, logTail: '' });
    mockVmaf.mockResolvedValue({ vmafMean: 90, vmafMin: 88, vmafHarmonicMean: 89 });

    await orch.runFullFileVerify(1, 42);

    const startedRow = infoSpy.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { audit?: string }).audit === 'bench.pass2_started',
    );
    const completeRow = infoSpy.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { audit?: string }).audit === 'bench.pass2_complete',
    );
    expect(startedRow).toBeDefined();
    expect(completeRow).toBeDefined();
  });

  it('M4: pino warn emits audit row for failed', async () => {
    const run = makeRunRow();
    const combo = makeComboRow();
    const { orch } = makeOrch(run, combo);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    mockRunEncode.mockRejectedValue(new Error('boom'));

    await orch.runFullFileVerify(1, 42);

    const failedRow = warnSpy.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { audit?: string }).audit === 'bench.pass2_failed',
    );
    expect(failedRow).toBeDefined();
  });
});

describe('cancelPass2 (SR2)', () => {
  it('aborts in-flight encode + finally emits cancelled', async () => {
    const run = makeRunRow();
    const combo = makeComboRow();
    const { orch } = makeOrch(run, combo);
    const events = captureEvents();
    // Long-running encode that respects signal
    mockRunEncode.mockImplementation(
      (opts) =>
        new Promise<{ exitCode: number; durationMs: number; logTail: string }>((_, reject) => {
          opts.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    mockVmaf.mockResolvedValue({ vmafMean: 90, vmafMin: 88, vmafHarmonicMean: 89 });

    const runP = orch.runFullFileVerify(1, 42);
    await new Promise((r) => setImmediate(r));
    orch.cancelPass2(1, 42);
    await runP;

    const failed = events.find(
      (e): e is Extract<EngineEvent, { type: 'bench.pass2_failed' }> =>
        e.type === 'bench.pass2_failed',
    );
    expect(failed?.errorReason).toBe('cancelled');
  });

  it('throws not_running when no Pass-2 in flight', () => {
    const run = makeRunRow();
    const combo = makeComboRow();
    const { orch } = makeOrch(run, combo);
    expect(() => orch.cancelPass2(1, 42)).toThrow(/not_running/);
  });

  it('throws not_running on (runId, comboId) mismatch', async () => {
    const run = makeRunRow();
    const combo = makeComboRow();
    const { orch } = makeOrch(run, combo);
    let release!: () => void;
    mockRunEncode.mockImplementation(
      () =>
        new Promise<{ exitCode: number; durationMs: number; logTail: string }>((resolve) => {
          release = () => resolve({ exitCode: 0, durationMs: 1, logTail: '' });
        }),
    );
    mockVmaf.mockResolvedValue({ vmafMean: 90, vmafMin: 88, vmafHarmonicMean: 89 });

    const runP = orch.runFullFileVerify(1, 42);
    await new Promise((r) => setImmediate(r));
    expect(() => orch.cancelPass2(999, 42)).toThrow(/not_running/);
    expect(() => orch.cancelPass2(1, 9999)).toThrow(/not_running/);
    release();
    await runP;
  });
});
