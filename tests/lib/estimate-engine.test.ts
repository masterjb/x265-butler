// Phase 13 Plan 13-04 Task 2 — estimate-engine tests.
//
// Hermetic via vi.mock for walker / hash / ffprobe / sidecar reader.
// Plain-object repo fakes (engine consumes only narrow methods).
// Covers AC-2, AC-4, AC-5, AC-6, AC-7 plus M2 (fileId-pinned blocklist
// fallback), SR2 (sidecar-mismatch warn), SR4 (abort), SR5 (cap).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FileRepo } from '@/src/lib/db/repos/file';
import type { BlocklistRepo } from '@/src/lib/db/repos/blocklist';
import type { BenchRunRepo } from '@/src/lib/db/repos/bench-run';
import type { BenchComboRepo } from '@/src/lib/db/repos/bench-combo';
import type { FileEntry } from '@/src/lib/scan/walker';
import type { SidecarPayload } from '@/src/lib/encode/sidecar';
import type { ProbeResult } from '@/src/lib/scan/ffprobe';
import type { BenchRunRow, BenchComboRow } from '@/src/lib/db/schema';

const { mockWalk, mockHash, mockFfprobe, mockReadSidecar, mockMatchPathInList, mockLoggerWarn } =
  vi.hoisted(() => ({
    mockWalk: vi.fn<(root: string, opts: unknown) => AsyncGenerator<FileEntry>>(),
    mockHash: vi.fn<(p: string) => Promise<string>>(),
    mockFfprobe: vi.fn<(p: string) => Promise<ProbeResult | null>>(),
    mockReadSidecar: vi.fn<(p: string) => Promise<SidecarPayload | null>>(),
    mockMatchPathInList: vi.fn<(p: string, patterns: unknown[]) => boolean>(),
    mockLoggerWarn: vi.fn(),
  }));

vi.mock('@/src/lib/scan/walker', () => ({ walkFiles: mockWalk }));
vi.mock('@/src/lib/scan/hash', () => ({ hashFile: mockHash }));
vi.mock('@/src/lib/scan/ffprobe', () => ({ ffprobe: mockFfprobe }));
vi.mock('@/src/lib/encode/sidecar', () => ({ readSidecar: mockReadSidecar }));
vi.mock('@/src/lib/db/repos/blocklist', () => ({ matchPathInList: mockMatchPathInList }));
vi.mock('@/src/lib/logger', () => ({
  logger: {
    warn: mockLoggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ warn: mockLoggerWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { runEstimate, ESTIMATE_MAX_FILES, type EstimateDeps } from '@/src/lib/scan/estimate-engine';

function makeWalker(entries: FileEntry[]): () => AsyncGenerator<FileEntry> {
  return async function* () {
    for (const e of entries) yield e;
  };
}

function makeRepos(overrides: Partial<EstimateDeps> = {}): EstimateDeps {
  const fileRepo = {
    findByContentHash: vi.fn().mockReturnValue(undefined),
  } as unknown as FileRepo;
  const blocklistRepo = {
    listAllPatterns: vi.fn().mockReturnValue([]),
    findByFileId: vi.fn().mockReturnValue(undefined),
  } as unknown as BlocklistRepo;
  const benchRunRepo = {
    findLatestComplete: vi.fn().mockReturnValue(null),
  } as unknown as BenchRunRepo;
  const benchComboRepo = {
    listByRun: vi.fn().mockReturnValue([]),
  } as unknown as BenchComboRepo;
  return { fileRepo, blocklistRepo, benchRunRepo, benchComboRepo, ...overrides };
}

const PROBE_OK: ProbeResult = {
  codec: 'h264',
  bitrate: 5_000_000,
  durationSeconds: 3600,
  width: 1920,
  height: 1080,
  container: 'mov,mp4,m4a',
  tags: {},
};

function entry(p: string, size = 1_000_000_000, mtime = 1_700_000_000): FileEntry {
  return { path: p, size, mtime };
}

function sidecarV1(srcHash: string, outHash = 'unrelated'): SidecarPayload {
  return {
    schema: 'x265-butler/v1',
    processedBy: 'x265-butler',
    version: '1.0.0',
    gitHash: 'dev',
    processedAt: '2026-01-01T00:00:00Z',
    source: { filename: 'a.mp4', contentHash: srcHash, sizeBytes: 1000 },
    output: { filename: 'a.x265.mkv', contentHash: outHash, sizeBytes: 500 },
  };
}

function benchRun(id = 1, sampleDurationSec = 20): BenchRunRow {
  return {
    id,
    mode: 'pareto',
    status: 'complete',
    file_ids_json: '[]',
    matrix_json: '{}',
    sample_count: 3,
    sample_duration_seconds: sampleDurationSec,
    vmaf_buckets_json: null,
    vmaf_model: 'vmaf_v0.6.1',
    actor_id: null,
    started_at: 1_700_000_000,
    completed_at: 1_700_000_100,
    error_reason: null,
    created_at: 1_700_000_000,
    version: 1,
  } as unknown as BenchRunRow;
}

function combo(over: Partial<BenchComboRow> = {}): BenchComboRow {
  return {
    id: 1,
    run_id: 1,
    file_id: 1,
    encoder: 'libx265',
    preset: 'medium',
    native_quality_param: 'crf',
    native_quality_value: 22,
    vmaf_target: null,
    sample_idx: 0,
    vmaf: 95,
    size_bytes: 100,
    encode_seconds: 10,
    source_sample_bytes: 200,
    pass2_vmaf: null,
    pass2_size_bytes: null,
    pass2_encode_seconds: null,
    pass2_completed_at: null,
    status: 'complete',
    error_reason: null,
    is_pareto: 1,
    top3_role: 'quality',
    created_at: 0,
    completed_at: 0,
    ...over,
  } as unknown as BenchComboRow;
}

describe('runEstimate (13-04 T2)', () => {
  beforeEach(() => {
    mockWalk.mockReset();
    mockHash.mockReset();
    mockFfprobe.mockReset();
    mockReadSidecar.mockReset();
    mockMatchPathInList.mockReset();
    mockLoggerWarn.mockReset();
    mockHash.mockResolvedValue('h'.repeat(64));
    mockFfprobe.mockResolvedValue(PROBE_OK);
    mockReadSidecar.mockResolvedValue(null);
    mockMatchPathInList.mockReturnValue(false);
  });

  it('case 1: empty rootPath → buckets all 0, savings/encodeTime collapse', async () => {
    mockWalk.mockImplementation(makeWalker([]));
    const result = await runEstimate(
      { rootPath: '/x', extensions: ['mp4'], minSizeMb: 1, encoder: 'libx265' },
      makeRepos(),
    );
    expect(result.skipBuckets).toEqual({ sidecar: 0, blocklist: 0, eligible: 0, scanned: 0 });
    expect(result.savings.totalBytes).toBe(0);
    expect(result.savings.projectedBytes).toBe(0);
    expect(result.encodeTime.seconds).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.aborted).toBe(false);
  });

  it('case 2: 3 files (1 sidecar / 1 blocklist / 1 eligible) → bucket parity + ffprobe called once', async () => {
    const SRC_HASH = 'h'.repeat(64);
    mockWalk.mockImplementation(
      makeWalker([entry('/m/a.mp4'), entry('/m/b.mp4'), entry('/m/c.mp4')]),
    );
    mockReadSidecar.mockImplementation(async (p) =>
      p === '/m/a.mp4' ? sidecarV1(SRC_HASH) : null,
    );
    mockMatchPathInList.mockImplementation((p) => p === '/m/b.mp4');

    const result = await runEstimate(
      { rootPath: '/m', extensions: ['mp4'], minSizeMb: 1, encoder: 'libx265' },
      makeRepos(),
    );
    expect(result.skipBuckets).toEqual({ sidecar: 1, blocklist: 1, eligible: 1, scanned: 3 });
    expect(result.filesEligible).toBe(1);
    expect(mockFfprobe).toHaveBeenCalledTimes(1);
    expect(mockFfprobe).toHaveBeenCalledWith('/m/c.mp4');
  });

  it('case 3: all sidecar-matches → eligible=0 → savings.projectedBytes=0', async () => {
    mockWalk.mockImplementation(makeWalker([entry('/m/a.mp4'), entry('/m/b.mp4')]));
    mockReadSidecar.mockResolvedValue(sidecarV1('h'.repeat(64)));
    const result = await runEstimate(
      { rootPath: '/m', extensions: ['mp4'], minSizeMb: 1, encoder: 'libx265' },
      makeRepos(),
    );
    expect(result.skipBuckets.sidecar).toBe(2);
    expect(result.filesEligible).toBe(0);
    expect(result.savings.projectedBytes).toBe(0);
    expect(mockFfprobe).not.toHaveBeenCalled();
  });

  it('case 4: no complete bench_run → savings.source=naive, runId=null', async () => {
    mockWalk.mockImplementation(makeWalker([entry('/m/a.mp4')]));
    const result = await runEstimate(
      { rootPath: '/m', extensions: ['mp4'], minSizeMb: 1, encoder: 'libx265' },
      makeRepos(),
    );
    expect(result.savings.source).toBe('naive');
    expect(result.savings.runId).toBeNull();
  });

  it('case 5: complete bench_run + matching combos → savings.source=bench-augmented + runId set', async () => {
    mockWalk.mockImplementation(makeWalker([entry('/m/a.mp4')]));
    const repos = makeRepos();
    (repos.benchRunRepo.findLatestComplete as ReturnType<typeof vi.fn>).mockReturnValue(
      benchRun(42, 20),
    );
    (repos.benchComboRepo.listByRun as ReturnType<typeof vi.fn>).mockReturnValue([
      combo({ encoder: 'libx265', size_bytes: 100, source_sample_bytes: 200, encode_seconds: 10 }),
    ]);
    const result = await runEstimate(
      { rootPath: '/m', extensions: ['mp4'], minSizeMb: 1, encoder: 'libx265' },
      repos,
    );
    expect(result.savings.source).toBe('bench-augmented');
    expect(result.savings.runId).toBe(42);
    // ratio = 1 - 100/200 = 0.5
    expect(result.savings.ratio).toBeCloseTo(0.5, 5);
  });

  it('case 6: complete bench_run but no matching encoder combos → naive fallback', async () => {
    mockWalk.mockImplementation(makeWalker([entry('/m/a.mp4')]));
    const repos = makeRepos();
    (repos.benchRunRepo.findLatestComplete as ReturnType<typeof vi.fn>).mockReturnValue(benchRun());
    (repos.benchComboRepo.listByRun as ReturnType<typeof vi.fn>).mockReturnValue([
      combo({ encoder: 'nvenc' }), // not libx265 — filtered out
    ]);
    const result = await runEstimate(
      { rootPath: '/m', extensions: ['mp4'], minSizeMb: 1, encoder: 'libx265' },
      repos,
    );
    expect(result.savings.source).toBe('naive');
    expect(result.savings.runId).toBeNull();
  });

  it('case 7: ffprobe rejects on eligible → push entry.size, duration=null, eligible++', async () => {
    mockWalk.mockImplementation(makeWalker([entry('/m/a.mp4', 5_000_000_000)]));
    mockFfprobe.mockRejectedValueOnce(new Error('ffprobe blew up'));
    const result = await runEstimate(
      { rootPath: '/m', extensions: ['mp4'], minSizeMb: 1, encoder: 'libx265' },
      makeRepos(),
    );
    expect(result.skipBuckets.eligible).toBe(1);
    expect(result.savings.totalBytes).toBe(5_000_000_000);
    // duration null → encodeTime.seconds=0 with scaleFactor=0
    expect(result.encodeTime.seconds).toBe(0);
    expect(result.encodeTime.withDurationCount).toBe(0);
  });

  it('case 8: empty patternsCache → blocklist=0 for non-pinned files', async () => {
    mockWalk.mockImplementation(makeWalker([entry('/m/a.mp4')]));
    const repos = makeRepos();
    (repos.blocklistRepo.listAllPatterns as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const result = await runEstimate(
      { rootPath: '/m', extensions: ['mp4'], minSizeMb: 1, encoder: 'libx265' },
      repos,
    );
    expect(result.skipBuckets.blocklist).toBe(0);
    expect(result.skipBuckets.eligible).toBe(1);
  });

  it('case 9 (SR2): sidecar hash-mismatch → falls through + warn `via:estimate`', async () => {
    mockWalk.mockImplementation(makeWalker([entry('/m/a.mp4')]));
    mockReadSidecar.mockResolvedValue(sidecarV1('different-hash-than-disk'));
    const result = await runEstimate(
      { rootPath: '/m', extensions: ['mp4'], minSizeMb: 1, encoder: 'libx265' },
      makeRepos(),
    );
    expect(result.skipBuckets.sidecar).toBe(0);
    expect(result.skipBuckets.eligible).toBe(1);
    const warnCall = mockLoggerWarn.mock.calls.find(
      (c) =>
        typeof c[0] === 'object' &&
        (c[0] as { action?: string }).action === 'sidecar_hash_mismatch_at_source',
    );
    expect(warnCall).toBeTruthy();
    expect((warnCall![0] as { via?: string }).via).toBe('estimate');
  });

  it('case 10: duration-aggregation skips null entries', async () => {
    mockWalk.mockImplementation(
      makeWalker([entry('/m/a.mp4'), entry('/m/b.mp4'), entry('/m/c.mp4')]),
    );
    mockFfprobe.mockResolvedValueOnce({ ...PROBE_OK, durationSeconds: 3600 });
    mockFfprobe.mockResolvedValueOnce({ ...PROBE_OK, durationSeconds: null });
    mockFfprobe.mockResolvedValueOnce({ ...PROBE_OK, durationSeconds: 1800 });
    const result = await runEstimate(
      { rootPath: '/m', extensions: ['mp4'], minSizeMb: 1, encoder: 'libx265' },
      makeRepos(),
    );
    // 3 eligible / 2 with-duration → SR3 scaleFactor = 1.5
    expect(result.encodeTime.eligibleCount).toBe(3);
    expect(result.encodeTime.withDurationCount).toBe(2);
    expect(result.encodeTime.scaleFactor).toBe(1.5);
  });

  it('case 11: encoder=nvenc → bench-aug uses only nvenc combos', async () => {
    mockWalk.mockImplementation(makeWalker([entry('/m/a.mp4')]));
    const repos = makeRepos();
    (repos.benchRunRepo.findLatestComplete as ReturnType<typeof vi.fn>).mockReturnValue(
      benchRun(7, 20),
    );
    (repos.benchComboRepo.listByRun as ReturnType<typeof vi.fn>).mockReturnValue([
      combo({ encoder: 'libx265', size_bytes: 100, source_sample_bytes: 200 }), // filtered out
      combo({
        encoder: 'nvenc',
        size_bytes: 80,
        source_sample_bytes: 200,
        encode_seconds: 5,
      }),
    ]);
    const result = await runEstimate(
      { rootPath: '/m', extensions: ['mp4'], minSizeMb: 1, encoder: 'nvenc' },
      repos,
    );
    expect(result.savings.source).toBe('bench-augmented');
    expect(result.savings.encoder).toBe('nvenc');
    // ratio = 1 - 80/200 = 0.6
    expect(result.savings.ratio).toBeCloseTo(0.6, 5);
  });

  it('case 12: durationMs > 0 (sanity)', async () => {
    mockWalk.mockImplementation(makeWalker([entry('/m/a.mp4')]));
    const result = await runEstimate(
      { rootPath: '/m', extensions: ['mp4'], minSizeMb: 1, encoder: 'libx265' },
      makeRepos(),
    );
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('case 13 (M2): file_id-pinned blocklist entry without path-pattern → blocklist=1', async () => {
    mockWalk.mockImplementation(makeWalker([entry('/m/a.mp4')]));
    const repos = makeRepos();
    (repos.fileRepo.findByContentHash as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 99,
      path: '/m/a.mp4',
    });
    (repos.blocklistRepo.findByFileId as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 1,
      file_id: 99,
      pattern: null,
      created_at: 0,
    });
    // matchPathInList stays false — fallback should fire
    const result = await runEstimate(
      { rootPath: '/m', extensions: ['mp4'], minSizeMb: 1, encoder: 'libx265' },
      repos,
    );
    expect(result.skipBuckets.blocklist).toBe(1);
    expect(result.skipBuckets.eligible).toBe(0);
    expect(repos.blocklistRepo.findByFileId).toHaveBeenCalledWith(99);
  });

  it('case 14 (SR4): signal.aborted mid-walk → loop breaks, aborted=true', async () => {
    const ac = new AbortController();
    // Walker yields 5 entries; abort fires after first iteration.
    mockWalk.mockImplementation(async function* () {
      for (let i = 0; i < 5; i++) {
        if (i === 1) ac.abort();
        yield entry(`/m/${i}.mp4`);
      }
    });
    const result = await runEstimate(
      {
        rootPath: '/m',
        extensions: ['mp4'],
        minSizeMb: 1,
        encoder: 'libx265',
        signal: ac.signal,
      },
      makeRepos(),
    );
    expect(result.aborted).toBe(true);
    expect(result.skipBuckets.scanned).toBeLessThan(5);
    expect(result.skipBuckets.scanned).toBeGreaterThanOrEqual(1);
  });

  it('case 15 (SR5): walker > ESTIMATE_MAX_FILES → buckets.scanned == cap, truncated=true', async () => {
    // Yield exactly cap+1 cheap entries.
    mockWalk.mockImplementation(async function* () {
      for (let i = 0; i <= ESTIMATE_MAX_FILES; i++) {
        yield entry(`/m/${i}.mp4`, 1_000_000);
      }
    });
    // Drop ffprobe + readSidecar work to keep test fast.
    mockReadSidecar.mockResolvedValue(null);
    mockFfprobe.mockResolvedValue({ ...PROBE_OK, durationSeconds: 1 });
    const result = await runEstimate(
      { rootPath: '/m', extensions: ['mp4'], minSizeMb: 1, encoder: 'libx265' },
      makeRepos(),
    );
    expect(result.truncated).toBe(true);
    expect(result.skipBuckets.scanned).toBe(ESTIMATE_MAX_FILES);
  }, 60_000);
});
