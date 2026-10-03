// @vitest-environment node
// 22-01 T2 IMP-2: slow_request ring-tail-scanner tests.
// AC-3 contract: payload.slowRequests = { topN[≤maxOut], tailLimit, maxOut }.

import { describe, it, expect } from 'vitest';
import { assembleSlowRequests } from '@/src/lib/diagnostics/slow-requests';

function buffer(lines: string[]): { lines: string[]; totalLines: number; totalBytes: number } {
  return {
    lines,
    totalLines: lines.length,
    totalBytes: lines.reduce((n, l) => n + l.length, 0),
  };
}

describe('22-01 T2: assembleSlowRequests', () => {
  it('empty ring → topN.length === 0', () => {
    const result = assembleSlowRequests({ ringTail: () => buffer([]) });
    expect(result.topN).toEqual([]);
    expect(result.tailLimit).toBe(200);
    expect(result.maxOut).toBe(20);
  });

  it('happy 3 entries sorted desc by durationMs', () => {
    const result = assembleSlowRequests({
      ringTail: () =>
        buffer([
          JSON.stringify({
            msg: 'slow_request',
            time: 1000,
            route: '/library',
            durationMs: 1500,
            breakdown: { listPaginated: 1200, countByStatus: 100 },
          }),
          JSON.stringify({
            msg: 'slow_request',
            time: 2000,
            route: '/dashboard',
            durationMs: 2500,
            breakdown: { stats: 1800 },
          }),
          JSON.stringify({
            msg: 'slow_request',
            time: 3000,
            route: '/stats',
            durationMs: 1800,
          }),
        ]),
    });
    expect(result.topN).toHaveLength(3);
    expect(result.topN[0].route).toBe('/dashboard');
    expect(result.topN[0].durationMs).toBe(2500);
    expect(result.topN[1].route).toBe('/stats');
    expect(result.topN[2].route).toBe('/library');
    expect(result.topN[0].atIso).toBe(new Date(2000).toISOString());
    expect(result.topN[2].breakdown).toEqual({ listPaginated: 1200, countByStatus: 100 });
    expect(result.topN[1].breakdown).toBeUndefined();
  });

  it('caps at maxOut when ring has 30 entries', () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify({
        msg: 'slow_request',
        time: i,
        route: `/r${i}`,
        durationMs: 1000 + i,
      }),
    );
    const result = assembleSlowRequests({ ringTail: () => buffer(lines), maxOut: 5 });
    expect(result.topN).toHaveLength(5);
    expect(result.topN.map((r) => r.durationMs)).toEqual([1029, 1028, 1027, 1026, 1025]);
    expect(result.maxOut).toBe(5);
  });

  it('filters malformed entries (missing route / non-number durationMs / non-msg)', () => {
    const result = assembleSlowRequests({
      ringTail: () =>
        buffer([
          'not-json',
          JSON.stringify({ msg: 'other_message', route: '/x', durationMs: 9999 }),
          JSON.stringify({ msg: 'slow_request', durationMs: 1234 }), // no route
          JSON.stringify({ msg: 'slow_request', route: '/x', durationMs: 'NaN' }), // bad type
          JSON.stringify({ msg: 'slow_request', route: 42, durationMs: 1000 }), // route wrong type
          JSON.stringify({
            msg: 'slow_request',
            time: 1,
            route: '/ok',
            durationMs: 1500,
          }),
        ]),
    });
    expect(result.topN).toHaveLength(1);
    expect(result.topN[0].route).toBe('/ok');
  });

  it('honors tailLimit dep', () => {
    let capturedLimit = -1;
    assembleSlowRequests({
      tailLimit: 77,
      ringTail: (n: number) => {
        capturedLimit = n;
        return buffer([]);
      },
    });
    expect(capturedLimit).toBe(77);
  });

  it('handles ringTail throw → returns empty block (decoder-only contract)', () => {
    const result = assembleSlowRequests({
      ringTail: () => {
        throw new Error('ring unavailable');
      },
    });
    expect(result.topN).toEqual([]);
    expect(result.tailLimit).toBe(200);
    expect(result.maxOut).toBe(20);
  });
});
