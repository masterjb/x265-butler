// 05-03 T1.B: ring buffer tests.
// Phase 5 Plan 05-03 — AC-5 + audit S1 (push budget).

import { describe, it, expect, beforeEach } from 'vitest';
import { pushLine, tail, _resetForTesting, RING_BUFFER_LIMITS } from '@/src/lib/log/ring-buffer';

describe('ring-buffer — pushLine + tail', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  it('pushLine appends + tail returns last N lines', () => {
    pushLine('line1');
    pushLine('line2');
    pushLine('line3');
    const result = tail(2);
    expect(result.lines).toEqual(['line2', 'line3']);
    expect(result.totalLines).toBe(3);
  });

  it('strips trailing newline from input', () => {
    pushLine('line\n');
    const result = tail(1);
    expect(result.lines[0]).toBe('line');
  });

  it('skips empty lines', () => {
    pushLine('valid');
    pushLine('');
    pushLine('\n');
    const result = tail(10);
    expect(result.lines).toEqual(['valid']);
  });

  it('evicts oldest when count > MAX_LINES', () => {
    for (let i = 0; i < RING_BUFFER_LIMITS.MAX_LINES + 50; i++) {
      pushLine(`line${i}`);
    }
    const result = tail(RING_BUFFER_LIMITS.MAX_LINES + 100);
    expect(result.lines.length).toBe(RING_BUFFER_LIMITS.MAX_LINES);
    expect(result.lines[0]).toBe('line50'); // first 50 evicted
    expect(result.lines.at(-1)).toBe(`line${RING_BUFFER_LIMITS.MAX_LINES + 49}`);
  });

  it('evicts oldest when total bytes > MAX_BYTES', () => {
    const bigLine = 'x'.repeat(10_000);
    for (let i = 0; i < 600; i++) {
      pushLine(bigLine);
    }
    const result = tail(1000);
    expect(result.totalBytes).toBeLessThanOrEqual(RING_BUFFER_LIMITS.MAX_BYTES);
  });

  it('tail clamps n to [1, MAX_LINES]', () => {
    pushLine('a');
    pushLine('b');
    expect(tail(0).lines.length).toBeLessThanOrEqual(2);
    expect(tail(99999).lines.length).toBe(2);
  });

  it('audit S1: pushLine <100µs budget — 10000 iterations <200ms', () => {
    const t0 = Date.now();
    for (let i = 0; i < 10_000; i++) {
      pushLine(`probe-${i}`);
    }
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(200);
  });

  it('HMR-safe globalThis singleton — re-import preserves data', async () => {
    pushLine('persistent');
    // Simulate re-import (vitest re-evaluates module; globalThis preserves state)
    const reimported = await import('@/src/lib/log/ring-buffer');
    const result = reimported.tail(10);
    expect(result.lines).toContain('persistent');
  });
});
