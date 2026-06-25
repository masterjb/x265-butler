import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { walkFiles, type WalkOptions } from '@/src/lib/scan/walker';

const ABOVE_MIN = 2 * 1024 * 1024; // 2 MiB
const BELOW_MIN = 100 * 1024; // 100 KiB

async function collect(root: string, opts: WalkOptions): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of walkFiles(root, opts)) {
    out.push(entry.path);
  }
  return out.sort();
}

function writeSized(p: string, sizeBytes: number): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(sizeBytes));
}

describe('walkFiles', () => {
  let tmpdir: string;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it('test_walkFiles_when_extension_filter_then_yields_only_matching', async () => {
    writeSized(path.join(tmpdir, 'movie.mp4'), ABOVE_MIN);
    writeSized(path.join(tmpdir, 'audio.mp3'), ABOVE_MIN);
    const result = await collect(tmpdir, { extensions: ['mp4'], minSizeMb: 1 });
    expect(result).toEqual([path.join(tmpdir, 'movie.mp4')]);
  });

  it('test_walkFiles_when_file_below_min_size_then_skips', async () => {
    writeSized(path.join(tmpdir, 'small.mp4'), BELOW_MIN);
    writeSized(path.join(tmpdir, 'big.mp4'), ABOVE_MIN);
    const result = await collect(tmpdir, { extensions: ['mp4'], minSizeMb: 1 });
    expect(result).toEqual([path.join(tmpdir, 'big.mp4')]);
  });

  it('test_walkFiles_when_hidden_file_or_directory_then_skips', async () => {
    writeSized(path.join(tmpdir, 'visible.mp4'), ABOVE_MIN);
    writeSized(path.join(tmpdir, '.hidden.mp4'), ABOVE_MIN);
    writeSized(path.join(tmpdir, '.git', 'cached.mp4'), ABOVE_MIN);
    const result = await collect(tmpdir, { extensions: ['mp4'], minSizeMb: 1 });
    expect(result).toEqual([path.join(tmpdir, 'visible.mp4')]);
  });

  it('test_walkFiles_when_symlink_loop_then_does_not_infinite_walk', async () => {
    writeSized(path.join(tmpdir, 'real.mp4'), ABOVE_MIN);
    fs.symlinkSync(tmpdir, path.join(tmpdir, 'loop'));
    const result = await collect(tmpdir, { extensions: ['mp4'], minSizeMb: 1 });
    expect(result).toEqual([path.join(tmpdir, 'real.mp4')]);
  });

  it('test_walkFiles_when_depth_exceeds_maxDepth_then_does_not_recurse', async () => {
    let p = tmpdir;
    for (let i = 0; i < 10; i++) p = path.join(p, `d${i}`);
    writeSized(path.join(p, 'deep.mp4'), ABOVE_MIN);
    writeSized(path.join(tmpdir, 'shallow.mp4'), ABOVE_MIN);
    const result = await collect(tmpdir, {
      extensions: ['mp4'],
      minSizeMb: 1,
      maxDepth: 3,
    });
    expect(result).toEqual([path.join(tmpdir, 'shallow.mp4')]);
  });

  it('test_walkFiles_when_recursive_directories_then_yields_all_matches', async () => {
    writeSized(path.join(tmpdir, 'a.mp4'), ABOVE_MIN);
    writeSized(path.join(tmpdir, 'sub', 'b.mp4'), ABOVE_MIN);
    writeSized(path.join(tmpdir, 'sub', 'sub2', 'c.mp4'), ABOVE_MIN);
    const result = await collect(tmpdir, { extensions: ['mp4'], minSizeMb: 1 });
    expect(result).toEqual([
      path.join(tmpdir, 'a.mp4'),
      path.join(tmpdir, 'sub', 'b.mp4'),
      path.join(tmpdir, 'sub', 'sub2', 'c.mp4'),
    ]);
  });

  it('test_walkFiles_when_extensions_have_dots_or_uppercase_then_normalizes', async () => {
    writeSized(path.join(tmpdir, 'movie.MP4'), ABOVE_MIN);
    writeSized(path.join(tmpdir, 'series.MKV'), ABOVE_MIN);
    const result = await collect(tmpdir, {
      extensions: ['.mp4', 'MKV'],
      minSizeMb: 1,
    });
    expect(result).toEqual([path.join(tmpdir, 'movie.MP4'), path.join(tmpdir, 'series.MKV')]);
  });

  it('test_walkFiles_when_returned_entry_then_has_path_size_mtime', async () => {
    writeSized(path.join(tmpdir, 'sample.mp4'), ABOVE_MIN);
    const out: { path: string; size: number; mtime: number }[] = [];
    for await (const entry of walkFiles(tmpdir, { extensions: ['mp4'], minSizeMb: 1 })) {
      out.push(entry);
    }
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe(path.join(tmpdir, 'sample.mp4'));
    expect(out[0].size).toBe(ABOVE_MIN);
    expect(out[0].mtime).toBeGreaterThan(0);
  });

  it('test_walkFiles_when_root_not_absolute_then_throws', async () => {
    await expect(
      (async () => {
        for await (const _e of walkFiles('relative/path', {
          extensions: ['mp4'],
          minSizeMb: 1,
        })) {
          /* drain */
        }
      })(),
    ).rejects.toThrow(/absolute/);
  });

  it('test_walkFiles_when_root_does_not_exist_then_throws', async () => {
    const fake = path.join(os.tmpdir(), `__nonexistent_${Date.now()}_${Math.random()}`);
    await expect(
      (async () => {
        for await (const _e of walkFiles(fake, { extensions: ['mp4'], minSizeMb: 1 })) {
          /* drain */
        }
      })(),
    ).rejects.toThrow();
  });

  it('test_walkFiles_when_root_is_file_not_directory_then_throws', async () => {
    const file = path.join(tmpdir, 'notadir.txt');
    fs.writeFileSync(file, 'x');
    await expect(
      (async () => {
        for await (const _e of walkFiles(file, { extensions: ['mp4'], minSizeMb: 1 })) {
          /* drain */
        }
      })(),
    ).rejects.toThrow(/not a directory/);
  });

  it('test_walkFiles_when_unreadable_subdir_then_continues_with_warn', async () => {
    writeSized(path.join(tmpdir, 'visible.mp4'), ABOVE_MIN);
    const blockedDir = path.join(tmpdir, 'blocked');
    fs.mkdirSync(blockedDir);
    writeSized(path.join(blockedDir, 'inside.mp4'), ABOVE_MIN);
    // Drop read perms on subdir; walker should warn + skip.
    try {
      fs.chmodSync(blockedDir, 0o000);
      const result = await collect(tmpdir, { extensions: ['mp4'], minSizeMb: 1 });
      expect(result).toContain(path.join(tmpdir, 'visible.mp4'));
    } finally {
      fs.chmodSync(blockedDir, 0o755);
    }
  });
});
