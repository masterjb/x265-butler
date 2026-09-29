// @vitest-environment node
// 40-01 T1: headless cpu_attribution sampler tests.
// AC-1/2/3/6/7/8/9. Covers: tick emits one AC-2-shaped event; pure level-picker
// (warn over threshold / telemetry under); kill-switch suppresses timer+events;
// thrown listActive does not kill subsequent ticks; AC-9 gate-survival END-TO-END
// through the REAL logger → ring-buffer (FAILS on a debug revert); idempotent
// double-start guard (AC-8).
//
// 49-04: the QUIET branch moved from `logger.info` to `logger.telemetry` (25) —
// still recorded in the ring, no longer on stdout. The spies below follow it.
// The WARN branch is deliberately untouched.

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

/** The quiet-branch emitter since 49-04. */
function spyOnTelemetry(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(logger, 'telemetry') as unknown as ReturnType<typeof vi.spyOn>;
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
  it('p99 over threshold → warn, under/equal → telemetry', () => {
    // 49-04 AC-13: the quiet branch is now the telemetry tier. The threshold
    // semantics (STRICTLY greater) are unchanged from 40-01 — only the name of
    // the quiet level moved.
    expect(pickCpuAttributionLevel(51, 50)).toBe('warn');
    expect(pickCpuAttributionLevel(50, 50)).toBe('telemetry');
    expect(pickCpuAttributionLevel(0, 50)).toBe('telemetry');
  });
});

describe('40-01 T1: startCpuAttributionSampler', () => {
  it('AC-1/AC-2: a tick emits exactly one cpu_attribution event with all AC-2 fields', () => {
    const teleSpy = spyOnTelemetry();
    // 48-03: listActive() returns queued+encoding rows, so the mock rows carry a
    // status and activeEncodes reports the encoding-only subset.
    mockListActive.mockReturnValue([{ status: 'encoding' }, { status: 'encoding' }]);

    startCpuAttributionSampler();
    vi.advanceTimersByTime(15000); // default interval

    const emits = cpuAttrCalls(teleSpy);
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

  it('AC-2 (49-04): a janky tick still emits at pino level 40 into the ring — the loud branch is untouched', async () => {
    // The 15s spam came from the UNINTERESTING ticks. A janky loop keeps
    // shouting in the container log; moving THIS branch too would have thrown
    // away the signal along with the noise.
    //
    // REAL timers on purpose: monitorEventLoopDelay only records lag the actual
    // loop suffered, and vi.useFakeTimers() also fakes Date.now/performance.now,
    // so under fake timers the histogram p99 is always ~0 and the warn branch is
    // unreachable. Short interval + a genuine synchronous block instead.
    vi.useRealTimers();
    process.env.CPU_ATTRIBUTION_LAG_WARN_MS = '1';
    process.env.CPU_ATTRIBUTION_INTERVAL_MS = '40';
    __forTests_resetCpuAttributionSampler();
    _resetForTesting();

    startCpuAttributionSampler();
    const spin = Date.now();
    while (Date.now() - spin < 80) {
      /* block the loop so the histogram records lag well above the 1ms threshold */
    }
    await new Promise((r) => setTimeout(r, 120));
    stopCpuAttributionSampler();

    const levels = tail(500).lines.flatMap((l) => {
      try {
        const p = JSON.parse(l) as { msg?: string; level?: number };
        return p.msg === 'cpu_attribution' ? [p.level] : [];
      } catch {
        return [];
      }
    });
    expect(levels.length).toBeGreaterThanOrEqual(1);
    // 40 == warn, byte-identical to 40-01. NOT 25 — a janky tick is not quiet.
    expect(levels).toContain(40);
  });

  it('AC-6: CPU_ATTRIBUTION_DISABLED=1 → zero timers, zero cpu_attribution events', () => {
    process.env.CPU_ATTRIBUTION_DISABLED = '1';
    __forTests_resetCpuAttributionSampler();
    const infoSpy = vi.spyOn(logger, 'info');
    const teleSpy = spyOnTelemetry();

    startCpuAttributionSampler();
    expect(vi.getTimerCount()).toBe(0); // no setInterval created
    vi.advanceTimersByTime(60000);

    expect(cpuAttrCalls(teleSpy)).toHaveLength(0);
    // the disabled breadcrumb is emitted exactly once — still at info (an
    // operator-facing one-shot, not periodic telemetry)
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
    const teleSpy = spyOnTelemetry();
    mockListActive.mockImplementation(() => {
      throw new Error('db blip');
    });

    startCpuAttributionSampler();
    vi.advanceTimersByTime(15000);
    vi.advanceTimersByTime(15000);

    const emits = cpuAttrCalls(teleSpy);
    expect(emits.length).toBe(2); // both ticks still emitted
    // listActive throw → activeEncodes coerced to 0, sampler survives
    expect((emits[0][0] as Record<string, unknown>).activeEncodes).toBe(0);
  });

  it('48-03 AC-22: activeEncodes reports encoding-only, not queued+encoding', () => {
    // The reported v2.44.0 state: 4 running encodes, 995 waiting jobs. listActive()
    // returns all 999 rows; activeEncodes must say 4. The value reaches
    // /api/diagnostics.cpuAttribution and the copy-report pasted into the forum —
    // "activeEncodes: 999" would spoil exactly that reconstruction.
    const teleSpy = spyOnTelemetry();
    mockListActive.mockReturnValue([
      ...Array.from({ length: 4 }, () => ({ status: 'encoding' })),
      ...Array.from({ length: 995 }, () => ({ status: 'queued' })),
    ]);

    startCpuAttributionSampler();
    vi.advanceTimersByTime(15000);

    const emits = cpuAttrCalls(teleSpy);
    expect(emits).toHaveLength(1);
    const payload = emits[0][0] as Record<string, unknown>;
    expect(payload.activeEncodes).toBe(4);
    expect(payload.activeEncodes).not.toBe(999);
    // Field name unchanged — parser + copy-report read it.
    expect(payload).toHaveProperty('activeEncodes');
  });

  it('AC-9 gate-survival: a REAL tick lands in the ring-buffer and decodes (FAILS on a debug revert)', () => {
    // No spy/mocking of the logger — drive the production path through the REAL
    // pino singleton. If the emit were reverted to logger.debug (20) it would be
    // dropped BEFORE the ring-buffer writer (the ring stream sits at 25 under the
    // default LOG_LEVEL) → assembleCpuAttribution().latest stays null → this
    // FAILS. That is the carry-forward of the 38-02 audit M1 (the synthetic-line
    // + spy checks above cannot catch a wrong gate level).
    // 49-04: the precondition tightened from 'info' to 'telemetry' — the emit
    // now rides the lower tier, so THAT is the level that must be enabled.
    expect(logger.isLevelEnabled('telemetry')).toBe(true);

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

  it('AC-7 (49-04): the scanner contract is unchanged — msg + all seven payload fields survive N ticks', () => {
    // End-to-end through the REAL logger into the REAL ring: the tier move must
    // not have touched the pino `msg` (the scanner matches on it, NOT on level)
    // nor any payload field name from 40-01 / 48-03.
    mockListActive.mockReturnValue([{ status: 'encoding' }]);

    startCpuAttributionSampler();
    vi.advanceTimersByTime(15000);
    vi.advanceTimersByTime(15000);
    vi.advanceTimersByTime(15000);

    const block = assembleCpuAttribution();
    expect(block.sampleCount).toBe(3);
    expect(block.latest).not.toBeNull();
    for (const key of [
      'eventLoopLagP50Ms',
      'eventLoopLagP99Ms',
      'eventLoopLagMaxMs',
      'cpuUserPctCore',
      'cpuSysPctCore',
      'activeEncodes',
      'uptimeSec',
    ] as const) {
      expect(typeof block.latest![key]).toBe('number');
    }
    expect(block.latest!.activeEncodes).toBe(1);
    expect(block.topByLagP99.length).toBeGreaterThanOrEqual(1);

    // The literal the scanner keys on — an emit-level change must never move it.
    const rawMsgs = tail(500).lines.flatMap((l) => {
      try {
        return [JSON.parse(l).msg as string];
      } catch {
        return [];
      }
    });
    expect(rawMsgs.filter((m) => m === 'cpu_attribution')).toHaveLength(3);
  });

  it('stopCpuAttributionSampler clears the timer (no further emits)', () => {
    const teleSpy = spyOnTelemetry();
    startCpuAttributionSampler();
    vi.advanceTimersByTime(15000);
    const before = cpuAttrCalls(teleSpy).length;
    stopCpuAttributionSampler();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60000);
    expect(cpuAttrCalls(teleSpy).length).toBe(before); // no new emits
  });
});
