// 13-01a T1: pure state-machine for ConfirmButton P3 (inverted-cooldown one-way-doors).
// Invariants: pure + deterministic; `now` is positional (audit M4).
// Timing uniform per phase-decision Q1: no per-callsite overrides.

export const COOLDOWN_MS = 3000;
export const AUTO_DISARM_MS = 8000;

export type StateKind = 'idle' | 'cooldown' | 'armed' | 'fired' | 'aborted' | 'autoDisarmed';

export type State = {
  kind: StateKind;
  armedAt?: number;
  abortAt?: number;
};

export type Event =
  | { type: 'ARM' }
  | { type: 'ELAPSE_COOLDOWN' }
  | { type: 'CONFIRM' }
  | { type: 'ABORT' }
  | { type: 'ELAPSE_AUTODISARM' }
  | { type: 'RESET' };

export function reducer(state: State, event: Event, now: number): State {
  switch (state.kind) {
    case 'idle':
      if (event.type === 'ARM') {
        return { kind: 'cooldown', armedAt: now + COOLDOWN_MS };
      }
      return state;

    case 'cooldown':
      if (event.type === 'ELAPSE_COOLDOWN') {
        return { kind: 'armed', abortAt: now + AUTO_DISARM_MS };
      }
      if (event.type === 'ABORT') {
        return { kind: 'aborted' };
      }
      return state;

    case 'armed':
      if (event.type === 'CONFIRM') {
        return { kind: 'fired' };
      }
      if (event.type === 'ABORT') {
        return { kind: 'aborted' };
      }
      if (event.type === 'ELAPSE_AUTODISARM') {
        return { kind: 'autoDisarmed' };
      }
      return state;

    case 'fired':
    case 'aborted':
    case 'autoDisarmed':
      if (event.type === 'RESET') {
        return { kind: 'idle' };
      }
      return state;

    default:
      return state;
  }
}

export const initialState: State = { kind: 'idle' };
