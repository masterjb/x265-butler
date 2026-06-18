import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BenchRunRow } from '@/src/lib/db/schema';

// Mock global fetch before importing the module
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Import after mock is set up
const { enqueueBenchRun, listBenchRuns, getBenchRun, cancelBenchRun } =
  await import('@/src/lib/api/bench-client');

function makeBenchRunRow(overrides: Partial<BenchRunRow> = {}): BenchRunRow {
  return {
    id: 1,
    mode: 'native-sweep',
    status: 'complete',
    fileIds: [10],
    matrix: { encoders: ['libx265'], presets: ['medium'], nativeValues: [28] },
    sample_count: 3,
    sample_duration_seconds: 20,
    vmaf_buckets_json: null,
    vmaf_model: 'vmaf_v0.6.1',
    actor_id: null,
    error_reason: null,
    created_at: 1000,
    started_at: 1001,
    completed_at: 1002,
    version: 1,
    ...overrides,
  };
}

describe('enqueueBenchRun', () => {
  beforeEach(() => mockFetch.mockReset());

  it('test_enqueueBenchRun_happy_201_returns_runId', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ runId: 42 }),
    });
    const result = await enqueueBenchRun({
      mode: 'native-sweep',
      fileIds: [1, 2],
      matrix: { encoders: ['libx265'], presets: ['medium'], nativeValues: [28] },
    });
    expect(result).toEqual({ runId: 42 });
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/bench',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('test_enqueueBenchRun_400_returns_error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'validation_failed', details: ['fileIds too large'] }),
    });
    const result = await enqueueBenchRun({
      mode: 'native-sweep',
      fileIds: [],
      matrix: { encoders: ['libx265'], presets: ['medium'], nativeValues: [28] },
    });
    expect(result).toEqual({ error: 'validation_failed', details: ['fileIds too large'] });
  });
});

describe('listBenchRuns', () => {
  beforeEach(() => mockFetch.mockReset());

  it('test_listBenchRuns_returns_runs_array', async () => {
    const rows = [makeBenchRunRow({ id: 1 }), makeBenchRunRow({ id: 2 })];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ runs: rows }),
    });
    const result = await listBenchRuns(20, 0);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
  });
});

describe('getBenchRun', () => {
  beforeEach(() => mockFetch.mockReset());

  it('test_getBenchRun_404_returns_null', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'not_found' }),
    });
    const result = await getBenchRun(999);
    expect(result).toBeNull();
  });
});

describe('cancelBenchRun', () => {
  beforeEach(() => mockFetch.mockReset());

  it('test_cancelBenchRun_200_returns_cancelled_true', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ cancelled: true }),
    });
    const result = await cancelBenchRun(5);
    expect(result).toEqual({ cancelled: true });
    expect(mockFetch).toHaveBeenCalledWith('/api/bench/5', { method: 'DELETE' });
  });
});
