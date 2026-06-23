// 22-02 T1.4b (audit-added M1): probeCachePoolWritable — PUT /api/settings-side
// helper unit tests. Validates the NO-SIDE-EFFECT invariant (never mkdirs)
// and the existsSync=false ENOENT-rejection branch.

import { describe, it, expect } from 'vitest';
import {
  probeCachePoolWritable,
  CachePoolUnavailableError,
  type CachePoolWritableDeps,
} from '@/src/lib/encode/staging';

type ErrnoLike = Error & { code: string; syscall?: string };
function makeErrnoError(code: string, syscall = 'open'): ErrnoLike {
  const err = new Error(`${syscall} ${code}`) as ErrnoLike;
  err.code = code;
  err.syscall = syscall;
  return err;
}

function makeDeps(over: Partial<CachePoolWritableDeps> = {}): CachePoolWritableDeps {
  return {
    mkdirSync: () => undefined,
    writeFileSync: () => undefined,
    unlinkSync: () => undefined,
    existsSync: () => true,
    ...over,
  };
}

describe('22-02 T1.4b: probeCachePoolWritable (audit M1 — probe-only, NO mkdir)', () => {
  it('happy: existing-writable-dir → returns undefined; mkdirSync NEVER invoked (NO side-effect invariant)', () => {
    let mkdirCalls = 0;
    const deps = makeDeps({
      mkdirSync: () => {
        mkdirCalls++;
        return undefined;
      },
    });
    expect(() => probeCachePoolWritable('/tmp/x265-probe-happy', deps)).not.toThrow();
    expect(mkdirCalls).toBe(0); // CRITICAL: validation must not create directories
  });

  it('rejects on missing-dir: existsSync=false → CachePoolUnavailableError code=ENOENT; mkdir NEVER called', () => {
    let mkdirCalls = 0;
    const deps = makeDeps({
      existsSync: () => false,
      mkdirSync: () => {
        mkdirCalls++;
        return undefined;
      },
    });
    let caught: unknown = null;
    try {
      probeCachePoolWritable('/nonexistent-probe', deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CachePoolUnavailableError);
    expect((caught as CachePoolUnavailableError).code).toBe('ENOENT');
    expect(mkdirCalls).toBe(0); // NO side-effect mkdir per audit M1
  });

  it('rejects on read-only-mount: writeFileSync throws EROFS → CachePoolUnavailableError code=EROFS', () => {
    const deps = makeDeps({
      writeFileSync: () => {
        throw makeErrnoError('EROFS', 'open');
      },
    });
    let caught: CachePoolUnavailableError | null = null;
    try {
      probeCachePoolWritable('/tmp/x265-probe-erofs', deps);
    } catch (e) {
      caught = e as CachePoolUnavailableError;
    }
    expect(caught).toBeInstanceOf(CachePoolUnavailableError);
    expect(caught!.code).toBe('EROFS');
  });

  it('rejects on EACCES: writeFileSync throws EACCES → CachePoolUnavailableError code=EACCES', () => {
    const deps = makeDeps({
      writeFileSync: () => {
        throw makeErrnoError('EACCES', 'open');
      },
    });
    let caught: CachePoolUnavailableError | null = null;
    try {
      probeCachePoolWritable('/tmp/x265-probe-eacces', deps);
    } catch (e) {
      caught = e as CachePoolUnavailableError;
    }
    expect(caught).toBeInstanceOf(CachePoolUnavailableError);
    expect(caught!.code).toBe('EACCES');
  });

  it('shape-error preserved: empty string → string-typed Error (NOT CachePoolUnavailableError)', () => {
    let caught: unknown = null;
    try {
      probeCachePoolWritable('');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(CachePoolUnavailableError);
    expect((caught as Error).message).toBe('invalid_cache_pool_path:empty');
  });
});
