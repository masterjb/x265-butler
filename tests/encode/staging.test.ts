import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertCachePoolFreeSpace,
  assertValidStageRoot,
  CachePoolPreFlightError,
  cleanupStage,
  commitOutput,
  createStageDir,
  __forTests_cachePoolCooldownSize,
  __forTests_resetCachePoolCooldowns,
  outputPathFor,
  replaceInPlace,
  replaceOutputPathFor,
  sanitizeOutputSuffix,
  stageInputSymlink,
  stageOutputPath,
  trashOriginal,
  trashPathFor,
  workDirFor,
} from '@/src/lib/encode/staging';

let stageRoot: string;
let mediaRoot: string;

beforeEach(() => {
  stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-stage-'));
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'x265-media-'));
});

afterEach(() => {
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.rmSync(mediaRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('staging — pure path helpers', () => {
  it('test_workDirFor_returns_expected_path', () => {
    expect(workDirFor('/cache', 42)).toBe(path.join('/cache', 'work', '42'));
  });

  // Default sanitizer fallback changed from '.x265.mkv' → '-x265.mkv'
  // (label-style infix). outputPathFor's 1-arg invocation calls
  // sanitizeOutputSuffix(undefined) which now returns the new default with
  // container='mkv' (the function's signature default).
  it('test_outputPathFor_strips_extension_and_appends_default', () => {
    expect(outputPathFor('/m/Foo Bar (2024).mp4')).toBe('/m/Foo Bar (2024)-x265.mkv');
  });

  it('test_outputPathFor_no_extension_appends_directly', () => {
    expect(outputPathFor('/m/file_no_ext')).toBe('/m/file_no_ext-x265.mkv');
  });

  it('test_outputPathFor_dotfile_with_ext_handled', () => {
    expect(outputPathFor('/m/.foo.mp4')).toBe('/m/.foo-x265.mkv');
  });

  // replaceOutputPathFor yields the original basename + the BARE
  // container ext (no '-x265' label). Same-ext returns the original path EXACTLY.
  it('test_replaceOutputPathFor_same_ext_mkv_returns_original_path', () => {
    expect(replaceOutputPathFor('/m/Movie (2024).mkv', 'mkv')).toBe('/m/Movie (2024).mkv');
  });

  it('test_replaceOutputPathFor_diff_ext_avi_to_mkv_yields_bare_sibling', () => {
    expect(replaceOutputPathFor('/m/Movie (2024).avi', 'mkv')).toBe('/m/Movie (2024).mkv');
  });

  it('test_replaceOutputPathFor_mp4_container_uses_bare_mp4', () => {
    expect(replaceOutputPathFor('/m/clip.mkv', 'mp4')).toBe('/m/clip.mp4');
    expect(replaceOutputPathFor('/m/clip.mp4', 'mp4')).toBe('/m/clip.mp4');
  });

  it('test_replaceOutputPathFor_never_contains_x265_label', () => {
    expect(replaceOutputPathFor('/m/foo.avi', 'mkv')).not.toContain('-x265');
    expect(replaceOutputPathFor('/m/foo.avi', 'mkv')).not.toContain('.x265.');
  });

  it('test_trashPathFor_format_matches_jobId_dash_timestamp_slash_basename', () => {
    // 1735689600 = 2025-01-01T00:00:00Z
    expect(trashPathFor('/m/x.mp4', '/cache/x265', 42, 1_735_689_600)).toBe(
      path.join('/cache/x265', 'trash', '42-20250101000000', 'x.mp4'),
    );
  });

  it('test_trashPathFor_routes_under_custom_trashRoot', () => {
    // A configured trash_path (array mount) routes the trash subtree
    // under THAT root, not the cache stageRoot.
    expect(trashPathFor('/mnt/cache/m/x.mp4', '/mnt/user/media-trash', 7, 1_735_689_600)).toBe(
      path.join('/mnt/user/media-trash', 'trash', '7-20250101000000', 'x.mp4'),
    );
  });

  it('test_stageOutputPath_returns_output_x265_mkv_inside_stage', () => {
    expect(stageOutputPath('/cache/work/42')).toBe('/cache/work/42/output.x265.mkv');
  });
});

describe('staging — assertValidStageRoot', () => {
  it('test_assertValidStageRoot_when_empty_then_throws', () => {
    expect(() => assertValidStageRoot('')).toThrow(/invalid_cache_pool_path:empty/);
  });

  it('test_assertValidStageRoot_when_relative_path_then_throws_not_absolute', () => {
    expect(() => assertValidStageRoot('cache/pool')).toThrow(/not_absolute/);
  });

  it('test_assertValidStageRoot_when_contains_dotdot_then_throws_traversal', () => {
    expect(() => assertValidStageRoot('/cache/../etc')).toThrow(/traversal/);
    expect(() => assertValidStageRoot('/..')).toThrow(/traversal/);
  });

  it('test_assertValidStageRoot_when_contains_null_byte_then_throws_null_byte', () => {
    expect(() => assertValidStageRoot('/cache\0pool')).toThrow(/null_byte/);
  });

  it('test_assertValidStageRoot_when_valid_absolute_path_then_no_throw', () => {
    expect(() => assertValidStageRoot('/mnt/cache/x265-butler')).not.toThrow();
    expect(() => assertValidStageRoot('/tmp/x')).not.toThrow();
  });

  it('test_createStageDir_calls_assertValidStageRoot_first', () => {
    expect(() => createStageDir('relative/path', 1)).toThrow(/not_absolute/);
  });
});

describe('staging — createStageDir + cleanupStage', () => {
  it('test_createStageDir_creates_recursive_dir_and_is_idempotent', () => {
    const dir1 = createStageDir(stageRoot, 7);
    expect(fs.statSync(dir1).isDirectory()).toBe(true);
    // Second call must be idempotent (no throw).
    const dir2 = createStageDir(stageRoot, 7);
    expect(dir1).toBe(dir2);
  });

  it('test_cleanupStage_when_dir_exists_then_removes_recursive', () => {
    const dir = createStageDir(stageRoot, 9);
    fs.writeFileSync(path.join(dir, 'foo'), 'bar');
    cleanupStage(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('test_cleanupStage_when_dir_missing_then_no_throw', () => {
    expect(() => cleanupStage('/tmp/x265-butler-does-not-exist-zzz')).not.toThrow();
  });
});

describe('staging — stageInputSymlink (source-exists guard)', () => {
  it('test_stageInputSymlink_creates_symlink_with_target', () => {
    const src = path.join(mediaRoot, 'src.mp4');
    fs.writeFileSync(src, 'data');
    const stageDir = createStageDir(stageRoot, 1);
    const link = stageInputSymlink(src, stageDir);
    expect(link).toBe(path.join(stageDir, 'input'));
    expect(fs.readlinkSync(link)).toBe(src);
    expect(fs.readFileSync(link, 'utf8')).toBe('data');
  });

  it('test_stageInputSymlink_when_source_missing_then_throws_source_vanished', () => {
    const stageDir = createStageDir(stageRoot, 2);
    expect(() => stageInputSymlink(path.join(mediaRoot, 'gone.mp4'), stageDir)).toThrow(
      /^source_vanished:/,
    );
  });
});

// Moving into place goes through the async moveAcrossFilesystems helper, so a
// multi-GB copy across filesystems never blocks the event loop. The EXDEV branch
// is forced by failing the first fs/promises rename.
function failFirstRenameWithExdev(): () => void {
  const realRename = fsp.rename;
  let calls = 0;
  fsp.rename = (async (src: string, dest: string) => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    return realRename(src, dest);
  }) as typeof fsp.rename;
  return () => {
    fsp.rename = realRename;
  };
}

describe('staging — commitOutput (rename + EXDEV fallback)', () => {
  it('test_commitOutput_when_same_filesystem_then_uses_rename', async () => {
    const stageOut = path.join(stageRoot, 'output.x265.mkv');
    fs.writeFileSync(stageOut, 'encoded');
    const sameFsFinal = path.join(stageRoot, 'committed.x265.mkv');
    await commitOutput(stageOut, sameFsFinal);
    expect(fs.existsSync(stageOut)).toBe(false);
    expect(fs.readFileSync(sameFsFinal, 'utf8')).toBe('encoded');
  });

  it('keeps output_path_exists', async () => {
    const stageOut = path.join(stageRoot, 'output.x265.mkv');
    const finalOut = path.join(stageRoot, 'final.x265.mkv');
    fs.writeFileSync(stageOut, 'new');
    fs.writeFileSync(finalOut, 'existing');
    await expect(commitOutput(stageOut, finalOut)).rejects.toThrow(/output_path_exists/);
    expect(fs.readFileSync(stageOut, 'utf8')).toBe('new');
    expect(fs.readFileSync(finalOut, 'utf8')).toBe('existing');
  });

  it('EXDEV goes through the async move', async () => {
    const stageOut = path.join(stageRoot, 'output.x265.mkv');
    const finalOut = path.join(mediaRoot, 'final.x265.mkv');
    fs.writeFileSync(stageOut, 'encoded');
    const copySpy = vi.spyOn(fsp, 'copyFile');
    const restore = failFirstRenameWithExdev();
    try {
      await commitOutput(stageOut, finalOut);
    } finally {
      restore();
    }
    expect(copySpy).toHaveBeenCalledWith(stageOut, `${finalOut}.x265-butler.move.tmp`);
    expect(fs.existsSync(stageOut)).toBe(false);
    expect(fs.readFileSync(finalOut, 'utf8')).toBe('encoded');
  });

  it('uses no sync copy', async () => {
    const stageOut = path.join(stageRoot, 'output.x265.mkv');
    const finalOut = path.join(mediaRoot, 'final.x265.mkv');
    const src = path.join(mediaRoot, 'orig.mp4');
    fs.writeFileSync(stageOut, 'encoded');
    fs.writeFileSync(src, 'orig');
    const syncCopy = vi.spyOn(fs, 'copyFileSync');
    const syncRename = vi.spyOn(fs, 'renameSync');
    const syncFsync = vi.spyOn(fs, 'fsyncSync');
    let restore = failFirstRenameWithExdev();
    try {
      await commitOutput(stageOut, finalOut);
    } finally {
      restore();
    }
    restore = failFirstRenameWithExdev();
    try {
      await trashOriginal(src, path.join(stageRoot, 'trash', '9-20250101000000', 'orig.mp4'));
    } finally {
      restore();
    }
    expect(syncCopy).not.toHaveBeenCalled();
    expect(syncRename).not.toHaveBeenCalled();
    expect(syncFsync).not.toHaveBeenCalled();
  });

  it('failure mid-copy keeps the source and removes the tmp', async () => {
    const stageOut = path.join(stageRoot, 'output.x265.mkv');
    const finalOut = path.join(mediaRoot, 'final.x265.mkv');
    fs.writeFileSync(stageOut, 'data');
    const realCopy = fsp.copyFile;
    fsp.copyFile = (async () => {
      throw new Error('disk full');
    }) as typeof fsp.copyFile;
    const restore = failFirstRenameWithExdev();
    try {
      await expect(commitOutput(stageOut, finalOut)).rejects.toThrow(/disk full/);
    } finally {
      restore();
      fsp.copyFile = realCopy;
    }
    expect(fs.readFileSync(stageOut, 'utf8')).toBe('data');
    expect(fs.existsSync(`${finalOut}.x265-butler.move.tmp`)).toBe(false);
    expect(fs.existsSync(finalOut)).toBe(false);
  });
});

describe('staging — trashOriginal', () => {
  it('test_trashOriginal_creates_parent_dir_and_moves', async () => {
    const src = path.join(mediaRoot, 'orig.mp4');
    fs.writeFileSync(src, 'orig-data');
    const trashTarget = path.join(stageRoot, 'trash', '7-20250101000000', 'orig.mp4');
    await trashOriginal(src, trashTarget);
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.readFileSync(trashTarget, 'utf8')).toBe('orig-data');
  });

  it('test_trashOriginal_handles_EXDEV_fallback', async () => {
    const src = path.join(mediaRoot, 'orig.mp4');
    fs.writeFileSync(src, 'orig');
    const trashTarget = path.join(stageRoot, 'trash', '8-20250101000000', 'orig.mp4');
    const restore = failFirstRenameWithExdev();
    try {
      await trashOriginal(src, trashTarget);
    } finally {
      restore();
    }
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.readFileSync(trashTarget, 'utf8')).toBe('orig');
  });
});

// sanitizeOutputSuffix container-aware contract.
// Covers label-style composition for both containers, already-suffixed
// terminal-extension precedence, and container-aware fallback semantics
// for invalid input.
describe('staging — sanitizeOutputSuffix container-aware', () => {
  // Label-style composition: bare label + BARE_EXT_FOR[container].
  it('test_label_x265_with_container_mkv_returns_label_dot_mkv', () => {
    expect(sanitizeOutputSuffix('-x265', 'mkv')).toBe('-x265.mkv');
  });
  it('test_label_x265_with_container_mp4_returns_label_dot_mp4', () => {
    expect(sanitizeOutputSuffix('-x265', 'mp4')).toBe('-x265.mp4');
  });
  it('test_label_h265_with_container_mp4_closes_former_latent_bug', () => {
    // Formerly label-style ALWAYS appended .mkv regardless of container.
    // Fix: container-aware bare extension.
    expect(sanitizeOutputSuffix('_h265', 'mp4')).toBe('_h265.mp4');
  });

  // Already-suffixed: terminal-extension precedence —
  // container arg ignored.
  it('test_already_suffixed_x265_mkv_with_container_mp4_returns_as_is', () => {
    expect(sanitizeOutputSuffix('.x265.mkv', 'mp4')).toBe('.x265.mkv');
  });
  it('test_already_suffixed_x265_mp4_with_container_mkv_returns_as_is', () => {
    expect(sanitizeOutputSuffix('.x265.mp4', 'mkv')).toBe('.x265.mp4');
  });

  // Container-aware fallback (D3=α): invalid input yields a working filename
  // per container (no hidden '.mkv' on mp4-container installs).
  it('test_undefined_input_with_container_mp4_yields_dash_x265_dot_mp4', () => {
    expect(sanitizeOutputSuffix(undefined, 'mp4')).toBe('-x265.mp4');
  });
  it('test_undefined_input_with_container_mkv_yields_dash_x265_dot_mkv', () => {
    expect(sanitizeOutputSuffix(undefined, 'mkv')).toBe('-x265.mkv');
  });
  it('test_oversized_input_with_container_mp4_yields_fallback_mp4', () => {
    expect(sanitizeOutputSuffix('abc'.repeat(20), 'mp4')).toBe('-x265.mp4');
  });
  it('test_forbidden_chars_input_with_container_mp4_yields_fallback_mp4', () => {
    expect(sanitizeOutputSuffix('foo/bar', 'mp4')).toBe('-x265.mp4');
  });

  // Default-container argument: omitting the second arg defaults to 'mkv'
  // so existing 1-arg call sites (outputPathFor) keep working.
  it('test_default_container_arg_is_mkv', () => {
    expect(sanitizeOutputSuffix('-x265')).toBe('-x265.mkv');
  });
});

// _cachePoolCooldowns is a process-global Map whose entries are deleted
// today ONLY when the same fileId re-dispatches with sufficient space — a file
// removed from the library leaks its key forever. assertCachePoolFreeSpace now
// (a) lazily evicts an EXPIRED key on read and (b) opportunistically sweeps ALL
// expired entries when the Map crosses CACHE_POOL_COOLDOWN_MAX_KEYS (1024). Live
// cooldown semantics stay byte-identical.
describe('staging — assertCachePoolFreeSpace stale-key eviction', () => {
  const cachePoolPath = '/cache-pool-r3';
  const fullPool = () => ({ bavail: BigInt(0), bsize: BigInt(0) });
  const roomyPool = () => ({ bavail: BigInt(1_000_000_000), bsize: BigInt(1) });

  beforeEach(() => {
    __forTests_resetCachePoolCooldowns();
  });
  afterEach(() => {
    __forTests_resetCachePoolCooldowns();
  });

  it('test_sweeps_expired_stale_keys_keeping_live_key_only', () => {
    const NOW_STALE = 1_000_000;
    const NOW_LIVE = 1_400_000;
    const NOW_FINAL = 1_500_000;
    const STALE_COUNT = 1100; // > CACHE_POOL_COOLDOWN_MAX_KEYS (1024)

    // 1) Seed ONE live key (recent) FIRST so the later stale-insert sweeps —
    //    which run at the OLDER NOW_STALE clock — never see it as expired.
    expect(() =>
      assertCachePoolFreeSpace(1, {
        cooldownKey: 'live',
        cachePoolPath,
        statfsSync: fullPool,
        now: NOW_LIVE,
      }),
    ).toThrow(CachePoolPreFlightError);

    // 2) Seed > cap STALE keys at the OLD clock. Each full-pool call sets its key
    //    to NOW_STALE; sweeps during these calls reclaim nothing (every key is
    //    fresh relative to NOW_STALE, and 'live' is in its future).
    for (let i = 0; i < STALE_COUNT; i += 1) {
      try {
        assertCachePoolFreeSpace(1, {
          cooldownKey: `stale_${i}`,
          cachePoolPath,
          statfsSync: fullPool,
          now: NOW_STALE,
        });
      } catch {
        // expected CachePoolPreFlightError — the full-pool sets the cooldown key.
      }
    }
    expect(__forTests_cachePoolCooldownSize()).toBe(STALE_COUNT + 1);

    // 3) One roomy call at NOW_FINAL with a NEW key → triggers the over-cap sweep:
    //    every stale key (>=5min old) is reclaimed; 'live' (100s old) survives;
    //    the new 'trigger' key is success-deleted at the end.
    assertCachePoolFreeSpace(1, {
      cooldownKey: 'trigger',
      cachePoolPath,
      statfsSync: roomyPool,
      now: NOW_FINAL,
    });

    // The Map collapsed to the single live key (fails RED if the sweep is removed:
    // the stale keys would all be retained → size === STALE_COUNT + 1).
    expect(__forTests_cachePoolCooldownSize()).toBe(1);

    // Live-key cooldown semantics UNCHANGED: still within-window at NOW_FINAL →
    // short-circuits to CachePoolPreFlightError(0, requiredBytes) WITHOUT statfs.
    let threw = false;
    try {
      assertCachePoolFreeSpace(4, {
        cooldownKey: 'live',
        cachePoolPath,
        statfsSync: () => {
          throw new Error('statfs must NOT run for a within-window key');
        },
        now: NOW_FINAL,
      });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(CachePoolPreFlightError);
      expect((err as CachePoolPreFlightError).availableBytes).toBe(0);
      expect((err as CachePoolPreFlightError).requiredBytes).toBe(8); // ceil(4 * 2)
    }
    expect(threw).toBe(true);
  });
});

describe('staging: replaceInPlace (no trash)', () => {
  function setupFiles(name = 'movie.mkv'): { stageOut: string; target: string } {
    const stageOut = path.join(stageRoot, 'out.mkv');
    const target = path.join(mediaRoot, name);
    fs.writeFileSync(stageOut, 'encoded');
    fs.writeFileSync(target, 'original');
    return { stageOut, target };
  }

  function dotTemps(): string[] {
    return fs.readdirSync(mediaRoot).filter((n) => n.startsWith('.x265-butler-replace-'));
  }

  // Records the order of open (fsync goes through an opened handle) and rename.
  function recordCalls(): { calls: string[]; restore: () => void } {
    const calls: string[] = [];
    const realOpen = fsp.open;
    const realRename = fsp.rename;
    fsp.open = (async (p: fs.PathLike, flags?: string | number) => {
      const fh = await realOpen(p, flags as string);
      const realSync = fh.sync.bind(fh);
      fh.sync = async () => {
        calls.push(`sync:${path.basename(String(p))}`);
        return realSync();
      };
      return fh;
    }) as typeof fsp.open;
    fsp.rename = (async (a: fs.PathLike, b: fs.PathLike) => {
      calls.push(`rename:${path.basename(String(a))}->${path.basename(String(b))}`);
      return realRename(a, b);
    }) as typeof fsp.rename;
    return {
      calls,
      restore: () => {
        fsp.open = realOpen;
        fsp.rename = realRename;
      },
    };
  }

  it('writes a dot temp next to the target, syncs it and renames it over the original', async () => {
    const { stageOut, target } = setupFiles();
    const rec = recordCalls();
    try {
      await replaceInPlace(stageOut, target, { jobId: 7, replaceOriginal: true });
    } finally {
      rec.restore();
    }
    expect(fs.readFileSync(target, 'utf8')).toBe('encoded');
    expect(fs.existsSync(stageOut)).toBe(false);
    expect(dotTemps()).toEqual([]);
    const tmp = '.x265-butler-replace-7.tmp';
    const syncIdx = rec.calls.indexOf(`sync:${tmp}`);
    const finalRename = rec.calls.indexOf(`rename:${tmp}->movie.mkv`);
    expect(syncIdx).toBeGreaterThanOrEqual(0);
    expect(finalRename).toBeGreaterThan(syncIdx);
  });

  it('works for long file names because the temp name does not depend on them', async () => {
    const longName = `${'a'.repeat(246)}.mkv`;
    const { stageOut, target } = setupFiles(longName);
    await replaceInPlace(stageOut, target, { jobId: 3, replaceOriginal: true });
    expect(fs.readFileSync(target, 'utf8')).toBe('encoded');
  });

  it('clears a stale temp of an earlier attempt first', async () => {
    const { stageOut, target } = setupFiles();
    fs.writeFileSync(path.join(mediaRoot, '.x265-butler-replace-7.tmp'), 'stale debris');
    await replaceInPlace(stageOut, target, { jobId: 7, replaceOriginal: true });
    expect(fs.readFileSync(target, 'utf8')).toBe('encoded');
    expect(dotTemps()).toEqual([]);
  });

  it.each(['copy', 'sync', 'rename'] as const)(
    'keeps the original and removes the temp when the %s step fails',
    async (step) => {
      const { stageOut, target } = setupFiles();
      const realRename = fsp.rename;
      const realOpen = fsp.open;
      const fail = (): never => {
        throw Object.assign(new Error(`${step} failed`), { code: 'EIO' });
      };
      if (step === 'copy') {
        // First rename moves the staged output into the temp.
        fsp.rename = (async (a: fs.PathLike, b: fs.PathLike) => {
          if (String(b).endsWith('.tmp')) fail();
          return realRename(a, b);
        }) as typeof fsp.rename;
      } else if (step === 'sync') {
        fsp.open = (async (p: fs.PathLike, flags?: string | number) => {
          const fh = await realOpen(p, flags as string);
          if (String(p).endsWith('.tmp')) fh.sync = async () => fail();
          return fh;
        }) as typeof fsp.open;
      } else {
        fsp.rename = (async (a: fs.PathLike, b: fs.PathLike) => {
          if (String(a).endsWith('.tmp')) fail();
          return realRename(a, b);
        }) as typeof fsp.rename;
      }
      try {
        await expect(
          replaceInPlace(stageOut, target, { jobId: 7, replaceOriginal: true }),
        ).rejects.toThrow(`${step} failed`);
      } finally {
        fsp.rename = realRename;
        fsp.open = realOpen;
      }
      expect(fs.readFileSync(target, 'utf8')).toBe('original');
      expect(dotTemps()).toEqual([]);
    },
  );

  it('writes a sibling for another extension and refuses an existing one', async () => {
    const stageOut = path.join(stageRoot, 'out.mkv');
    fs.writeFileSync(stageOut, 'encoded');
    const original = path.join(mediaRoot, 'movie.avi');
    fs.writeFileSync(original, 'original');
    const sibling = path.join(mediaRoot, 'movie.mkv');

    await replaceInPlace(stageOut, sibling, { jobId: 1, replaceOriginal: false });
    expect(fs.readFileSync(sibling, 'utf8')).toBe('encoded');
    // The caller removes the original; replaceInPlace never touches it.
    expect(fs.readFileSync(original, 'utf8')).toBe('original');

    fs.writeFileSync(stageOut, 'encoded again');
    await expect(
      replaceInPlace(stageOut, sibling, { jobId: 2, replaceOriginal: false }),
    ).rejects.toThrow('output_path_exists');
    expect(fs.readFileSync(sibling, 'utf8')).toBe('encoded');
    expect(dotTemps()).toEqual([]);
  });
});
