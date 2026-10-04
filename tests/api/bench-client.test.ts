import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BenchRunRow } from '@/src/lib/db/schema';

// Mock global fetch before importing the module
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Import after mock is set up
const {
  enqueueBenchRun,
  listBenchRuns,
  getBenchRun,
  cancelBenchRun,
  purgeBenchRun,
  bulkDeleteBenchRuns,
  getBenchRecommendation,
} = await import('@/src/lib/api/bench-client');

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

  // AC-6 (47-01): name + return shape unchanged, only the transport moved.
  it('test_cancelBenchRun_200_returns_cancelled_true', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ cancelled: true }),
    });
    const result = await cancelBenchRun(5);
    expect(result).toEqual({ cancelled: true });
    expect(mockFetch).toHaveBeenCalledWith('/api/bench/5/cancel', { method: 'POST' });
  });

  it('test_cancelBenchRun_error_returns_error_field', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'run_not_found' }),
    });
    expect(await cancelBenchRun(5)).toEqual({ error: 'run_not_found' });
  });
});

// 47-01 AC-6: purge is ADDITIVE — DELETE /api/bench/{id}.
describe('purgeBenchRun', () => {
  beforeEach(() => mockFetch.mockReset());

  it('test_purgeBenchRun_200_returns_deleted_and_combosDeleted', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ runId: 5, deleted: true, combosDeleted: 42 }),
    });
    const result = await purgeBenchRun(5);
    expect(result).toEqual({ deleted: true, combosDeleted: 42 });
    expect(mockFetch).toHaveBeenCalledWith('/api/bench/5', { method: 'DELETE' });
  });

  it('test_purgeBenchRun_409_returns_error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'delete_rejected_active_run' }),
    });
    expect(await purgeBenchRun(5)).toEqual({ error: 'delete_rejected_active_run' });
  });
});

// 47-01 AC-6: bulk purge posts JSON — the route's CSRF guard 415s without the header.
describe('bulkDeleteBenchRuns', () => {
  beforeEach(() => mockFetch.mockReset());

  it('test_bulkDeleteBenchRuns_posts_json_and_returns_envelope', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ successCount: 2, failed: [{ id: 3, reason: 'active_run' }] }),
    });
    const result = await bulkDeleteBenchRuns([1, 2, 3]);
    expect(result).toEqual({ successCount: 2, failed: [{ id: 3, reason: 'active_run' }] });
    expect(mockFetch).toHaveBeenCalledWith('/api/bench/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [1, 2, 3] }),
    });
  });

  it('test_bulkDeleteBenchRuns_envelope_failure_returns_error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'invalid_body' }),
    });
    expect(await bulkDeleteBenchRuns([1])).toEqual({ error: 'invalid_body' });
  });
});

// 47-01 AC-8: the empty-state degradation is ALREADY delivered by the existing
// `if (!res.ok) return null` guard (bench-client.ts:70) — asserted, not changed.
describe('getBenchRecommendation — AC-8 post-purge empty state', () => {
  beforeEach(() => mockFetch.mockReset());

  it('404 no_completed_bench_run → resolves null (no throw)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'no_completed_bench_run' }),
    });
    await expect(getBenchRecommendation('libx265')).resolves.toBeNull();
  });
});
