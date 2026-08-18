/*
 * 47-03 Task 3 — AC-9: bench combos whose source file was deleted.
 *
 * Since migration 0029 bench_combo.file_id is ON DELETE SET NULL, so a combo can
 * carry file_id === null when the library entry is deleted between enqueue and
 * dispatch. _executeRun groups combos by `run.fileIds`, and NULL matches no
 * round — without the up-front orphan sweep such a combo stays 'pending'
 * forever and the run never reaches a terminal status.
 *
 * Harness follows tests/bench/orchestrator.test.ts (mocked repos + inert
 * vmaf/sample-extractor/ffmpeg leaves) rather than the real-DB shape of
 * orchestrator-purge.test.ts: driving _executeRun is what this AC is about, and
 * only the mocked-leaf harness can do that without spawning ffmpeg.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/src/lib/bench/vmaf', () => ({
  encodeForBench: vi.fn(),
  computeVmaf: vi.fn(),
}));
vi.mock('@/src/lib/bench/sample-extractor', () => ({
  extractSamples: vi.fn(),
  SampleExtractorError: class SampleExtractorError extends Error {},
}));
vi.mock('@/src/lib/encode/ffmpeg', () => ({ runEncode: vi.fn(), buildArgs: vi.fn(() => []) }));
vi.mock('@/src/lib/db', () => ({
  benchRunRepo: vi.fn(),
  benchComboRepo: vi.fn(),
  fileRepo: () => ({ getById: vi.fn().mockReturnValue({ id: 10, path: '/media/test.mkv' }) }),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));
vi.mock('node:fs/promises');

import fs from 'node:fs/promises';
import { BenchOrchestrator, __forTests_resetBenchOrchestrator } from '@/src/lib/bench/orchestrator';
import { encodeForBench, computeVmaf } from '@/src/lib/bench/vmaf';
import { extractSamples } from '@/src/lib/bench/sample-extractor';
import { engineEvents, __forTests_resetEngineEvents } from '@/src/lib/encode/events';
import type { BenchRunRow, BenchComboRow } from '@/src/lib/db/schema';

const mockFs = vi.mocked(fs);
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

function makeMockRepos(pendingCombos: BenchComboRow[]) {
  const benchRunRepo = {
    create: vi.fn().mockReturnValue(1),
    findById: vi
      .fn()
      .mockReturnValueOnce(makeRunRow({ status: 'pending' }))
      .mockReturnValue(makeRunRow({ status: 'running' })),
    listRecent: vi.fn().mockReturnValue([makeRunRow({ status: 'pending' })]),
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
    listPendingByRun: vi.fn().mockReturnValue(pendingCombos),
    markComboEncoding: vi.fn(),
    markComboComplete: vi.fn(),
    markComboFailed: vi.fn(),
    markComboSkipped: vi.fn(),
    recomputePareto: vi.fn(),
    summarizeRun: vi.fn().mockReturnValue([]),
    listByRun: vi.fn().mockReturnValue(pendingCombos),
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

describe('BenchOrchestrator._executeRun — AC-9 orphaned combos (file_id IS NULL)', () => {
  it('fails a NULL-file_id combo as source_file_deleted and still runs the valid one', async () => {
    const orphan = makeComboRow({ id: 1, file_id: null });
    const valid = makeComboRow({ id: 2, file_id: 10 });
    const { benchRunRepo, benchComboRepo } = makeMockRepos([orphan, valid]);
    const orch = new BenchOrchestrator(benchRunRepo as never, benchComboRepo as never);

    await orch.executeNextPending();

    expect(benchComboRepo.markComboFailed).toHaveBeenCalledWith(1, 'source_file_deleted');
    expect(benchComboRepo.markComboFailed).toHaveBeenCalledTimes(1);
    // The valid combo went through the normal encode → vmaf → complete path.
    expect(mockEncode).toHaveBeenCalledOnce();
    expect(mockVmaf).toHaveBeenCalledOnce();
    expect(benchComboRepo.markComboComplete).toHaveBeenCalledWith(2, expect.anything());
  });

  it('progress reaches total — the orphan is counted, no stall below 100%', async () => {
    const orphan = makeComboRow({ id: 1, file_id: null });
    const valid = makeComboRow({ id: 2, file_id: 10 });
    const { benchRunRepo, benchComboRepo } = makeMockRepos([orphan, valid]);
    const orch = new BenchOrchestrator(benchRunRepo as never, benchComboRepo as never);

    const progress: Array<{ completedCombos: number; totalCombos: number }> = [];
    const unsub = engineEvents.subscribe((ev) => {
      if (ev.type === 'bench.progress') {
        progress.push({ completedCombos: ev.completedCombos, totalCombos: ev.totalCombos });
      }
    });
    await orch.executeNextPending();
    unsub();

    expect(progress.length).toBeGreaterThan(0);
    const last = progress[progress.length - 1];
    expect(last.totalCombos).toBe(2);
    expect(last.completedCombos).toBe(2);
  });

  it('run still reaches a terminal status when ALL combos are orphans', async () => {
    const orphanA = makeComboRow({ id: 1, file_id: null });
    const orphanB = makeComboRow({ id: 2, file_id: null, sample_idx: 1 });
    const { benchRunRepo, benchComboRepo } = makeMockRepos([orphanA, orphanB]);
    const orch = new BenchOrchestrator(benchRunRepo as never, benchComboRepo as never);

    const events: string[] = [];
    const unsub = engineEvents.subscribe((ev) => events.push(ev.type));
    await orch.executeNextPending();
    unsub();

    expect(benchComboRepo.markComboFailed).toHaveBeenCalledWith(1, 'source_file_deleted');
    expect(benchComboRepo.markComboFailed).toHaveBeenCalledWith(2, 'source_file_deleted');
    // No encode was attempted, and the run terminates instead of hanging.
    expect(mockEncode).not.toHaveBeenCalled();
    expect(benchRunRepo.markComplete).toHaveBeenCalledOnce();
    expect(events).toContain('bench.completed');
  });

  it('no orphans → byte-identical behaviour, no markComboFailed', async () => {
    const valid = makeComboRow({ id: 1, file_id: 10 });
    const { benchRunRepo, benchComboRepo } = makeMockRepos([valid]);
    const orch = new BenchOrchestrator(benchRunRepo as never, benchComboRepo as never);

    await orch.executeNextPending();

    expect(benchComboRepo.markComboFailed).not.toHaveBeenCalled();
    expect(benchComboRepo.markComboComplete).toHaveBeenCalledOnce();
    expect(benchRunRepo.markComplete).toHaveBeenCalledOnce();
  });
});
