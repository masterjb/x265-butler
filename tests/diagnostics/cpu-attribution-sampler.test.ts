// @vitest-environment node
// 40-01 T1: headless cpu_attribution sampler tests.
// AC-1/2/3/6/7/8/9. Covers: tick emits one AC-2-shaped event; pure level-picker
// (warn over threshold / info under); kill-switch suppresses timer+events;
// thrown listActive does not kill subsequent ticks; AC-9 gate-survival END-TO-END
// through the REAL logger → ring-buffer (FAILS on a debug revert); idempotent
// double-start guard (AC-8).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockListActive } = vi.hoisted(() => ({
  mockListActive: vi.fn<() => unknown[]>(),
}));

// Mock the DB barrel so the per-tick jobRepo().listActive() is controllable and
// no real SQLite is touched.
vi.mock('@/src/lib/db', () => ({
  jobRepo: () => ({ listActive: mockListActive }),
}));

import { logger } from '@/src/lib/logger';
import { tail, _resetForTesting } from '@/src/lib/log/ring-buffer';
import { assembleCpuAttribution } from '@/src/lib/diagnostics/cpu-attribution';
import {
  startCpuAttributionSampler,
  stopCpuAttributionSampler,
  pickCpuAttributionLevel,
  __forTests_resetCpuAttributionSampler,
} from '@/src/lib/diagnostics/cpu-attribution-sampler';

function cpuAttrCalls(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
  // sampler also logs resolution lines at info; keep only the tick emits whose
  // pino msg (2nd arg) is the literal 'cpu_attribution'.
  return spy.mock.calls.filter((c) => c[1] === 'cpu_attribution');
}

beforeEach(() => {
  vi.useFakeTimers();
  delete process.env.CPU_ATTRIBUTION_DISABLED;
  delete process.env.CPU_ATTRIBUTION_LAG_WARN_MS;
  delete process.env.CPU_ATTRIBUTION_INTERVAL_MS;
  __forTests_resetCpuAttributionSampler();
  _resetForTesting();
  mockListActive.mockReset();
  mockListActive.mockReturnValue([]);
});

afterEach(() => {
  __forTests_resetCpuAttributionSampler();
  _resetForTesting();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('40-01 T1: pickCpuAttributionLevel (AC-3 pure gate decision)', () => {
  it('p99 over threshold → warn, under/equal → info', () => {
    expect(pickCpuAttributionLevel(51, 50)).toBe('warn');
    expect(pickCpuAttributionLevel(50, 50)).toBe('info');
    expect(pickCpuAttributionLevel(0, 50)).toBe('info');
  });
});

describe('40-01 T1: startCpuAttributionSampler', () => {
  it('AC-1/AC-2: a tick emits exactly one cpu_attribution event with all AC-2 fields', () => {
    const infoSpy = vi.spyOn(logger, 'info');
    mockListActive.mockReturnValue([{}, {}]); // 2 active encodes

    startCpuAttributionSampler();
    vi.advanceTimersByTime(15000); // default interval

    const emits = cpuAttrCalls(infoSpy);
    expect(emits).toHaveLength(1);
    const payload = emits[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      action: 'cpu_attribution',
      activeEncodes: 2,
    });
    for (const key of [
      'eventLoopLagP50Ms',
      'eventLoopLagP99Ms',
      'eventLoopLagMaxMs',
      'cpuUserPctCore',
      'cpuSysPctCore',
      'activeEncodes',
      'uptimeSec',
    ]) {
      expect(typeof payload[key]).toBe('number');
    }
  });

  it('AC-6: CPU_ATTRIBUTION_DISABLED=1 → zero timers, zero cpu_attribution events', () => {
    process.env.CPU_ATTRIBUTION_DISABLED = '1';
    __forTests_resetCpuAttributionSampler();
    const infoSpy = vi.spyOn(logger, 'info');

    startCpuAttributionSampler();
    expect(vi.getTimerCount()).toBe(0); // no setInterval created
    vi.advanceTimersByTime(60000);

    expect(cpuAttrCalls(infoSpy)).toHaveLength(0);
    // the disabled breadcrumb is emitted exactly once
    expect(
      infoSpy.mock.calls.filter((c) => c[1] === 'cpu_attribution_sampler_disabled'),
    ).toHaveLength(1);
  });

  it('AC-7/AC-8: idempotent — a second start creates no second timer', () => {
    startCpuAttributionSampler();
    expect(vi.getTimerCount()).toBe(1);
    startCpuAttributionSampler();
    expect(vi.getTimerCount()).toBe(1); // still ONE timer
  });

  it('a thrown listActive does not stop subsequent ticks', () => {
    const infoSpy = vi.spyOn(logger, 'info');
    mockListActive.mockImplementation(() => {
      throw new Error('db blip');
    });

    startCpuAttributionSampler();
    vi.advanceTimersByTime(15000);
    vi.advanceTimersByTime(15000);

    const emits = cpuAttrCalls(infoSpy);
    expect(emits.length).toBe(2); // both ticks still emitted
    // listActive throw → activeEncodes coerced to 0, sampler survives
    expect((emits[0][0] as Record<string, unknown>).activeEncodes).toBe(0);
  });

  it('AC-9 gate-survival: a REAL tick lands in the ring-buffer and decodes (FAILS on a debug revert)', () => {
    // No spy/mocking of the logger — drive the production path through the REAL
    // pino singleton at `LOG_LEVEL ?? 'info'`. If the emit were reverted to
    // logger.debug (20) it would be dropped at the info (30) instance gate BEFORE
    // the ring-buffer writer → assembleCpuAttribution().latest stays null → this
    // FAILS. That is the carry-forward of the 38-02 audit M1 (the synthetic-line
    // + spy checks above cannot catch a wrong gate level).
    expect(logger.isLevelEnabled('info')).toBe(true);

    startCpuAttributionSampler();
    vi.advanceTimersByTime(15000);

    const ringHasLine = tail(500).lines.some((l) => {
      try {
        return JSON.parse(l).msg === 'cpu_attribution';
      } catch {
        return false;
      }
    });
    expect(ringHasLine).toBe(true);

    const block = assembleCpuAttribution();
    expect(block.latest).not.toBeNull();
    expect(block.sampleCount).toBeGreaterThanOrEqual(1);
  });

  it('stopCpuAttributionSampler clears the timer (no further emits)', () => {
    const infoSpy = vi.spyOn(logger, 'info');
    startCpuAttributionSampler();
    vi.advanceTimersByTime(15000);
    const before = cpuAttrCalls(infoSpy).length;
    stopCpuAttributionSampler();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60000);
    expect(cpuAttrCalls(infoSpy).length).toBe(before); // no new emits
  });
});
