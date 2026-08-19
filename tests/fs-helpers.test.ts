// 28-03 (P10): moveAcrossFilesystems is now async (node:fs/promises) so a
// multi-GB cross-FS restore copy no longer blocks the event loop. Semantics are
// byte-identical to the prior sync version — this suite is adapted to await the
// helper and to mock the fs/promises methods (default-export property reassign,
// mirroring the prior sync-mock style).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import sync from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { moveAcrossFilesystems } from '@/src/lib/fs-helpers';

describe('moveAcrossFilesystems (async, P10)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = sync.mkdtempSync(path.join(os.tmpdir(), 'fs-helpers-'));
  });

  afterEach(() => {
    sync.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_when_same_fs_then_renames_and_resolves', async () => {
    const src = path.join(tmpDir, 'src.txt');
    const dst = path.join(tmpDir, 'dst.txt');
    sync.writeFileSync(src, 'hello');

    await moveAcrossFilesystems(src, dst);

    expect(sync.existsSync(src)).toBe(false);
    expect(sync.existsSync(dst)).toBe(true);
    expect(sync.readFileSync(dst, 'utf8')).toBe('hello');
  });

  it('test_when_src_missing_then_rejects_ENOENT', async () => {
    const src = path.join(tmpDir, 'missing.txt');
    const dst = path.join(tmpDir, 'dst.txt');
    await expect(moveAcrossFilesystems(src, dst)).rejects.toThrow();
  });

  it('test_when_EXDEV_then_falls_back_to_copy_fsync_rename_unlink', async () => {
    const src = path.join(tmpDir, 'src.bin');
    const dst = path.join(tmpDir, 'dst.bin');
    sync.writeFileSync(src, Buffer.from([1, 2, 3, 4, 5]));

    const realRename = fsp.rename;
    let renameCalls = 0;
    fsp.rename = (async (from: string, to: string) => {
      renameCalls += 1;
      if (renameCalls === 1) {
        const err = new Error('EXDEV cross-device link') as NodeJS.ErrnoException;
        err.code = 'EXDEV';
        throw err;
      }
      return realRename(from, to);
    }) as typeof fsp.rename;

    try {
      await moveAcrossFilesystems(src, dst);
      expect(sync.existsSync(src)).toBe(false);
      expect(sync.existsSync(dst)).toBe(true);
      expect(sync.readFileSync(dst)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
      expect(renameCalls).toBe(2);
    } finally {
      fsp.rename = realRename;
    }
  });

  it('test_when_EXDEV_and_stale_tmp_exists_then_unlinks_first', async () => {
    const src = path.join(tmpDir, 'src.bin');
    const dst = path.join(tmpDir, 'dst.bin');
    const tmp = `${dst}.x265-butler.move.tmp`;
    sync.writeFileSync(src, 'new');
    sync.writeFileSync(tmp, 'stale');

    const realRename = fsp.rename;
    let renameCalls = 0;
    fsp.rename = (async (from: string, to: string) => {
      renameCalls += 1;
      if (renameCalls === 1) {
        const err = new Error('EXDEV') as NodeJS.ErrnoException;
        err.code = 'EXDEV';
        throw err;
      }
      return realRename(from, to);
    }) as typeof fsp.rename;

    try {
      await moveAcrossFilesystems(src, dst);
      expect(sync.readFileSync(dst, 'utf8')).toBe('new');
    } finally {
      fsp.rename = realRename;
    }
  });

  it('test_when_non_EXDEV_error_then_rethrows_and_src_intact', async () => {
    const src = path.join(tmpDir, 'src.bin');
    const dst = path.join(tmpDir, 'dst.bin');
    sync.writeFileSync(src, 'x');

    const realRename = fsp.rename;
    fsp.rename = (async () => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }) as typeof fsp.rename;

    try {
      await expect(moveAcrossFilesystems(src, dst)).rejects.toThrow(/EACCES/);
      expect(sync.existsSync(src)).toBe(true);
    } finally {
      fsp.rename = realRename;
    }
  });

  it('test_when_EXDEV_and_copy_fails_then_cleans_up_tmp_and_rejects', async () => {
    const src = path.join(tmpDir, 'src.bin');
    const dst = path.join(tmpDir, 'dst.bin');
    sync.writeFileSync(src, 'data');

    const realRename = fsp.rename;
    fsp.rename = (async () => {
      const err = new Error('EXDEV') as NodeJS.ErrnoException;
      err.code = 'EXDEV';
      throw err;
    }) as typeof fsp.rename;
    const realCopy = fsp.copyFile;
    fsp.copyFile = (async () => {
      throw new Error('disk full');
    }) as typeof fsp.copyFile;

    try {
      await expect(moveAcrossFilesystems(src, dst)).rejects.toThrow(/disk full/);
      const tmp = `${dst}.x265-butler.move.tmp`;
      expect(sync.existsSync(tmp)).toBe(false);
    } finally {
      fsp.rename = realRename;
      fsp.copyFile = realCopy;
    }
  });
});
