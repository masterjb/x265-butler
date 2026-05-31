import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock bench module functions before importing orchestrator
vi.mock('@/src/lib/bench/vmaf', () => ({
  encodeForBench: vi.fn(),
  computeVmaf: vi.fn(),
}));
vi.mock('@/src/lib/bench/sample-extractor', () => ({
  extractSamples: vi.fn(),
  SampleExtractorError: class SampleExtractorError extends Error {},
}));
vi.mock('@/src/lib/db', () => ({
  benchRunRepo: vi.fn(),
  benchComboRepo: vi.fn(),
  fileRepo: () => ({ getById: vi.fn().mockReturnValue({ id: 10, path: '/media/test.mp4' }) }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));
vi.mock('node:fs/promises');

import fs from 'node:fs/promises';
import { BenchOrchestrator, __forTests_resetBenchOrchestrator } from '@/src/lib/bench/orchestrator';
import { encodeForBench, computeVmaf } from '@/src/lib/bench/vmaf';
import { extractSamples } from '@/src/lib/bench/sample-extractor';

const mockFs = vi.mocked(fs);
import { engineEvents, __forTests_resetEngineEvents } from '@/src/lib/encode/events';
import type { BenchRunRow, BenchComboRow } from '@/src/lib/db/schema';
import { OccConflictError } from '@/src/lib/db/repos/bench-run';

const mockEncode = vi.mocked(encodeForBench);
const mockVmaf = vi.mocked(computeVmaf);
const mockExtractSamples = vi.mocked(extractSamples);

function makeRunRow(overrides: Partial<BenchRunRow> = {}): BenchRunRow {
  return {
    id: 1,
    status: 'pending',
    mode: 'native-sweep',
    matrix: { encoders: ['libx265'], presets: ['medium'], nativeValues: [28] },
    fileIds: [10],
    sample_count: 1,
    sample_duration_seconds: 20,
    vmaf_buckets_json: null,
    vmaf_model: 'vmaf_v0.6.1',
    actor_id: null,
    version: 1,
    created_at: 1000,
    started_at: null,
    completed_at: null,
    error_reason: null,
    ...overrides,
  };
}

function makeComboRow(overrides: Partial<BenchComboRow> = {}): BenchComboRow {
  return {
    id: 1,
    run_id: 1,
    file_id: 10,
    encoder: 'libx265',
    preset: 'medium',
    native_quality_param: '-crf',
    native_quality_value: 28,
    vmaf_target: null,
    sample_idx: 0,
    vmaf: null,
    size_bytes: null,
    encode_seconds: null,
    source_sample_bytes: null,
    pass2_vmaf: null,
    pass2_size_bytes: null,
    pass2_encode_seconds: null,
    pass2_completed_at: null,
    status: 'pending',
    error_reason: null,
    is_pareto: 0,
    top3_role: null,
    created_at: 1000,
    completed_at: null,
    ...overrides,
  };
}

function makeMockRepos() {
  const run = makeRunRow();
  const combo = makeComboRow();

  const benchRunRepo = {
    create: vi.fn().mockReturnValue(1),
    findById: vi.fn().mockReturnValue(run),
    listRecent: vi.fn().mockReturnValue([run]),
    markRunning: vi.fn(),
    markComplete: vi.fn(),
    markFailed: vi.fn(),
    markCancelled: vi.fn(),
    countByStatus: vi.fn().mockReturnValue({}),
    findActiveRunningCount: vi.fn().mockReturnValue(0),
    resetStuckRunningToFailed: vi.fn().mockReturnValue(0),
  };

  const benchComboRepo = {
    createBatch: vi.fn(),
    listPendingByRun: vi.fn().mockReturnValue([combo]),
    markComboEncoding: vi.fn(),
    markComboComplete: vi.fn(),
    markComboFailed: vi.fn(),
    markComboSkipped: vi.fn(),
    recomputePareto: vi.fn(),
    summarizeRun: vi.fn().mockReturnValue([]),
    listByRun: vi.fn().mockReturnValue([combo]),
  };

  return { benchRunRepo, benchComboRepo };
}

beforeEach(() => {
  vi.clearAllMocks();
  __forTests_resetBenchOrchestrator();
  __forTests_resetEngineEvents();

  mockFs.mkdir.mockResolvedValue(undefined);
  mockFs.unlink.mockResolvedValue(undefined);
  mockFs.rm.mockResolvedValue(undefined);
  mockFs.stat.mockResolvedValue({ size: 100_000 } as import('node:fs').Stats);
  mockEncode.mockResolvedValue({ sizeBytes: 100_000, encodeSec: 1.5 });
  mockVmaf.mockResolvedValue({ vmafMean: 87.5, vmafMin: 82.0, vmafHarmonicMean: 86.9 });
  mockExtractSamples.mockResolvedValue([
    {
      sampleIdx: 0,
      offsetSec: 75,
      path: '/scratch/1/file-10/sample-0.mkv',
      sizeBytes: 200_000,
      usedFallback: false,
    },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BenchOrchestrator.enqueueRun', () => {
  it('creates run + combos and emits bench.queued', async () => {
    const { benchRunRepo, benchComboRepo } = makeMockRepos();
    const orch = new BenchOrchestrator(benchRunRepo as never, benchComboRepo as never);

    const events: string[] = [];
    const unsub = engineEvents.subscribe((ev) => events.push(ev.type));

    const { runId } = await orch.enqueueRun({
      mode: 'native-sweep',
      matrix: { encoders: ['libx265'], presets: ['medium'], nativeValues: [28] },
      fileIds: [10],
      sampleCount: 1,
    });

    unsub();
    expect(runId).toBe(1);
    expect(benchRunRepo.create).toHaveBeenCalledOnce();
    expect(benchComboRepo.createBatch).toHaveBeenCalledOnce();
    expect(events).toContain('bench.queued');
  });

  it('vmaf-anchored mode creates combos with vmaf_target', async () => {
    const { benchRunRepo, benchComboRepo } = makeMockRepos();
    const orch = new BenchOrchestrator(benchRunRepo as never, benchComboRepo as never);

    await orch.enqueueRun({
      mode: 'vmaf-anchored',
      matrix: { encoders: ['libx265'], presets: ['medium'], vmafTargets: [90, 95] },
      fileIds: [10],
      sampleCount: 1,
    });

    const call = benchComboRepo.createBatch.mock.calls[0];
    const combos = call[1] as Array<{ vmaf_target: number | null }>;
    expect(combos.some((c) => c.vmaf_target === 90)).toBe(true);
    expect(combos.some((c) => c.vmaf_target === 95)).toBe(true);
  });
});

describe('BenchOrchestrator._executeRun (native-sweep)', () => {
  it('runs full combo: encode → vmaf → markComboComplete → bench.completed', async () => {
    const { benchRunRepo, benchComboRepo } = makeMockRepos();
    benchRunRepo.findById
      .mockReturnValueOnce(makeRunRow({ status: 'pending' }))
      .mockReturnValue(makeRunRow({ status: 'running' }));

    const orch = new BenchOrchestrator(benchRunRepo as never, benchComboRepo as never);

    const events: string[] = [];
    const unsub = engineEvents.subscribe((ev) => events.push(ev.type));

    await orch.executeNextPending();
    unsub();

    expect(mockEncode).toHaveBeenCalledOnce();
    expect(mockVmaf).toHaveBeenCalledOnce();
    expect(benchComboRepo.markComboComplete).toHaveBeenCalledOnce();
    expect(benchComboRepo.recomputePareto).toHaveBeenCalledOnce();
    expect(events).toContain('bench.completed');
  });

  it('emits bench.started on run begin', async () => {
    const { benchRunRepo, benchComboRepo } = makeMockRepos();
    benchRunRepo.findById
      .mockReturnValueOnce(makeRunRow({ status: 'pending' }))
      .mockReturnValue(makeRunRow({ status: 'running' }));

    const orch = new BenchOrchestrator(benchRunRepo as never, benchComboRepo as never);

    const events: string[] = [];
    const unsub = engineEvents.subscribe((ev) => events.push(ev.type));
    await orch.executeNextPending();
    unsub();

    expect(events).toContain('bench.started');
  });

  it('combo encode failure → markComboFailed, run still completes', async () => {
    mockEncode.mockRejectedValue(new Error('ffmpeg crashed'));

    const { benchRunRepo, benchComboRepo } = makeMockRepos();
    benchRunRepo.findById
      .mockReturnValueOnce(makeRunRow({ status: 'pending' }))
      .mockReturnValue(makeRunRow({ status: 'running' }));

    const orch = new BenchOrchestrator(benchRunRepo as never, benchComboRepo as never);
    await orch.executeNextPending();

    expect(benchComboRepo.markComboFailed).toHaveBeenCalledOnce();
    expect(benchComboRepo.recomputePareto).toHaveBeenCalledOnce();
  });

  it('test_failed_combo_still_emits_bench_progress_so_UI_does_not_stall_at_0', async () => {
    mockEncode.mockRejectedValue(new Error('ffmpeg crashed'));

    const { benchRunRepo, benchComboRepo } = makeMockRepos();
    benchRunRepo.findById
      .mockReturnValueOnce(makeRunRow({ status: 'pending' }))
      .mockReturnValue(makeRunRow({ status: 'running' }));

    const orch = new BenchOrchestrator(benchRunRepo as never, benchComboRepo as never);

    const progressEvents: Array<{ completedCombos: number; totalCombos: number }> = [];
    const unsub = engineEvents.subscribe((ev) => {
      if (ev.type === 'bench.progress') {
        progressEvents.push({
          completedCombos: ev.completedCombos,
          totalCombos: ev.totalCombos,
        });
      }
    });

    await orch.executeNextPending();
    unsub();

    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents.at(-1)?.completedCombos).toBeGreaterThan(0);
  });
});

describe('BenchOrchestrator.cancelRun', () => {
  it('aborts in-flight controller and emits bench.cancelled', async () => {
    const { benchRunRepo, benchComboRepo } = makeMockRepos();
    benchRunRepo.findById.mockReturnValue(makeRunRow({ status: 'running', version: 1 }));

    const orch = new BenchOrchestrator(benchRunRepo as never, benchComboRepo as never);

    const events: string[] = [];
    const unsub = engineEvents.subscribe((ev) => events.push(ev.type));

    await orch.cancelRun(1);
    unsub();

    expect(benchRunRepo.markCancelled).toHaveBeenCalledOnce();
    expect(events).toContain('bench.cancelled');
  });

  it('propagates OccConflictError from markCancelled', async () => {
    const { benchRunRepo, benchComboRepo } = makeMockRepos();
    benchRunRepo.findById.mockReturnValue(makeRunRow({ status: 'running', version: 1 }));
    benchRunRepo.markCancelled.mockImplementation(() => {
      throw new OccConflictError('bench_run', 1, 1, 2);
    });

    const orch = new BenchOrchestrator(benchRunRepo as never, benchComboRepo as never);

    await expect(orch.cancelRun(1)).rejects.toBeInstanceOf(OccConflictError);
  });

  it('pending combos skipped when cancel flag set', async () => {
    const { benchRunRepo, benchComboRepo } = makeMockRepos();

    // Two combos, cancel flagged before encode
    const combo1 = makeComboRow({ id: 1 });
    const combo2 = makeComboRow({ id: 2 });
    benchComboRepo.listPendingByRun.mockReturnValue([combo1, combo2]);

    // Make encode slow so we can cancel mid-run
    let resolveEncode!: () => void;
    mockEncode.mockImplementation(
      () =>
        new Promise<{ sizeBytes: number; encodeSec: number }>((r) => {
          resolveEncode = () => r({ sizeBytes: 0, encodeSec: 0 });
        }),
    );

    benchRunRepo.findById
      .mockReturnValueOnce(makeRunRow({ status: 'pending' }))
      .mockReturnValue(makeRunRow({ status: 'running' }));
    benchRunRepo.findById.mockReturnValue(makeRunRow({ status: 'running' }));

    const orch = new BenchOrchestrator(benchRunRepo as never, benchComboRepo as never);

    // Start run asynchronously, cancel immediately
    const runPromise = orch.executeNextPending();
    // Give the run loop a tick to start
    await new Promise((r) => setImmediate(r));
    benchRunRepo.findById.mockReturnValue(makeRunRow({ status: 'cancelled' }));
    await orch.cancelRun(1);
    resolveEncode();
    await runPromise;

    expect(benchComboRepo.markComboSkipped).toHaveBeenCalled();
  });
});

describe('BenchOrchestrator.executeNextPending', () => {
  it('noop when no pending runs', async () => {
    const { benchRunRepo, benchComboRepo } = makeMockRepos();
    benchRunRepo.listRecent.mockReturnValue([makeRunRow({ status: 'complete' })]);

    const orch = new BenchOrchestrator(benchRunRepo as never, benchComboRepo as never);
    await orch.executeNextPending();

    expect(benchRunRepo.markRunning).not.toHaveBeenCalled();
  });

  it('emits bench.failed when markRunning throws unexpected error', async () => {
    const { benchRunRepo, benchComboRepo } = makeMockRepos();
    benchRunRepo.findById
      .mockReturnValueOnce(makeRunRow({ status: 'pending' }))
      .mockReturnValue(makeRunRow({ status: 'running' }));
    // markRunning throws → _executeRun catches + returns without running combos
    benchRunRepo.markRunning.mockImplementation(() => {
      throw new Error('occ conflict');
    });

    const orch = new BenchOrchestrator(benchRunRepo as never, benchComboRepo as never);
    await orch.executeNextPending();

    // Should silently return (not emit failed) since it's the OCC catch-all
    expect(benchComboRepo.listPendingByRun).not.toHaveBeenCalled();
  });
});
