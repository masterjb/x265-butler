// @vitest-environment node
// 22-01 T4 IMP-4: assembleWebVitals ring-tail scanner tests.

import { describe, it, expect } from 'vitest';
import { assembleWebVitals } from '@/src/lib/diagnostics/web-vitals';

function buffer(lines: string[]): { lines: string[]; totalLines: number; totalBytes: number } {
  return {
    lines,
    totalLines: lines.length,
    totalBytes: lines.reduce((n, l) => n + l.length, 0),
  };
}

describe('22-01 T4: assembleWebVitals', () => {
  it('empty ring → byRoute = {}', () => {
    const result = assembleWebVitals({ ringTail: () => buffer([]) });
    expect(result.byRoute).toEqual({});
    expect(result.tailLimit).toBe(500);
    expect(result.sampleCapPerRoute).toBe(50);
  });

  it('happy: 5 samples per metric per route → p75 computed', () => {
    const lines: string[] = [];
    for (const v of [100, 200, 300, 400, 500]) {
      lines.push(
        JSON.stringify({
          msg: 'web_vital_captured',
          route: '/library',
          metric: 'ttfb',
          value: v,
        }),
      );
    }
    const result = assembleWebVitals({ ringTail: () => buffer(lines) });
    expect(result.byRoute['/library'].ttfb).toBeDefined();
    expect(result.byRoute['/library'].ttfb!.sampleSize).toBe(5);
    // audit-M3 ceil percentile: n=5, p=75 → idx=ceil(3.75)-1=3 → sorted[3]=400.
    expect(result.byRoute['/library'].ttfb!.p75).toBe(400);
  });

  it('audit-M3 percentile math: n=20 [100..2000] → p75 === 1500', () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      JSON.stringify({
        msg: 'web_vital_captured',
        route: '/x',
        metric: 'lcp',
        value: 100 * (i + 1),
      }),
    );
    const result = assembleWebVitals({ ringTail: () => buffer(lines) });
    expect(result.byRoute['/x'].lcp!.p75).toBe(1500);
  });

  it('audit-M5 reverse-iter retention: 120-sample [120..1] reverse keeps newest 50, p75=38', () => {
    // emit values [120, 119, ..., 1] in append-order
    const lines: string[] = [];
    for (let v = 120; v >= 1; v--) {
      lines.push(
        JSON.stringify({ msg: 'web_vital_captured', route: '/y', metric: 'inp', value: v }),
      );
    }
    // Reverse-iter means we KEEP the LAST-appended 50 (= values [50..1]).
    // n=50, p75 → idx=ceil(37.5)-1=37 → sorted ascending [1..50] → sorted[37]=38.
    const result = assembleWebVitals({
      ringTail: () => buffer(lines),
      sampleCapPerRoute: 50,
    });
    expect(result.byRoute['/y'].inp!.sampleSize).toBe(50);
    expect(result.byRoute['/y'].inp!.p75).toBe(38);
  });

  it('filters malformed entries (non-msg / unknown metric / bad value)', () => {
    const result = assembleWebVitals({
      ringTail: () =>
        buffer([
          'not-json',
          JSON.stringify({ msg: 'slow_request', route: '/x', metric: 'ttfb', value: 100 }),
          JSON.stringify({ msg: 'web_vital_captured', route: '/x', metric: 'cls', value: 0.1 }),
          JSON.stringify({
            msg: 'web_vital_captured',
            route: '/x',
            metric: 'ttfb',
            value: 'NaN',
          }),
          JSON.stringify({ msg: 'web_vital_captured', route: '/x', metric: 'lcp', value: 1500 }),
        ]),
    });
    expect(result.byRoute['/x'].lcp!.p75).toBe(1500);
    expect(result.byRoute['/x'].ttfb).toBeUndefined();
  });
});
