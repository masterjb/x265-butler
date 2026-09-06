// 24-05 F7 T1: ring-buffer clear() unit tests — AC-1.
// clear() is the prod-callable operator wipe backing DELETE /api/logs.

import { describe, it, expect, beforeEach } from 'vitest';
import { _resetForTesting, clear, pushLine, tail } from '@/src/lib/log/ring-buffer';

beforeEach(() => {
  _resetForTesting();
});

describe('ring-buffer clear() (AC-1)', () => {
  it('empties lines + totalBytes; tail reflects empty', () => {
    pushLine('alpha');
    pushLine('beta');
    pushLine('gamma');
    const before = tail(10);
    expect(before.totalLines).toBe(3);
    expect(before.totalBytes).toBeGreaterThan(0);

    clear();

    const after = tail(10);
    expect(after.lines).toEqual([]);
    expect(after.totalLines).toBe(0);
    expect(after.totalBytes).toBe(0);
  });

  it('pushLine works again after clear()', () => {
    pushLine('one');
    clear();
    pushLine('two');
    const after = tail(10);
    expect(after.lines).toEqual(['two']);
    expect(after.totalLines).toBe(1);
    expect(after.totalBytes).toBe(Buffer.byteLength('two', 'utf8'));
  });

  it('clear() on an already-empty ring is a no-op (idempotent)', () => {
    clear();
    const after = tail(10);
    expect(after.totalLines).toBe(0);
    expect(after.totalBytes).toBe(0);
  });
});
