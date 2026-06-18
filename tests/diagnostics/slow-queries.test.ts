// @vitest-environment node
// 22-01 T3 IMP-3: slow_query ring-tail-scanner tests.
// AC-5 contract: payload.slowQueries = { topN[≤maxOut], tailLimit, maxOut }.

import { describe, it, expect } from 'vitest';
import { assembleSlowQueries } from '@/src/lib/diagnostics/slow-queries';

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
