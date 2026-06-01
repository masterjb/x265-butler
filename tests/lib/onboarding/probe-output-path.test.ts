import { describe, it, expect, vi } from 'vitest';
import { constants } from 'node:fs/promises';
import { probeOutputPath } from '@/src/lib/onboarding/probe-output-path';

// 23-03 Task 1 — deps-injected, NO real filesystem. probeOutputPath mirrors
// mount-probe.ts's R_OK/W_OK + errCode shape and must never throw upward.

function errWithCode(code: string): NodeJS.ErrnoException {
  const e = new Error(code) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe('probeOutputPath', () => {
  it('test_when_R_OK_and_W_OK_both_resolve_then_readable_writable_true_exists_no_error', async () => {
    const access = vi.fn().mockResolvedValue(undefined);
    const out = await probeOutputPath('/media', { access });
    expect(out).toEqual({ path: '/media', exists: true, readable: true, writable: true });
    expect(out.error).toBeUndefined();
  });

  it('test_when_W_OK_rejects_EACCES_R_OK_resolves_then_writable_false_error_EACCES', async () => {
    const access = vi.fn(async (_p: import('node:fs').PathLike, mode?: number) => {
      if (mode === constants.W_OK) throw errWithCode('EACCES');
      return undefined;
    });
    const out = await probeOutputPath('/media', { access });
    expect(out).toEqual({
      path: '/media',
      exists: true,
      readable: true,
      writable: false,
      error: 'EACCES',
    });
  });

  it('test_when_R_OK_rejects_ENOENT_then_exists_false_readable_false_writable_false_error_ENOENT', async () => {
    const access = vi.fn(async (_p: import('node:fs').PathLike, mode?: number) => {
      if (mode === constants.R_OK) throw errWithCode('ENOENT');
      throw errWithCode('ENOENT');
    });
    const out = await probeOutputPath('/nope', { access });
    expect(out).toEqual({
      path: '/nope',
      exists: false,
      readable: false,
      writable: false,
      error: 'ENOENT',
    });
  });

  it('test_when_both_R_OK_and_W_OK_reject_EACCES_then_exists_true_all_access_false', async () => {
    // audit-fix M1: node exists but denies both — exists keyed off ENOENT-on-read
    // only, so EACCES ⇒ exists:true.
    const access = vi.fn().mockRejectedValue(errWithCode('EACCES'));
    const out = await probeOutputPath('/locked', { access });
    expect(out).toEqual({
      path: '/locked',
      exists: true,
      readable: false,
      writable: false,
      error: 'EACCES',
    });
  });

  it('test_when_access_rejects_codeless_value_then_error_UNKNOWN_no_throw', async () => {
    const access = vi.fn().mockRejectedValue('boom-no-code');
    const out = await probeOutputPath('/weird', { access });
    expect(out.error).toBe('UNKNOWN');
    expect(out.readable).toBe(false);
    expect(out.writable).toBe(false);
  });

  it('test_never_throws_even_when_access_throws_synchronously', async () => {
    const access = vi.fn(() => {
      throw errWithCode('EIO');
    }) as unknown as typeof import('node:fs/promises').access;
    await expect(probeOutputPath('/io', { access })).resolves.toBeDefined();
  });
});
