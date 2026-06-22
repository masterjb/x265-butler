// 22-02 T1.4: assertCachePoolWritable — orchestrator-side helper unit tests.
// Covers mkdir + writefile-probe success/failure, shape-error path, open-set
// errno surface (audit SR10), and Error.cause forensic chain (audit SR7).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertCachePoolWritable,
  CachePoolUnavailableError,
  type CachePoolWritableDeps,
} from '@/src/lib/encode/staging';

type ErrnoLike = Error & { code: string; syscall?: string };
function makeErrnoError(code: string, syscall = 'mkdir'): ErrnoLike {
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

describe('22-02 T1.4: assertCachePoolWritable', () => {
  it('happy: existing-writable-dir → returns undefined, no throw', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-aspw-happy-'));
    try {
      expect(() => assertCachePoolWritable(tmpRoot)).not.toThrow();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('happy-idempotent: dir already exists, mkdirSync recursive returns existing → no throw', () => {
    let mkdirCalls = 0;
    const deps = makeDeps({
      mkdirSync: () => {
        mkdirCalls++;
        return undefined; // recursive no-op
      },
    });
    expect(() => assertCachePoolWritable('/tmp/x265-aspw-existing', deps)).not.toThrow();
    expect(mkdirCalls).toBe(1);
  });

  it('throws shape-error (string-typed) on empty string — NOT CachePoolUnavailableError', () => {
    let caught: unknown = null;
    try {
      assertCachePoolWritable('');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(CachePoolUnavailableError);
    expect((caught as Error).message).toBe('invalid_cache_pool_path:empty');
  });

  it('throws CachePoolUnavailableError on mkdir EACCES — preserves Error.cause (audit SR7)', () => {
    const original = makeErrnoError('EACCES', 'mkdir');
    const deps = makeDeps({
      mkdirSync: () => {
        throw original;
      },
    });
    let caught: unknown = null;
    try {
      assertCachePoolWritable('/tmp/x265-aspw-eacces', deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CachePoolUnavailableError);
    expect((caught as CachePoolUnavailableError).code).toBe('EACCES');
    expect((caught as CachePoolUnavailableError).cause).toBe(original);
    expect((caught as CachePoolUnavailableError).message).toContain('(mkdir)');
  });

  it('throws CachePoolUnavailableError on mkdir ENOENT (parent missing)', () => {
    const deps = makeDeps({
      mkdirSync: () => {
        throw makeErrnoError('ENOENT', 'mkdir');
      },
    });
    let caught: CachePoolUnavailableError | null = null;
    try {
      assertCachePoolWritable('/nonexistent-parent/sub', deps);
    } catch (e) {
      caught = e as CachePoolUnavailableError;
    }
    expect(caught).toBeInstanceOf(CachePoolUnavailableError);
    expect(caught!.code).toBe('ENOENT');
  });

  it('throws CachePoolUnavailableError on write-probe EROFS — preserves syscall=open via cause (audit SR6 + SR7)', () => {
    const original = makeErrnoError('EROFS', 'open');
    const deps = makeDeps({
      mkdirSync: () => undefined,
      writeFileSync: () => {
        throw original;
      },
    });
    let caught: unknown = null;
    try {
      assertCachePoolWritable('/tmp/x265-aspw-erofs', deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CachePoolUnavailableError);
    expect((caught as CachePoolUnavailableError).code).toBe('EROFS');
    expect((caught as CachePoolUnavailableError).message).toContain('(write-probe)');
    const cause = (caught as CachePoolUnavailableError).cause as ErrnoLike;
    expect(cause.syscall).toBe('open');
  });

  it.each([
    ['ENOTDIR', 'mkdir on a regular-file parent surfaces ENOTDIR'],
    ['ELOOP', 'symlink cycle surfaces ELOOP'],
  ])(
    'open-set errno coverage (audit SR10): mkdir throws %s → cause-string carries raw OS code',
    (code) => {
      const deps = makeDeps({
        mkdirSync: () => {
          throw makeErrnoError(code, 'mkdir');
        },
      });
      let caught: CachePoolUnavailableError | null = null;
      try {
        assertCachePoolWritable('/tmp/x265-aspw-openset', deps);
      } catch (e) {
        caught = e as CachePoolUnavailableError;
      }
      expect(caught).toBeInstanceOf(CachePoolUnavailableError);
      expect(caught!.code).toBe(code); // raw OS-error code, NO remapping
      expect(caught!.message).toBe(`cache_pool_unavailable:${code} (mkdir)`);
    },
  );
});
