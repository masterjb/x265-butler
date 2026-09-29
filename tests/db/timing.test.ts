// @vitest-environment node
// 22-01 T3 IMP-3: withQueryTiming helper tests.
// AC-4 contract: helper emits `slow_query` iff durationMs > threshold;
// pass-through return-value; rethrow on throw.
// 38-02: emit flipped debug → WARN (survives the `LOG_LEVEL ?? 'info'` instance
// gate so it reaches the ring-buffer); SLOW_QUERY_MS env override + memoized
// resolveSlowQueryMs (AC-1/AC-2/AC-3).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/src/lib/logger', () => ({ logger: mockLogger }));

import {
  withQueryTiming,
  resolveSlowQueryMs,
  SLOW_QUERY_MS,
  __forTests_resetSlowQueryMs,
} from '@/src/lib/db/timing';

const ORIGINAL_ENV = process.env.SLOW_QUERY_MS;

describe('22-01 T3 / 38-02: withQueryTiming', () => {
  beforeEach(() => {
    mockLogger.debug.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.info.mockReset();
    delete process.env.SLOW_QUERY_MS;
    __forTests_resetSlowQueryMs();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.SLOW_QUERY_MS;
    else process.env.SLOW_QUERY_MS = ORIGINAL_ENV;
    __forTests_resetSlowQueryMs();
  });

  it('happy under threshold → no emit, return-value pass-through', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const result = withQueryTiming('test.fast', () => {
      now = 50; // 50ms < 100ms threshold
      return { rows: ['a', 'b'], total: 2 };
    });
    expect(result).toEqual({ rows: ['a', 'b'], total: 2 });
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.debug).not.toHaveBeenCalled();
  });

  it('slow above threshold → exactly ONE WARN slow_query emit (38-02: was debug)', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const result = withQueryTiming('test.slow', () => {
      now = 150;
      return 42;
    });
    expect(result).toBe(42);
    expect(mockLogger.debug).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { action: 'slow_query', queryName: 'test.slow', durationMs: 150 },
      'slow_query',
    );
  });

  it('throw path: emits WARN if duration > threshold AND rethrows', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    expect(() =>
      withQueryTiming('test.throwslow', () => {
        now = 200;
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0][0]).toMatchObject({
      action: 'slow_query',
      queryName: 'test.throwslow',
    });
  });

  it('threshold-edge: durationMs === threshold → NO emit (strict greater-than)', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    withQueryTiming('test.edge', () => {
      now = SLOW_QUERY_MS;
      return null;
    });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

describe('38-02: resolveSlowQueryMs env-override resolver (AC-2)', () => {
  beforeEach(() => {
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    delete process.env.SLOW_QUERY_MS;
    __forTests_resetSlowQueryMs();
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.SLOW_QUERY_MS;
    else process.env.SLOW_QUERY_MS = ORIGINAL_ENV;
    __forTests_resetSlowQueryMs();
  });

  it('unset → 100 default, audit-info source=default', () => {
    expect(resolveSlowQueryMs()).toBe(100);
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      { action: 'slow_query_threshold_resolved', resolvedMs: 100, source: 'default' },
      'slow_query_threshold_resolved',
    );
  });

  it('valid positive integer "250" → 250 verbatim, audit-info source=env', () => {
    process.env.SLOW_QUERY_MS = '250';
    expect(resolveSlowQueryMs()).toBe(250);
    expect(mockLogger.info).toHaveBeenCalledWith(
      { action: 'slow_query_threshold_resolved', resolvedMs: 250, source: 'env' },
      'slow_query_threshold_resolved',
    );
  });

  it.each(['0', '-5', '7.5', 'abc', ''])('invalid "%s" → 100 default (reject-not-clamp)', (val) => {
    process.env.SLOW_QUERY_MS = val;
    expect(resolveSlowQueryMs()).toBe(100);
    expect(mockLogger.info).toHaveBeenCalledWith(
      { action: 'slow_query_threshold_resolved', resolvedMs: 100, source: 'default' },
      'slow_query_threshold_resolved',
    );
  });

  it('memoized: second call does not re-read env nor re-log', () => {
    process.env.SLOW_QUERY_MS = '300';
    expect(resolveSlowQueryMs()).toBe(300);
    // Flip the env AFTER first resolve — memo must ignore it.
    process.env.SLOW_QUERY_MS = '900';
    expect(resolveSlowQueryMs()).toBe(300);
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
  });

  it('env threshold actually gates the emit (override 250 → 150ms query stays silent)', () => {
    process.env.SLOW_QUERY_MS = '250';
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    withQueryTiming('test.under-override', () => {
      now = 150; // > 100 default but ≤ 250 override → silent
      return null;
    });
    expect(mockLogger.warn).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
