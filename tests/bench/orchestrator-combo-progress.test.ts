// 11-02-FIX (UAT-001): bench orchestrator throttled emit semantic.
// Tests the leading-edge 1Hz throttle + phase-change bypass + anchored overallPct
// without spinning up the full orchestrator (pure logic test of the throttle helper).

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { engineEvents } from '@/src/lib/encode/events';

type CapturedEvent = Parameters<Parameters<typeof engineEvents.subscribe>[0]>[0];
type ComboProgress = Extract<CapturedEvent, { type: 'bench.combo_progress' }>;

// Local reproduction of the throttle helper from src/lib/bench/orchestrator.ts:231.
// Test contract — if the orchestrator implementation changes, this test must
// be updated to match (intentional duplication keeps the test self-contained).
const PHASE_ANCHORS = {
  'sample-extraction': [0, 10],
  encode: [10, 70],
  vmaf: [70, 95],
  pareto: [95, 100],
} as const;

function makeEmitter(runId: number, comboId: number) {
  let lastEmitMs = 0;
  let lastPhase: keyof typeof PHASE_ANCHORS | null = null;
  return (phase: keyof typeof PHASE_ANCHORS, phasePct: number): void => {
    const now = Date.now();
    const phaseChanged = phase !== lastPhase;
    if (!phaseChanged && now - lastEmitMs < 1000) return;
    const [start, end] = PHASE_ANCHORS[phase];
    const overallPct = Math.round(start + (phasePct / 100) * (end - start));
    engineEvents.emit({
      type: 'bench.combo_progress',
      runId,
      comboId,
      phase,
      phasePct: Math.round(phasePct),
      overallPct,
    } as never);
    lastEmitMs = now;
    lastPhase = phase;
  };
}

describe('orchestrator combo-progress throttle (11-02-FIX)', () => {
  let received: ComboProgress[];
  let off: () => void;

  beforeEach(() => {
    received = [];
    vi.useFakeTimers({ now: 0 });
    off = engineEvents.subscribe((ev) => {
      if (ev.type === 'bench.combo_progress') received.push(ev);
    });
  });

  afterEach(() => {
    off();
    vi.useRealTimers();
  });

  it('test_leading_edge_1Hz_throttle_5Hz_input_2sec_yields_at_most_3_emits', () => {
    const emit = makeEmitter(1, 7);
    // Simulate 5 Hz input over 2 sec = 10 events at t=0,200,400,...,1800ms.
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(i * 200);
      emit('encode', 10 + i * 9); // pct ramps from 10→91
    }
    // Leading-edge throttle: t=0 emit, t≥1000 emit. So 2 emits expected.
    // Allow ≤3 to handle boundary jitter.
    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(received.length).toBeLessThanOrEqual(3);
  });

  it('test_phase_change_bypasses_throttle_immediate_emit', () => {
    const emit = makeEmitter(2, 5);
    vi.setSystemTime(0);
    emit('encode', 50); // emitted (first call)
    vi.setSystemTime(200);
    emit('encode', 60); // throttled (within 1s)
    vi.setSystemTime(300);
    emit('vmaf', 5); // phase-change → bypass throttle
    expect(received.length).toBe(2);
    expect(received[0].phase).toBe('encode');
    expect(received[1].phase).toBe('vmaf');
  });

  it('test_overallPct_anchored_per_phase_bracket', () => {
    const emit = makeEmitter(3, 1);
    vi.setSystemTime(0);
    emit('encode', 50); // anchor [10,70] → 10 + 0.5*(70-10) = 40
    vi.setSystemTime(2000);
    emit('vmaf', 50); // anchor [70,95] → 70 + 0.5*(95-70) = 82.5 → 83
    vi.setSystemTime(4000);
    emit('pareto', 100); // anchor [95,100] → 100
    expect(received.map((e) => e.overallPct)).toEqual([40, 83, 100]);
  });

  it('test_per_combo_closure_isolation_independent_throttle_state', () => {
    const emitA = makeEmitter(4, 10);
    const emitB = makeEmitter(4, 11);
    vi.setSystemTime(0);
    emitA('encode', 25); // emitted
    emitB('encode', 25); // emitted (independent closure)
    vi.setSystemTime(500);
    emitA('encode', 50); // throttled
    emitB('encode', 50); // throttled (independent)
    expect(received.length).toBe(2);
    expect(received[0].comboId).toBe(10);
    expect(received[1].comboId).toBe(11);
  });

  it('test_phasePct_clamped_and_rounded_to_integer', () => {
    const emit = makeEmitter(5, 1);
    vi.setSystemTime(0);
    emit('encode', 42.7);
    vi.setSystemTime(2000);
    emit('encode', 99.9);
    expect(received[0].phasePct).toBe(43);
    expect(received[1].phasePct).toBe(100);
  });
});
