// @vitest-environment node
// Pure decision rules for putting jobs back in the queue after a container
// restart: how interruptions are counted, when the job gives up, how the
// setting is read and which job gets the "resumed" line in its job log.

import { describe, it, expect } from 'vitest';
import {
  MAX_RESTART_INTERRUPTIONS,
  RESUMED_AFTER_RESTART_NOTE,
  countConsecutiveInterruptions,
  decideResume,
  resolveResumeAfterRestart,
  resumeLogLine,
} from '@/src/lib/encode/restart-resume';

type Row = { status: string; error_msg: string | null };

const current: Row = { status: 'interrupted', error_msg: null };
const resumed: Row = { status: 'interrupted', error_msg: RESUMED_AFTER_RESTART_NOTE };
const stalled: Row = { status: 'failed', error_msg: 'encode_stalled' };

describe('countConsecutiveInterruptions', () => {
  it('returns 0 for an empty history', () => {
    expect(countConsecutiveInterruptions([])).toBe(0);
  });

  it('counts the current row alone when nothing came before', () => {
    expect(countConsecutiveInterruptions([current])).toBe(1);
  });

  it('adds marked interrupted predecessors', () => {
    expect(countConsecutiveInterruptions([current, resumed])).toBe(2);
    expect(countConsecutiveInterruptions([current, resumed, resumed])).toBe(3);
  });

  it('skips stalled jobs without breaking the chain', () => {
    expect(countConsecutiveInterruptions([current, stalled, resumed, stalled, resumed])).toBe(3);
  });

  it.each<[string, Row]>([
    ['done', { status: 'done', error_msg: null }],
    ['cancelled', { status: 'cancelled', error_msg: null }],
    ['another failure', { status: 'failed', error_msg: 'encode:boom' }],
    ['an interruption without the mark', { status: 'interrupted', error_msg: null }],
    ['a skipped resume', { status: 'interrupted', error_msg: 'resume_skipped:source_changed' }],
  ])('stops at %s', (_label, breaker) => {
    expect(countConsecutiveInterruptions([current, resumed, breaker, resumed, resumed])).toBe(2);
  });
});

describe('decideResume', () => {
  it('requeues below the limit', () => {
    for (let n = 1; n < MAX_RESTART_INTERRUPTIONS; n++) {
      expect(decideResume({ enabled: true, interruptions: n })).toBe('requeue');
    }
  });

  it('gives up at the limit', () => {
    expect(MAX_RESTART_INTERRUPTIONS).toBe(3);
    expect(decideResume({ enabled: true, interruptions: 3 })).toBe('fail_repeated');
    expect(decideResume({ enabled: true, interruptions: 4 })).toBe('fail_repeated');
  });

  it('does nothing when the setting is off, whatever the history', () => {
    for (const n of [0, 1, 2, 3, 10]) {
      expect(decideResume({ enabled: false, interruptions: n })).toBe('none');
    }
  });
});

describe('resolveResumeAfterRestart', () => {
  it('is off only for 0', () => {
    expect(resolveResumeAfterRestart('0')).toBe(false);
    expect(resolveResumeAfterRestart(' 0 ')).toBe(false);
  });

  it.each([undefined, null, '', '1', 'true', 'false', 'off', '2'])(
    'falls back to on for %s',
    (raw) => {
      expect(resolveResumeAfterRestart(raw)).toBe(true);
    },
  );
});

describe('resumeLogLine', () => {
  it('describes a resumed job with its interruption count', () => {
    expect(resumeLogLine([resumed])).toBe(
      'Resumed after a container restart, interruption 1 of 3, starting from the beginning',
    );
    expect(resumeLogLine([resumed, stalled, resumed])).toBe(
      'Resumed after a container restart, interruption 2 of 3, starting from the beginning',
    );
  });

  it('is null when the direct predecessor was not resumed', () => {
    expect(resumeLogLine([])).toBeNull();
    expect(resumeLogLine([{ status: 'interrupted', error_msg: null }])).toBeNull();
    expect(resumeLogLine([stalled, resumed])).toBeNull();
    expect(resumeLogLine([{ status: 'done', error_msg: null }])).toBeNull();
  });
});
