// @vitest-environment node
// 40-01 T2: cpu_attribution ring-tail-scanner tests (AC-4).
// Contract: assembleCpuAttribution() = { latest, topByLagP99, sampleCount,
// tailLimit, maxOut }. Decoder-only over the ring-buffer; never throws.

import { describe, it, expect } from 'vitest';
import { assembleCpuAttribution } from '@/src/lib/diagnostics/cpu-attribution';

function buffer(lines: string[]): { lines: string[]; totalLines: number; totalBytes: number } {
  return {
    lines,
    totalLines: lines.length,
    totalBytes: lines.reduce((n, l) => n + l.length, 0),
  };
}

function sampleLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    msg: 'cpu_attribution',
    time: 1000,
    eventLoopLagP50Ms: 2,
    eventLoopLagP99Ms: 10,
    eventLoopLagMaxMs: 20,
    cpuUserPctCore: 80.5,
    cpuSysPctCore: 12.1,
    activeEncodes: 2,
    uptimeSec: 3600,
    ...over,
  });
}

describe('40-01 T2: assembleCpuAttribution', () => {
  it('empty ring → empty block', () => {
    const result = assembleCpuAttribution({ ringTail: () => buffer([]) });
    expect(result.latest).toBeNull();
    expect(result.topByLagP99).toEqual([]);
    expect(result.sampleCount).toBe(0);
    expect(result.tailLimit).toBe(500);
    expect(result.maxOut).toBe(20);
  });

  it('latest = most-recent (last chronological) decoded sample', () => {
    const result = assembleCpuAttribution({
      ringTail: () =>
        buffer([
          sampleLine({ time: 1000, eventLoopLagP99Ms: 5, activeEncodes: 1 }),
          sampleLine({ time: 2000, eventLoopLagP99Ms: 9, activeEncodes: 2 }),
          sampleLine({ time: 3000, eventLoopLagP99Ms: 3, activeEncodes: 3 }),
        ]),
    });
    expect(result.sampleCount).toBe(3);
    expect(result.latest?.activeEncodes).toBe(3);
    expect(result.latest?.eventLoopLagP99Ms).toBe(3);
    expect(result.latest?.atIso).toBe(new Date(3000).toISOString());
  });

  it('topByLagP99 sorted desc by p99-lag, sliced to maxOut', () => {
    const result = assembleCpuAttribution({
      ringTail: () =>
        buffer([
          sampleLine({ eventLoopLagP99Ms: 5 }),
          sampleLine({ eventLoopLagP99Ms: 40 }),
          sampleLine({ eventLoopLagP99Ms: 12 }),
        ]),
    });
    expect(result.topByLagP99.map((s) => s.eventLoopLagP99Ms)).toEqual([40, 12, 5]);
  });

  it('caps topByLagP99 at maxOut', () => {
    const lines = Array.from({ length: 30 }, (_, i) => sampleLine({ eventLoopLagP99Ms: 100 + i }));
    const result = assembleCpuAttribution({ ringTail: () => buffer(lines), maxOut: 7 });
    expect(result.topByLagP99).toHaveLength(7);
    expect(result.topByLagP99.map((s) => s.eventLoopLagP99Ms)).toEqual([
      129, 128, 127, 126, 125, 124, 123,
    ]);
    expect(result.sampleCount).toBe(30);
  });

  it('ignores non-cpu_attribution lines, malformed JSON, missing p99', () => {
    const result = assembleCpuAttribution({
      ringTail: () =>
        buffer([
          'not-json',
          JSON.stringify({ msg: 'slow_query', durationMs: 9999 }),
          JSON.stringify({ msg: 'cpu_attribution', eventLoopLagP99Ms: 'NaN' }), // non-number
          JSON.stringify({ msg: 'cpu_attribution' }), // no p99
          sampleLine({ eventLoopLagP99Ms: 7 }),
        ]),
    });
    expect(result.sampleCount).toBe(1);
    expect(result.latest?.eventLoopLagP99Ms).toBe(7);
  });

  it('coerces other missing metrics to 0 (only p99 is required)', () => {
    const result = assembleCpuAttribution({
      ringTail: () =>
        buffer([JSON.stringify({ msg: 'cpu_attribution', time: 5, eventLoopLagP99Ms: 8 })]),
    });
    expect(result.latest).toMatchObject({
      eventLoopLagP50Ms: 0,
      eventLoopLagP99Ms: 8,
      eventLoopLagMaxMs: 0,
      cpuUserPctCore: 0,
      cpuSysPctCore: 0,
      activeEncodes: 0,
      uptimeSec: 0,
    });
  });

  it('returns the empty block when ringTail throws (GET stays 200)', () => {
    const result = assembleCpuAttribution({
      ringTail: () => {
        throw new Error('ring boom');
      },
    });
    expect(result.latest).toBeNull();
    expect(result.sampleCount).toBe(0);
  });

  it('honors tailLimit dep (default 500)', () => {
    let captured = -1;
    assembleCpuAttribution({
      ringTail: (n: number) => {
        captured = n;
        return buffer([]);
      },
    });
    expect(captured).toBe(500);
  });
});
