// @vitest-environment node
// 22-01 T3 IMP-3: withQueryTiming helper tests.
// AC-4 contract: helper emits `slow_query` pino-debug iff durationMs > 100ms;
// pass-through return-value; rethrow on throw.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/src/lib/logger', () => ({ logger: mockLogger }));

import { withQueryTiming, SLOW_QUERY_MS } from '@/src/lib/db/timing';

describe('22-01 T3: withQueryTiming', () => {
  beforeEach(() => {
    mockLogger.debug.mockReset();
    vi.restoreAllMocks();
  });

  it('happy under threshold → no emit, return-value pass-through', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const result = withQueryTiming('test.fast', () => {
      now = 50; // 50ms < 100ms threshold
      return { rows: ['a', 'b'], total: 2 };
    });
    expect(result).toEqual({ rows: ['a', 'b'], total: 2 });
    expect(mockLogger.debug).not.toHaveBeenCalled();
  });

  it('slow above threshold → exactly ONE pino-debug slow_query emit', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const result = withQueryTiming('test.slow', () => {
      now = 150;
      return 42;
    });
    expect(result).toBe(42);
    expect(mockLogger.debug).toHaveBeenCalledTimes(1);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      { action: 'slow_query', queryName: 'test.slow', durationMs: 150 },
      'slow_query',
    );
  });

  it('throw path: emits if duration > threshold AND rethrows', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    expect(() =>
      withQueryTiming('test.throwslow', () => {
        now = 200;
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(mockLogger.debug).toHaveBeenCalledTimes(1);
    expect(mockLogger.debug.mock.calls[0][0]).toMatchObject({
      action: 'slow_query',
      queryName: 'test.throwslow',
    });
  });

  it('threshold-edge: durationMs === SLOW_QUERY_MS → NO emit (strict greater-than)', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    withQueryTiming('test.edge', () => {
      now = SLOW_QUERY_MS;
      return null;
    });
    expect(mockLogger.debug).not.toHaveBeenCalled();
  });
});
