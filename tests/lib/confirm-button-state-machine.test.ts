// 13-01a T1 tests: 12 cases covering AC-1 — 6 happy-path transitions + 3 no-op guards
// + 2 timing-payload-shapes + 1 constants-export. Reducer is pure; no fake-timers needed.

import { describe, it, expect } from 'vitest';
import {
  AUTO_DISARM_MS,
  COOLDOWN_MS,
  initialState,
  reducer,
  type State,
} from '@/src/lib/ui/confirm-button-state-machine';

const NOW = 1_000_000;

describe('confirm-button-state-machine', () => {
  describe('happy-path transitions (AC-1)', () => {
    it('idle + ARM → cooldown', () => {
      const next = reducer({ kind: 'idle' }, { type: 'ARM' }, NOW);
      expect(next.kind).toBe('cooldown');
    });

    it('cooldown + ELAPSE_COOLDOWN → armed', () => {
      const next = reducer({ kind: 'cooldown' }, { type: 'ELAPSE_COOLDOWN' }, NOW);
      expect(next.kind).toBe('armed');
    });

    it('cooldown + ABORT → aborted', () => {
      const next = reducer({ kind: 'cooldown' }, { type: 'ABORT' }, NOW);
      expect(next.kind).toBe('aborted');
    });

    it('armed + CONFIRM → fired', () => {
      const next = reducer({ kind: 'armed' }, { type: 'CONFIRM' }, NOW);
      expect(next.kind).toBe('fired');
    });

    it('armed + ABORT → aborted', () => {
      const next = reducer({ kind: 'armed' }, { type: 'ABORT' }, NOW);
      expect(next.kind).toBe('aborted');
    });

    it('armed + ELAPSE_AUTODISARM → autoDisarmed', () => {
      const next = reducer({ kind: 'armed' }, { type: 'ELAPSE_AUTODISARM' }, NOW);
      expect(next.kind).toBe('autoDisarmed');
    });
  });

  describe('no-op guards (AC-1 SR9 — UNCHANGED, not a transition)', () => {
    it('idle + RESET → idle (unchanged)', () => {
      const start: State = { kind: 'idle' };
      const next = reducer(start, { type: 'RESET' }, NOW);
      expect(next).toBe(start); // referential — no new object allocated
    });

    it('idle + CONFIRM → idle (unchanged)', () => {
      const start: State = { kind: 'idle' };
      const next = reducer(start, { type: 'CONFIRM' }, NOW);
      expect(next).toBe(start);
    });

    it('armed + ARM → armed (unchanged)', () => {
      const start: State = { kind: 'armed', abortAt: NOW + AUTO_DISARM_MS };
      const next = reducer(start, { type: 'ARM' }, NOW);
      expect(next).toBe(start);
    });
  });

  describe('timing-payload-shapes', () => {
    it('cooldown.armedAt === now + COOLDOWN_MS', () => {
      const next = reducer({ kind: 'idle' }, { type: 'ARM' }, NOW);
      expect(next.armedAt).toBe(NOW + COOLDOWN_MS);
    });

    it('armed.abortAt === now + AUTO_DISARM_MS', () => {
      const next = reducer({ kind: 'cooldown' }, { type: 'ELAPSE_COOLDOWN' }, NOW);
      expect(next.abortAt).toBe(NOW + AUTO_DISARM_MS);
    });
  });

  describe('constants', () => {
    it('exports COOLDOWN_MS=3000 + AUTO_DISARM_MS=8000', () => {
      expect(COOLDOWN_MS).toBe(3000);
      expect(AUTO_DISARM_MS).toBe(8000);
      expect(initialState).toEqual({ kind: 'idle' });
    });
  });
});
