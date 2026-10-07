// @vitest-environment node
// Stall watchdog: an encode whose output position stops advancing for the
// configured time is reported once. The clock and the interval are injected so
// the timing is exact; the kill switch follows the repo pattern (`=== '1'`,
// memoized, one info line).

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createStallWatchdog,
  resolveStallDetectionEnabled,
  stallDetectionEnabled,
  __forTests_resetStallDetectionCache,
} from '@/src/lib/encode/stall-watchdog';
import {
  DEFAULT_STALL_TIMEOUT_MINUTES,
  MAX_STALL_TIMEOUT_MINUTES,
  MIN_STALL_TIMEOUT_MINUTES,
  parseStallTimeoutMinutes,
} from '@/src/lib/encode/stall-defaults';
import { logger } from '@/src/lib/logger';

const MIN = 60_000;

function harness(timeoutMs: number, checkEveryMs = 1_000) {
  let now = 0;
  const intervals: Array<{ fn: () => void; every: number; cleared: boolean }> = [];
  const onStall = vi.fn();
  const watchdog = createStallWatchdog({
    timeoutMs,
    onStall,
    checkEveryMs,
    now: () => now,
    setInterval: (fn, every) => {
      const h = { fn, every, cleared: false };
      intervals.push(h);
      return h;
    },
    clearInterval: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  const advance = (ms: number) => {
    const target = now + ms;
    while (now < target) {
      now = Math.min(target, now + checkEveryMs);
      for (const h of intervals) if (!h.cleared) h.fn();
    }
  };
  const active = () => intervals.filter((h) => !h.cleared).length;
  return { watchdog, onStall, advance, active, setNow: (n: number) => (now = n) };
}

describe('createStallWatchdog', () => {
  it('reports a stall when no progress event arrives at all', () => {
    const h = harness(10 * MIN);
    h.advance(10 * MIN);
    expect(h.onStall).toHaveBeenCalledTimes(1);
  });

  it('stays quiet one second before the deadline', () => {
    const h = harness(10 * MIN);
    h.advance(10 * MIN - 1_000);
    expect(h.onStall).not.toHaveBeenCalled();
  });

  it('a growing output position resets the deadline', () => {
    const h = harness(10 * MIN);
    h.advance(9 * MIN);
    h.watchdog.observe(5_000);
    h.advance(9 * MIN);
    expect(h.onStall).not.toHaveBeenCalled();
    h.advance(1 * MIN);
    expect(h.onStall).toHaveBeenCalledTimes(1);
  });

  it('repeated, smaller or missing positions do not count as progress', () => {
    const h = harness(10 * MIN);
    h.watchdog.observe(60_000);
    h.advance(3 * MIN);
    h.watchdog.observe(60_000);
    h.advance(3 * MIN);
    h.watchdog.observe(30_000);
    h.advance(3 * MIN);
    h.watchdog.observe(null);
    h.advance(1 * MIN);
    expect(h.onStall).toHaveBeenCalledTimes(1);
  });

  it('reports only once and removes its timer afterwards', () => {
    const h = harness(2 * MIN);
    h.advance(20 * MIN);
    expect(h.onStall).toHaveBeenCalledTimes(1);
    expect(h.active()).toBe(0);
  });

  it('stop() removes the timer and prevents a later report', () => {
    const h = harness(2 * MIN);
    h.watchdog.stop();
    h.advance(20 * MIN);
    expect(h.onStall).not.toHaveBeenCalled();
    expect(h.active()).toBe(0);
  });

  it('a timeout of zero never reports and starts no timer', () => {
    const h = harness(0);
    h.advance(60 * MIN);
    expect(h.onStall).not.toHaveBeenCalled();
    expect(h.active()).toBe(0);
  });

  it('checks on its own timer, independent of progress events', () => {
    const onStall = vi.fn();
    const every: number[] = [];
    createStallWatchdog({
      timeoutMs: 10 * MIN,
      onStall,
      now: () => 0,
      setInterval: (_fn, ms) => {
        every.push(ms);
        return {};
      },
      clearInterval: () => {},
    });
    // Default check period: a quarter of the timeout, at most 30 seconds.
    expect(every).toEqual([30_000]);
  });
});

describe('stall timeout setting', () => {
  it('defaults and limits', () => {
    expect(DEFAULT_STALL_TIMEOUT_MINUTES).toBe(10);
    expect(MIN_STALL_TIMEOUT_MINUTES).toBe(2);
    expect(MAX_STALL_TIMEOUT_MINUTES).toBe(720);
  });

  it.each([
    [undefined, 10],
    ['', 10],
    ['0', 0],
    ['2', 2],
    ['720', 720],
    ['1', 10],
    ['721', 10],
    ['5.5', 10],
    ['abc', 10],
    ['-3', 10],
  ])('parses %s as %s (invalid values fall back to the default)', (raw, expected) => {
    expect(parseStallTimeoutMinutes(raw)).toBe(expected);
  });
});

describe('stall detection kill switch', () => {
  const orig = process.env.ENCODE_STALL_DETECTION_DISABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.ENCODE_STALL_DETECTION_DISABLED;
    else process.env.ENCODE_STALL_DETECTION_DISABLED = orig;
    __forTests_resetStallDetectionCache();
    vi.restoreAllMocks();
  });

  it.each([
    ['1', false],
    [' 1 ', false],
    [undefined, true],
    ['', true],
    ['0', true],
    ['true', true],
    ['yes', true],
  ])('raw %s gives enabled=%s', (raw, enabled) => {
    expect(resolveStallDetectionEnabled(raw)).toBe(enabled);
  });

  it('is memoized and logs exactly one info line, never debug', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never);
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => logger as never);
    process.env.ENCODE_STALL_DETECTION_DISABLED = '1';
    expect(stallDetectionEnabled()).toBe(false);
    process.env.ENCODE_STALL_DETECTION_DISABLED = '0';
    expect(stallDetectionEnabled()).toBe(false);
    const lines = info.mock.calls.filter(
      (c) => (c[0] as { action?: string }).action === 'stall_detection_resolved',
    );
    expect(lines).toHaveLength(1);
    expect(debug).not.toHaveBeenCalled();
  });
});
