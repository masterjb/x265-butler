/*
 * 48-02 Task 3 (Bundle C) — windowed collapse of auto_scan_watch_error.
 *
 * ACs covered: AC-10 (first-of-window immediate, rest silent, one summary),
 * AC-12 (no leaked timer, escalation state reset), AC-19 (window escalates
 * while the storm persists, resets after a quiet window).
 *
 * The emit/suppress decision is TIMER-driven, never a Date.now() compare — so
 * the whole module is exercisable with fake timers and no wall-clock waits.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  recordWatchError,
  resetWatchErrorAggregator,
  WATCH_ERROR_WINDOW_MS,
  WATCH_ERROR_WINDOW_MAX_MS,
  WATCH_ERROR_SAMPLE_CAP,
  __forTests_getWatchErrorAggregatorState,
} from '@/src/lib/watch/watch-error-aggregator';

function makeLog() {
  return { warn: vi.fn<(obj: Record<string, unknown>, msg: string) => void>() };
}

function summaries(log: ReturnType<typeof makeLog>) {
  return log.warn.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((p) => p.action === 'auto_scan_watch_error_summary');
}

beforeEach(() => {
  vi.useFakeTimers();
  resetWatchErrorAggregator();
});

afterEach(() => {
  resetWatchErrorAggregator();
  vi.useRealTimers();
});

describe('recordWatchError — AC-10', () => {
  it('test_when_500_errors_in_one_window_then_one_emit_and_one_summary', () => {
    const log = makeLog();
    const decisions: string[] = [];
    for (let i = 0; i < 500; i++) {
      decisions.push(recordWatchError({ message: `EACCES /sys/${i}`, code: 'EACCES' }, log));
    }
    expect(decisions.filter((d) => d === 'emit')).toHaveLength(1);
    expect(decisions[0]).toBe('emit');
    expect(decisions.filter((d) => d === 'suppressed')).toHaveLength(499);
    // Nothing is logged BY THE AGGREGATOR until the window closes — the
    // immediate line is the caller's job.
    expect(summaries(log)).toHaveLength(0);

    vi.advanceTimersByTime(WATCH_ERROR_WINDOW_MS);
    const s = summaries(log);
    expect(s).toHaveLength(1);
    expect(s[0].windowMs).toBe(WATCH_ERROR_WINDOW_MS);
    expect(s[0].count).toBe(500);
    expect(s[0].byCode).toEqual({ EACCES: 500 });
    expect((s[0].samples as string[]).length).toBe(WATCH_ERROR_SAMPLE_CAP);
    expect((s[0].samples as string[])[0]).toBe('EACCES /sys/0');
  });

  it('test_when_mixed_codes_then_byCode_tallies_each', () => {
    const log = makeLog();
    recordWatchError({ message: 'a', code: 'EACCES' }, log);
    recordWatchError({ message: 'b', code: 'EPERM' }, log);
    recordWatchError({ message: 'c', code: 'EACCES' }, log);
    recordWatchError({ message: 'd' }, log); // no code
    vi.advanceTimersByTime(WATCH_ERROR_WINDOW_MS);
    expect(summaries(log)[0].byCode).toEqual({ EACCES: 2, EPERM: 1, unknown: 1 });
  });

  it('test_when_single_isolated_error_then_emitted_immediately_and_no_summary', () => {
    const log = makeLog();
    expect(recordWatchError({ message: 'lonely', code: 'EACCES' }, log)).toBe('emit');
    vi.advanceTimersByTime(WATCH_ERROR_WINDOW_MS);
    // A redundant second line for a single error would be noise, not evidence.
    expect(summaries(log)).toHaveLength(0);
  });
});

describe('window escalation — AC-19', () => {
  it('test_when_storm_persists_then_window_doubles_up_to_the_cap', () => {
    const log = makeLog();
    const observed: number[] = [];
    // 8 consecutive non-empty windows: 60s → 120 → 240 → 480 → 900 (cap).
    for (let round = 0; round < 8; round++) {
      recordWatchError({ message: 'x', code: 'EACCES' }, log);
      recordWatchError({ message: 'y', code: 'EACCES' }, log);
      const windowMs = __forTests_getWatchErrorAggregatorState().currentWindowMs;
      observed.push(windowMs);
      vi.advanceTimersByTime(windowMs);
    }
    expect(observed).toEqual([
      60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000, 900_000,
    ]);
    expect(WATCH_ERROR_WINDOW_MAX_MS).toBe(900_000);
    // Every summary carries the windowMs actually used, so a 60 s sample is
    // never misread as a 15 min one.
    expect(summaries(log).map((s) => s.windowMs)).toEqual(observed);
  });

  it('test_steady_state_cost_is_two_lines_per_capped_window', () => {
    const log = makeLog();
    let emits = 0;
    // Drive to the cap first.
    for (let round = 0; round < 5; round++) {
      if (recordWatchError({ message: 'x', code: 'EACCES' }, log) === 'emit') emits++;
      recordWatchError({ message: 'y', code: 'EACCES' }, log);
      vi.advanceTimersByTime(__forTests_getWatchErrorAggregatorState().currentWindowMs);
    }
    const emitsBefore = emits;
    const summariesBefore = summaries(log).length;
    // One more capped window with a thousand errors in it.
    for (let i = 0; i < 1000; i++) {
      if (recordWatchError({ message: 'z', code: 'EACCES' }, log) === 'emit') emits++;
    }
    vi.advanceTimersByTime(WATCH_ERROR_WINDOW_MAX_MS);
    expect(emits - emitsBefore).toBe(1);
    expect(summaries(log).length - summariesBefore).toBe(1);
  });

  it('test_when_a_window_closes_empty_then_length_resets_and_next_error_emits', () => {
    const log = makeLog();
    recordWatchError({ message: 'x', code: 'EACCES' }, log);
    recordWatchError({ message: 'y', code: 'EACCES' }, log);
    vi.advanceTimersByTime(WATCH_ERROR_WINDOW_MS); // non-empty close → 120s + re-arm
    expect(__forTests_getWatchErrorAggregatorState().currentWindowMs).toBe(120_000);
    expect(__forTests_getWatchErrorAggregatorState().windowOpen).toBe(true);

    vi.advanceTimersByTime(120_000); // re-armed window closes EMPTY
    expect(__forTests_getWatchErrorAggregatorState().currentWindowMs).toBe(WATCH_ERROR_WINDOW_MS);
    expect(__forTests_getWatchErrorAggregatorState().windowOpen).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    expect(recordWatchError({ message: 'fresh', code: 'EACCES' }, log)).toBe('emit');
  });

  it('test_when_error_arrives_inside_the_rearmed_window_then_it_still_emits', () => {
    const log = makeLog();
    recordWatchError({ message: 'x', code: 'EACCES' }, log);
    recordWatchError({ message: 'y', code: 'EACCES' }, log);
    vi.advanceTimersByTime(WATCH_ERROR_WINDOW_MS); // re-armed, count 0
    // The re-armed window has seen nothing yet, so its first error is the
    // first-of-window and must NOT be silently swallowed.
    expect(recordWatchError({ message: 'z', code: 'EACCES' }, log)).toBe('emit');
    expect(recordWatchError({ message: 'z2', code: 'EACCES' }, log)).toBe('suppressed');
  });
});

describe('resetWatchErrorAggregator — AC-12', () => {
  it('test_when_reset_then_timer_count_is_zero_and_buffers_dropped', () => {
    const log = makeLog();
    for (let i = 0; i < 50; i++) recordWatchError({ message: `e${i}`, code: 'EACCES' }, log);
    expect(vi.getTimerCount()).toBe(1);

    resetWatchErrorAggregator();
    expect(vi.getTimerCount()).toBe(0);
    expect(__forTests_getWatchErrorAggregatorState()).toEqual({
      windowOpen: false,
      count: 0,
      currentWindowMs: WATCH_ERROR_WINDOW_MS,
    });

    // No summary can fire for the dead window.
    vi.advanceTimersByTime(WATCH_ERROR_WINDOW_MS * 20);
    expect(summaries(log)).toHaveLength(0);
  });

  it('test_when_reset_after_escalation_then_next_window_is_the_base_again', () => {
    const log = makeLog();
    for (let round = 0; round < 4; round++) {
      recordWatchError({ message: 'x', code: 'EACCES' }, log);
      recordWatchError({ message: 'y', code: 'EACCES' }, log);
      vi.advanceTimersByTime(__forTests_getWatchErrorAggregatorState().currentWindowMs);
    }
    expect(__forTests_getWatchErrorAggregatorState().currentWindowMs).toBeGreaterThan(
      WATCH_ERROR_WINDOW_MS,
    );

    resetWatchErrorAggregator();
    expect(recordWatchError({ message: 'fresh', code: 'EACCES' }, log)).toBe('emit');
    expect(__forTests_getWatchErrorAggregatorState().currentWindowMs).toBe(WATCH_ERROR_WINDOW_MS);
  });

  it('test_when_window_open_then_timer_is_unrefd', () => {
    const log = makeLog();
    const spy = vi.spyOn(global, 'setTimeout');
    recordWatchError({ message: 'x', code: 'EACCES' }, log);
    const handle = spy.mock.results[0].value as NodeJS.Timeout & { hasRef?: () => boolean };
    // A diagnostics window must never keep the Node process alive.
    expect(handle.hasRef?.()).toBe(false);
    spy.mockRestore();
  });
});
