// Phase 38 Plan 38-01 — unit coverage for the encode-niceness resolver + the
// soft-degrading reniceChild helper. Pure units: os.setPriority + the logger are
// mocked, no real ffmpeg is spawned.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import type { ChildProcess } from 'node:child_process';
import {
  resolveEncodeNice,
  reniceChild,
  isEncodeNiceDegraded,
  __forTests_resetEncodeNice,
} from '@/src/lib/encode/child-priority';

const fakeLogger = { info: vi.fn(), warn: vi.fn() };

function fakeChild(pid: number | undefined): ChildProcess {
  return { pid } as ChildProcess;
}

beforeEach(() => {
  __forTests_resetEncodeNice();
  fakeLogger.info.mockReset();
  fakeLogger.warn.mockReset();
  delete process.env.ENCODE_NICE;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ENCODE_NICE;
});

describe('resolveEncodeNice', () => {
  it('unset → default 19, NO warn', () => {
    expect(resolveEncodeNice(fakeLogger)).toBe(19);
    expect(fakeLogger.warn).not.toHaveBeenCalled();
  });

  it('empty string → default 19, NO warn', () => {
    process.env.ENCODE_NICE = '';
    expect(resolveEncodeNice(fakeLogger)).toBe(19);
    expect(fakeLogger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['0', 0],
    ['-20', -20],
    ['19', 19],
    ['10', 10],
  ])('valid integer %s → %d verbatim', (raw, expected) => {
    process.env.ENCODE_NICE = raw;
    expect(resolveEncodeNice(fakeLogger)).toBe(expected);
    expect(fakeLogger.warn).not.toHaveBeenCalled();
  });

  it.each(['20', '-21', '7.5', 'abc'])(
    'invalid / out-of-range / float / junk %s → 19 + one warn',
    (raw) => {
      process.env.ENCODE_NICE = raw;
      expect(resolveEncodeNice(fakeLogger)).toBe(19);
      expect(fakeLogger.warn).toHaveBeenCalledTimes(1);
      expect(fakeLogger.warn.mock.calls[0][0]).toMatchObject({
        action: 'encode_nice_invalid',
        raw,
        resolvedNice: 19,
      });
    },
  );

  it('AC-1: emits a single machine-greppable encode_nice_resolved audit line (default source)', () => {
    resolveEncodeNice(fakeLogger);
    const resolved = fakeLogger.info.mock.calls.filter(
      (c) => c[0]?.action === 'encode_nice_resolved',
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0][0]).toMatchObject({ resolvedNice: 19, source: 'default' });
  });

  it('valid env value logs source: env', () => {
    process.env.ENCODE_NICE = '5';
    resolveEncodeNice(fakeLogger);
    const resolved = fakeLogger.info.mock.calls.filter(
      (c) => c[0]?.action === 'encode_nice_resolved',
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0][0]).toMatchObject({ resolvedNice: 5, source: 'env' });
  });

  it('memoizes: a second call after a different env value still returns the first resolved value', () => {
    process.env.ENCODE_NICE = '10';
    expect(resolveEncodeNice(fakeLogger)).toBe(10);
    process.env.ENCODE_NICE = '3';
    expect(resolveEncodeNice(fakeLogger)).toBe(10); // memoized, env re-read ignored
  });
});

describe('reniceChild', () => {
  it('happy path: setPriority called with (pid, resolvedNice)', () => {
    const spy = vi.spyOn(os, 'setPriority').mockImplementation(() => {});
    reniceChild(fakeChild(1234), fakeLogger);
    expect(spy).toHaveBeenCalledWith(1234, 19);
    expect(isEncodeNiceDegraded()).toBe(false);
  });

  it('honours the ENCODE_NICE override', () => {
    process.env.ENCODE_NICE = '12';
    const spy = vi.spyOn(os, 'setPriority').mockImplementation(() => {});
    reniceChild(fakeChild(99), fakeLogger);
    expect(spy).toHaveBeenCalledWith(99, 12);
  });

  it('AC-3: pid null/undefined → setPriority NOT called, no throw', () => {
    const spy = vi.spyOn(os, 'setPriority').mockImplementation(() => {});
    expect(() => reniceChild(fakeChild(undefined), fakeLogger)).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('AC-3/AC-6: setPriority throws (EPERM) → returns normally, warn ONCE across 2 calls, degraded flips true', () => {
    vi.spyOn(os, 'setPriority').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    expect(isEncodeNiceDegraded()).toBe(false);
    expect(() => reniceChild(fakeChild(1), fakeLogger)).not.toThrow();
    expect(() => reniceChild(fakeChild(2), fakeLogger)).not.toThrow();
    expect(fakeLogger.warn).toHaveBeenCalledTimes(1);
    // reconstruction-sufficient payload (AC-6)
    expect(fakeLogger.warn.mock.calls[0][0]).toMatchObject({
      action: 'encode_nice_setpriority_failed',
      err: 'EPERM: operation not permitted',
      resolvedNice: 19,
    });
    expect(isEncodeNiceDegraded()).toBe(true);
  });

  it('AC-6: __forTests_resetEncodeNice clears the degraded flag back to false', () => {
    vi.spyOn(os, 'setPriority').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    reniceChild(fakeChild(1), fakeLogger);
    expect(isEncodeNiceDegraded()).toBe(true);
    __forTests_resetEncodeNice();
    expect(isEncodeNiceDegraded()).toBe(false);
  });
});
