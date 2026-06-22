// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockTail } = vi.hoisted(() => ({
  mockTail: vi.fn<(n: number) => { lines: string[]; totalLines: number; totalBytes: number }>(),
}));

vi.mock('@/src/lib/log/ring-buffer', () => ({
  tail: mockTail,
  pushLine: vi.fn(),
  _resetForTesting: vi.fn(),
  RING_BUFFER_LIMITS: { MAX_LINES: 1000, MAX_BYTES: 5 * 1024 * 1024 },
}));

import { getRecentErrors } from '@/src/lib/diagnostics/recent-errors';

function bufferOf(lines: string[]): { lines: string[]; totalLines: number; totalBytes: number } {
  return { lines, totalLines: lines.length, totalBytes: lines.reduce((n, l) => n + l.length, 0) };
}

describe('getRecentErrors', () => {
  beforeEach(() => {
    mockTail.mockReset();
  });

  it('returns only level >= 50 entries, reversed most-recent-first', () => {
    mockTail.mockReturnValue(
      bufferOf([
        JSON.stringify({ level: 30, time: 100, msg: 'info' }),
        JSON.stringify({ level: 40, time: 200, msg: 'warn' }),
        JSON.stringify({ level: 50, time: 300, msg: 'first-error' }),
        JSON.stringify({ level: 60, time: 400, msg: 'fatal' }),
        JSON.stringify({ level: 50, time: 500, msg: 'last-error' }),
      ]),
    );
    const result = getRecentErrors(25);
    expect(result.map((e) => e.msg)).toEqual(['last-error', 'fatal', 'first-error']);
    expect(result.every((e) => e.level >= 50)).toBe(true);
  });

  it('silently drops malformed JSON lines', () => {
    mockTail.mockReturnValue(
      bufferOf([
        'not json',
        JSON.stringify({ level: 50, time: 1, msg: 'real-error' }),
        '{"broken json',
      ]),
    );
    const result = getRecentErrors(25);
    expect(result).toHaveLength(1);
    expect(result[0].msg).toBe('real-error');
  });

  it('returns [] for empty buffer', () => {
    mockTail.mockReturnValue(bufferOf([]));
    expect(getRecentErrors(25)).toEqual([]);
  });

  it('respects limit=3 with 10 errors', () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(JSON.stringify({ level: 50, time: i, msg: `err-${i}` }));
    }
    mockTail.mockReturnValue(bufferOf(lines));
    const result = getRecentErrors(3);
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.msg)).toEqual(['err-9', 'err-8', 'err-7']);
  });

  it('truncates msg to 500 chars', () => {
    const longMsg = 'a'.repeat(2000);
    mockTail.mockReturnValue(bufferOf([JSON.stringify({ level: 50, time: 1, msg: longMsg })]));
    const result = getRecentErrors(1);
    expect(result[0].msg).toHaveLength(500);
  });

  it('picks source fallback chain: source > module > event > action', () => {
    mockTail.mockReturnValue(
      bufferOf([
        JSON.stringify({ level: 50, time: 1, msg: 'a', action: 'fallback-action' }),
        JSON.stringify({ level: 50, time: 2, msg: 'b', event: 'evt', action: 'ignored' }),
        JSON.stringify({ level: 50, time: 3, msg: 'c', module: 'mod', event: 'ignored' }),
        JSON.stringify({ level: 50, time: 4, msg: 'd', source: 'src', module: 'ignored' }),
      ]),
    );
    const result = getRecentErrors(25);
    expect(result.find((e) => e.msg === 'a')?.source).toBe('fallback-action');
    expect(result.find((e) => e.msg === 'b')?.source).toBe('evt');
    expect(result.find((e) => e.msg === 'c')?.source).toBe('mod');
    expect(result.find((e) => e.msg === 'd')?.source).toBe('src');
  });

  it('does not throw on binary/whitespace garbage', () => {
    mockTail.mockReturnValue(bufferOf([' ', '\x00\x01', '']));
    expect(() => getRecentErrors(25)).not.toThrow();
    expect(getRecentErrors(25)).toEqual([]);
  });

  it('parses a full 1000-line buffer in <50ms', () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const level = i % 5 === 0 ? 50 : 30;
      lines.push(JSON.stringify({ level, time: i, msg: `m-${i}` }));
    }
    mockTail.mockReturnValue(bufferOf(lines));
    const start = performance.now();
    const result = getRecentErrors(25);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(result).toHaveLength(25);
  });

  it('tail() throws → returns []', () => {
    mockTail.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(getRecentErrors(25)).toEqual([]);
  });

  it('limit=0 returns []', () => {
    mockTail.mockReturnValue(bufferOf([JSON.stringify({ level: 50, time: 1, msg: 'err' })]));
    expect(getRecentErrors(0)).toEqual([]);
  });
});
