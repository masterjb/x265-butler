// 11-02-FIX (UAT-001): bench.combo_progress event-bus shape + safeEmit isolation.

import { describe, it, expect, beforeEach } from 'vitest';
import { engineEvents } from '@/src/lib/encode/events';

type CapturedEvent = Parameters<Parameters<typeof engineEvents.subscribe>[0]>[0];

describe('engineEvents — bench.combo_progress (11-02-FIX)', () => {
  let received: CapturedEvent[];
  let unsubscribers: Array<() => void>;

  beforeEach(() => {
    received = [];
    unsubscribers = [];
  });

  function subscribe(fn: (ev: CapturedEvent) => void) {
    const off = engineEvents.subscribe(fn);
    unsubscribers.push(off);
  }

  function teardown() {
    for (const off of unsubscribers) off();
  }

  it('test_emit_subscribe_receives_full_payload', () => {
    subscribe((ev) => {
      received.push(ev);
    });
    engineEvents.emit({
      type: 'bench.combo_progress',
      runId: 1,
      comboId: 7,
      phase: 'encode',
      phasePct: 42,
      overallPct: 29,
    } as never);
    teardown();

    expect(received).toHaveLength(1);
    const ev = received[0];
    expect(ev.type).toBe('bench.combo_progress');
    if (ev.type === 'bench.combo_progress') {
      expect(ev.runId).toBe(1);
      expect(ev.comboId).toBe(7);
      expect(ev.phase).toBe('encode');
      expect(ev.phasePct).toBe(42);
      expect(ev.overallPct).toBe(29);
    }
  });

  it('test_emit_with_each_phase_value_emits_correctly', () => {
    subscribe((ev) => {
      received.push(ev);
    });
    const phases: Array<'sample-extraction' | 'encode' | 'vmaf' | 'pareto'> = [
      'sample-extraction',
      'encode',
      'vmaf',
      'pareto',
    ];
    for (const phase of phases) {
      engineEvents.emit({
        type: 'bench.combo_progress',
        runId: 2,
        comboId: 1,
        phase,
        phasePct: 50,
        overallPct: 50,
      } as never);
    }
    teardown();

    expect(received).toHaveLength(4);
    expect(received.map((e) => (e.type === 'bench.combo_progress' ? e.phase : ''))).toEqual(phases);
  });

  it('test_safeEmit_listener_throw_does_not_break_other_listeners', () => {
    // Audit-anchor: 02-03 M1 safeEmit isolation — extends to bench.combo_progress.
    let secondListenerCallCount = 0;
    subscribe(() => {
      throw new Error('listener boom');
    });
    subscribe(() => {
      secondListenerCallCount++;
    });
    engineEvents.emit({
      type: 'bench.combo_progress',
      runId: 3,
      comboId: 1,
      phase: 'encode',
      phasePct: 10,
      overallPct: 16,
    } as never);
    teardown();

    expect(secondListenerCallCount).toBe(1);
  });
});
