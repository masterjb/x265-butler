import { describe, expect, it } from 'vitest';
import { selectActivePass2 } from '@/app/[locale]/bench/bench-client';
import type { Pass2ComboState, Pass2ComboStatus } from '@/src/lib/api/engine-events-client';

// 31-03: pure-unit coverage of the Pass-2 status-bar selector. Mirrors the
// extract-pure-logic pattern documented in
// tests/components/bench-client-apply-defaults.test.tsx — mounting BenchClient
// needs the SSE store + fixture-heavy run details that jsdom can't supply, so
// the running-preference selection is tested at the function boundary instead.

function makePass2(comboId: number, status: Pass2ComboStatus, runId = 1): Pass2ComboState {
  return {
    runId,
    comboId,
    status,
    overallPct: status === 'complete' ? 100 : 0,
    currentPhase: status === 'running' ? 'encode' : null,
    errorReason: null,
    vmaf: null,
    sizeBytes: null,
    encodeSec: null,
    completedAt: status === 'complete' ? 1 : null,
  };
}

function asMap(...entries: Pass2ComboState[]): Record<number, Pass2ComboState> {
  return Object.fromEntries(entries.map((e) => [e.comboId, e]));
}

describe('selectActivePass2', () => {
  // RED-anchor (AC-1): a running LOWER-id combo must win over a completed
  // higher-id combo. The pre-refactor max-comboId reducer returned 9 here —
  // this case fails against it, proving the test is not tautological.
  it('AC-1: prefers the running entry over a higher completed comboId', () => {
    const map = asMap(makePass2(9, 'complete'), makePass2(4, 'running'));
    expect(selectActivePass2(map)?.comboId).toBe(4);
  });

  // AC-2: with nothing running, fall back to the historical max-comboId.
  it('AC-2: falls back to max comboId when nothing is running', () => {
    const map = asMap(makePass2(9, 'complete'), makePass2(4, 'complete'));
    expect(selectActivePass2(map)?.comboId).toBe(9);
  });

  it('AC-2: empty map returns null', () => {
    expect(selectActivePass2({})).toBeNull();
  });

  it('single running entry is returned', () => {
    const map = asMap(makePass2(4, 'running'));
    expect(selectActivePass2(map)?.comboId).toBe(4);
  });

  it('single completed entry is returned (1-element fallback)', () => {
    const map = asMap(makePass2(7, 'complete'));
    expect(selectActivePass2(map)?.comboId).toBe(7);
  });

  // AC-5 (audit SR-1): running-preference scoped to the active run — a verify
  // on a foreign run must not hijack the viewed run's status bar.
  describe('AC-5: cross-run scope', () => {
    const map = asMap(makePass2(4, 'running', 100), makePass2(7, 'complete', 200));

    it('viewing run 200 returns the 200/complete entry, NOT the foreign 100/running', () => {
      const sel = selectActivePass2(map, 200);
      expect(sel?.runId).toBe(200);
      expect(sel?.comboId).toBe(7);
    });

    it('viewing run 100 returns the 100/running entry', () => {
      const sel = selectActivePass2(map, 100);
      expect(sel?.runId).toBe(100);
      expect(sel?.comboId).toBe(4);
    });

    it('no run context keeps un-scoped running-preference (back-compat)', () => {
      const sel = selectActivePass2(map);
      expect(sel?.runId).toBe(100);
      expect(sel?.comboId).toBe(4);
    });
  });

  // AC-6 (audit SR-2): pass2_busy should make >1 running impossible, but if the
  // invariant breaks, selection stays deterministic = max-comboId among running.
  it('AC-6: two running entries return the max comboId deterministically', () => {
    const map = asMap(makePass2(4, 'running'), makePass2(7, 'running'));
    expect(selectActivePass2(map)?.comboId).toBe(7);
  });
});
