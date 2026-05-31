import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { moveAcrossFilesystems } from '@/src/lib/fs-helpers';

describe('moveAcrossFilesystems', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-helpers-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('test_moveAcrossFilesystems_when_same_fs_then_renames_via_renameSync', () => {
    const src = path.join(tmpDir, 'src.txt');
    const dst = path.join(tmpDir, 'dst.txt');
    fs.writeFileSync(src, 'hello');

    moveAcrossFilesystems(src, dst);

    expect(fs.existsSync(src)).toBe(false);
    expect(fs.existsSync(dst)).toBe(true);
    expect(fs.readFileSync(dst, 'utf8')).toBe('hello');
  });

  it('test_moveAcrossFilesystems_when_src_missing_then_throws_ENOENT', () => {
    const src = path.join(tmpDir, 'missing.txt');
    const dst = path.join(tmpDir, 'dst.txt');

    expect(() => moveAcrossFilesystems(src, dst)).toThrow();
  });

  it('test_moveAcrossFilesystems_when_EXDEV_then_falls_back_to_copy_fsync_rename_unlink', () => {
    const src = path.join(tmpDir, 'src.bin');
    const dst = path.join(tmpDir, 'dst.bin');
    fs.writeFileSync(src, Buffer.from([1, 2, 3, 4, 5]));

    const realRename = fs.renameSync;
    let renameCalls = 0;
    fs.renameSync = ((from: string, to: string) => {
      renameCalls += 1;
      if (renameCalls === 1) {
        const err = new Error('EXDEV cross-device link') as NodeJS.ErrnoException;
        err.code = 'EXDEV';
        throw err;
      }
      return realRename(from, to);
    }) as typeof fs.renameSync;

    try {
      moveAcrossFilesystems(src, dst);

      expect(fs.existsSync(src)).toBe(false);
      expect(fs.existsSync(dst)).toBe(true);
      expect(fs.readFileSync(dst)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
      expect(renameCalls).toBe(2);
    } finally {
      fs.renameSync = realRename;
    }
  });

  it('test_moveAcrossFilesystems_when_EXDEV_and_tmp_exists_then_unlinks_first', () => {
    const src = path.join(tmpDir, 'src.bin');
    const dst = path.join(tmpDir, 'dst.bin');
    const tmp = `${dst}.x265-butler.move.tmp`;
    fs.writeFileSync(src, 'new');
    fs.writeFileSync(tmp, 'stale');

    const realRename = fs.renameSync;
    let renameCalls = 0;
    fs.renameSync = ((from: string, to: string) => {
      renameCalls += 1;
      if (renameCalls === 1) {
        const err = new Error('EXDEV') as NodeJS.ErrnoException;
        err.code = 'EXDEV';
        throw err;
      }
      return realRename(from, to);
    }) as typeof fs.renameSync;

    try {
      moveAcrossFilesystems(src, dst);
      expect(fs.readFileSync(dst, 'utf8')).toBe('new');
    } finally {
      fs.renameSync = realRename;
    }
  });

  it('test_moveAcrossFilesystems_when_non_EXDEV_error_then_rethrows', () => {
    const src = path.join(tmpDir, 'src.bin');
    const dst = path.join(tmpDir, 'dst.bin');
    fs.writeFileSync(src, 'x');

    const realRename = fs.renameSync;
    fs.renameSync = (() => {
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }) as typeof fs.renameSync;

    try {
      expect(() => moveAcrossFilesystems(src, dst)).toThrow(/EACCES/);
      expect(fs.existsSync(src)).toBe(true);
    } finally {
      fs.renameSync = realRename;
    }
  });

  it('test_moveAcrossFilesystems_when_EXDEV_and_copy_fails_then_cleans_up_tmp', () => {
    const src = path.join(tmpDir, 'src.bin');
    const dst = path.join(tmpDir, 'dst.bin');
    fs.writeFileSync(src, 'data');

    const realRename = fs.renameSync;
    fs.renameSync = (() => {
      const err = new Error('EXDEV') as NodeJS.ErrnoException;
      err.code = 'EXDEV';
      throw err;
    }) as typeof fs.renameSync;

    const realCopy = fs.copyFileSync;
    fs.copyFileSync = (() => {
      throw new Error('disk full');
    }) as typeof fs.copyFileSync;

    try {
      expect(() => moveAcrossFilesystems(src, dst)).toThrow(/disk full/);
      const tmp = `${dst}.x265-butler.move.tmp`;
      expect(fs.existsSync(tmp)).toBe(false);
    } finally {
      fs.renameSync = realRename;
      fs.copyFileSync = realCopy;
    }
  });
});
