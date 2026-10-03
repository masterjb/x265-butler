// Plan 52-05 E6/E7 (audit MH-1/MH-2): ffmpeg failure summarising + run reason format.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  formatAllCombosFailedReason,
  parseRunFailureReason,
  pickFailureExcerpt,
  summarizeFfmpegFailure,
} from '@/src/lib/bench/failure-excerpt';

const befundStderr = readFileSync(
  path.join(process.cwd(), 'tests/fixtures/bench/nvenc-api-too-new.stderr.txt'),
  'utf8',
);

describe('summarizeFfmpegFailure', () => {
  it('test_summarize_when_befund_stderr_then_keeps_required_version_line', () => {
    expect(summarizeFfmpegFailure(befundStderr)).toContain('Required: 13.1 Found: 13.0');
  });

  it('test_summarize_when_befund_stderr_then_fits_into_max', () => {
    expect(summarizeFfmpegFailure(befundStderr).length).toBeLessThanOrEqual(500);
  });

  it('test_summarize_when_befund_stderr_then_cause_line_comes_first', () => {
    expect(summarizeFfmpegFailure(befundStderr).split('\n')[0]).toContain('Required: 13.1');
  });

  it('test_summarize_when_no_cause_line_then_falls_back_to_tail', () => {
    const stderr = 'a'.repeat(600) + '\nsomething odd happened';
    expect(summarizeFfmpegFailure(stderr)).toBe(stderr.slice(-500));
  });

  it('test_summarize_when_cause_lines_exceed_max_then_truncated_to_max', () => {
    const stderr = Array.from(
      { length: 20 },
      (_, i) => `Unable to parse option ${i} ${'x'.repeat(40)}`,
    ).join('\n');
    expect(summarizeFfmpegFailure(stderr, 100).length).toBe(100);
  });

  it('test_summarize_when_empty_then_empty', () => {
    expect(summarizeFfmpegFailure('')).toBe('');
  });
});

describe('pickFailureExcerpt', () => {
  it('test_excerpt_when_befund_reason_then_returns_driver_line_without_thread_prefix', () => {
    const reason = `ffmpeg bench-encode exited 218: ${summarizeFfmpegFailure(befundStderr)}`;
    expect(pickFailureExcerpt(reason)).toBe(
      'Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0',
    );
  });

  it('test_excerpt_when_only_generic_lines_then_returns_first_generic_line', () => {
    const reason = '[vost#0:0 @ 0x1] Task finished with error: Invalid argument\nframe=0';
    expect(pickFailureExcerpt(reason)).toBe('Task finished with error: Invalid argument');
  });

  it('test_excerpt_when_no_known_line_then_returns_last_non_empty_line', () => {
    expect(pickFailureExcerpt('first\nsecond\n\n')).toBe('second');
  });

  it('test_excerpt_when_long_line_then_capped', () => {
    expect(pickFailureExcerpt('x'.repeat(500), 200).length).toBe(200);
  });

  it('test_excerpt_when_empty_then_empty_string', () => {
    expect(pickFailureExcerpt('')).toBe('');
  });
});

describe('run failure reason format', () => {
  it('test_parse_when_formatted_reason_then_round_trips', () => {
    expect(parseRunFailureReason(formatAllCombosFailedReason(63, 'Required: 13.1'))).toEqual({
      kind: 'all_combos_failed',
      count: 63,
      excerpt: 'Required: 13.1',
    });
  });

  it('test_parse_when_excerpt_contains_pipe_then_splits_at_first_pipe_only', () => {
    expect(parseRunFailureReason('all_combos_failed:3|a | b | c')).toEqual({
      kind: 'all_combos_failed',
      count: 3,
      excerpt: 'a | b | c',
    });
  });

  it('test_parse_when_count_not_integer_then_raw', () => {
    expect(parseRunFailureReason('all_combos_failed:x|oops')).toEqual({
      kind: 'raw',
      text: 'all_combos_failed:x|oops',
    });
  });

  it('test_parse_when_legacy_reason_then_raw', () => {
    expect(parseRunFailureReason('boot_recovery_stale_running')).toEqual({
      kind: 'raw',
      text: 'boot_recovery_stale_running',
    });
  });

  it('test_parse_when_no_excerpt_then_empty_excerpt', () => {
    expect(parseRunFailureReason('all_combos_failed:5')).toEqual({
      kind: 'all_combos_failed',
      count: 5,
      excerpt: '',
    });
  });
});
