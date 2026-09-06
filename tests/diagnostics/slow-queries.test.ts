// @vitest-environment node
// 22-01 T3 IMP-3: slow_query ring-tail-scanner tests.
// AC-5 contract: payload.slowQueries = { topN[≤maxOut], tailLimit, maxOut }.
// 38-02: + end-to-end gate-survival test through the REAL logger singleton (M1)
// proving the WARN emit survives the `LOG_LEVEL ?? 'info'` instance gate and
// lands in the ring-buffer — the precise blind spot that left this surface dark
// from 22-01 through 38-02 (assembleSlowQueries ignores `level`, so a synthetic
// line passes regardless of the real emit level).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assembleSlowQueries } from '@/src/lib/diagnostics/slow-queries';
import { tail, _resetForTesting } from '@/src/lib/log/ring-buffer';
import { logger } from '@/src/lib/logger';
import { withQueryTiming, __forTests_resetSlowQueryMs } from '@/src/lib/db/timing';

function buffer(lines: string[]): { lines: string[]; totalLines: number; totalBytes: number } {
  return {
    lines,
    totalLines: lines.length,
    totalBytes: lines.reduce((n, l) => n + l.length, 0),
  };
}

describe('22-01 T3: assembleSlowQueries', () => {
  it('empty ring → topN.length === 0', () => {
    const result = assembleSlowQueries({ ringTail: () => buffer([]) });
    expect(result.topN).toEqual([]);
    expect(result.tailLimit).toBe(500);
    expect(result.maxOut).toBe(20);
  });

  it('happy 3 entries sorted desc by durationMs', () => {
    const result = assembleSlowQueries({
      ringTail: () =>
        buffer([
          JSON.stringify({
            msg: 'slow_query',
            time: 1000,
            queryName: 'fileRepo.listPaginated',
            durationMs: 250,
          }),
          JSON.stringify({
            msg: 'slow_query',
            time: 2000,
            queryName: 'statsRepo.getKpis',
            durationMs: 800,
          }),
          JSON.stringify({
            msg: 'slow_query',
            time: 3000,
            queryName: 'shareRepo.listAll',
            durationMs: 400,
          }),
        ]),
    });
    expect(result.topN).toHaveLength(3);
    expect(result.topN[0].queryName).toBe('statsRepo.getKpis');
    expect(result.topN[0].durationMs).toBe(800);
    expect(result.topN[2].queryName).toBe('fileRepo.listPaginated');
  });

  it('caps at maxOut when ring has 30 entries', () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify({
        msg: 'slow_query',
        time: i,
        queryName: `repo.q${i}`,
        durationMs: 100 + i,
      }),
    );
    const result = assembleSlowQueries({ ringTail: () => buffer(lines), maxOut: 7 });
    expect(result.topN).toHaveLength(7);
    expect(result.topN.map((r) => r.durationMs)).toEqual([129, 128, 127, 126, 125, 124, 123]);
  });

  it('filters malformed (non-msg / missing queryName / non-number duration)', () => {
    const result = assembleSlowQueries({
      ringTail: () =>
        buffer([
          'not-json',
          JSON.stringify({ msg: 'slow_request', durationMs: 9999 }),
          JSON.stringify({ msg: 'slow_query', durationMs: 1234 }), // no queryName
          JSON.stringify({ msg: 'slow_query', queryName: 'x', durationMs: 'NaN' }),
          JSON.stringify({ msg: 'slow_query', queryName: 'ok', durationMs: 200 }),
        ]),
    });
    expect(result.topN).toHaveLength(1);
    expect(result.topN[0].queryName).toBe('ok');
  });

  it('honors tailLimit dep (default 500)', () => {
    let captured = -1;
    assembleSlowQueries({
      ringTail: (n: number) => {
        captured = n;
        return buffer([]);
      },
    });
    expect(captured).toBe(500);
  });
});

describe('38-02 M1: slow_query WARN survives the real instance gate end-to-end', () => {
  beforeEach(() => {
    delete process.env.SLOW_QUERY_MS;
    __forTests_resetSlowQueryMs();
    _resetForTesting();
  });

  afterEach(() => {
    __forTests_resetSlowQueryMs();
    _resetForTesting();
  });

  it('drives the REAL logger → info gate → multistream → ring-buffer → assembleSlowQueries (non-empty)', () => {
    // The production gate condition: warn (40) must survive the `info` (30)
    // instance level. If the surface were reverted to logger.debug (20) this
    // assertion FAILS — that is the regression guard (the synthetic-line test
    // below cannot catch it because assembleSlowQueries ignores `level`).
    expect(logger.isLevelEnabled('warn')).toBe(true);

    // Real wrapped query that busy-waits past the 100ms default threshold.
    withQueryTiming('e2e.slowQuery', () => {
      const t = performance.now();
      while (performance.now() - t < 130) {
        /* spin to exceed the 100ms threshold */
      }
      return 'done';
    });

    // FULL chain assertion: the line is physically in the ring-buffer …
    const tailLines = tail(500).lines;
    const hasRingLine = tailLines.some((l) => {
      try {
        const o = JSON.parse(l);
        return o.msg === 'slow_query' && o.queryName === 'e2e.slowQuery';
      } catch {
        return false;
      }
    });
    expect(hasRingLine).toBe(true);

    // … and the consumer surfaces it into topN (no longer always []).
    const block = assembleSlowQueries();
    const entry = block.topN.find((e) => e.queryName === 'e2e.slowQuery');
    expect(entry).toBeDefined();
    expect(entry!.durationMs).toBeGreaterThan(100);
  });
});

describe('38-02 supplementary: synthetic WARN-shaped line parses (consumer field-match)', () => {
  // NOT the gate guard — a fast shape-parse check that the exact object the warn
  // emit produces ({level:40, action, queryName, durationMs, msg}) is decoded.
  it('warn-shaped synthetic line → topN entry', () => {
    const result = assembleSlowQueries({
      ringTail: () =>
        buffer([
          JSON.stringify({
            level: 40,
            time: 1717000000000,
            action: 'slow_query',
            queryName: 'statsRepo.getKpis',
            durationMs: 512,
            msg: 'slow_query',
          }),
        ]),
    });
    expect(result.topN).toHaveLength(1);
    expect(result.topN[0].queryName).toBe('statsRepo.getKpis');
    expect(result.topN[0].durationMs).toBe(512);
  });
});
