// @vitest-environment node
// Limits and parsing of the trash retention setting. A stored value that is
// not a whole number of days inside the range falls back to the default
// instead of being clamped.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TRASH_RETENTION_DAYS,
  MAX_TRASH_RETENTION_DAYS,
  MIN_TRASH_RETENTION_DAYS,
  isValidTrashRetentionDays,
  parseTrashRetentionDays,
  parseTrashEnabled,
  parseTrashLocation,
} from '@/src/lib/encode/trash-defaults';

describe('trash retention limits', () => {
  it('default is 30 days, range 1 to 3650', () => {
    expect(DEFAULT_TRASH_RETENTION_DAYS).toBe(30);
    expect(MIN_TRASH_RETENTION_DAYS).toBe(1);
    expect(MAX_TRASH_RETENTION_DAYS).toBe(3650);
  });

  it.each([1, 30, 365, 3650])('accepts %d', (n) => {
    expect(isValidTrashRetentionDays(n)).toBe(true);
  });

  it.each([0, -1, 3651, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %d', (n) => {
    expect(isValidTrashRetentionDays(n)).toBe(false);
  });
});

describe('parseTrashRetentionDays', () => {
  it.each([
    ['1', 1],
    ['30', 30],
    ['365', 365],
    ['3650', 3650],
    [' 90 ', 90],
  ])('keeps valid stored value %j', (raw, expected) => {
    expect(parseTrashRetentionDays(raw)).toBe(expected);
  });

  it.each([['0'], ['abc'], ['4000'], ['-5'], ['1.5'], ['30abc'], [''], [null], [undefined]])(
    'falls back to 30 for %j',
    (raw) => {
      expect(parseTrashRetentionDays(raw)).toBe(30);
    },
  );
});

describe('parseTrashEnabled', () => {
  it('only an explicit false turns the trash off', () => {
    expect(parseTrashEnabled('false')).toBe(false);
  });

  it.each([undefined, null, '', 'true', 'FALSE', ' false', '0', 'off', 'no'])(
    '%o keeps the trash on',
    (raw) => {
      expect(parseTrashEnabled(raw)).toBe(true);
    },
  );
});

describe('parseTrashLocation', () => {
  it.each(['share', 'cache'] as const)('%s is kept', (v) => {
    expect(parseTrashLocation(v)).toBe(v);
  });

  it.each([undefined, null, '', 'Share', 'array', ' share'])('%o falls back to cache', (raw) => {
    expect(parseTrashLocation(raw)).toBe('cache');
  });
});
