import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
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

  // 16-05: default sanitizer fallback changed from '.x265.mkv' → '-x265.mkv'
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

  // 26-02 (F5): replaceOutputPathFor yields the original basename + the BARE
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

  it('test_trashPathFor_routes_under_custom_trashRoot_33_02', () => {
    // 33-02: a configured trash_path (array mount) routes the trash subtree
    // under THAT root, not the cache stageRoot.
    expect(trashPathFor('/mnt/cache/m/x.mp4', '/mnt/user/media-trash', 7, 1_735_689_600)).toBe(
      path.join('/mnt/user/media-trash', 'trash', '7-20250101000000', 'x.mp4'),
    );
  });

  it('test_stageOutputPath_returns_output_x265_mkv_inside_stage', () => {
    expect(stageOutputPath('/cache/work/42')).toBe('/cache/work/42/output.x265.mkv');
  });
});

describe('staging — assertValidStageRoot (audit S2 + S9)', () => {
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

describe('staging — stageInputSymlink (audit S10 source-exists guard)', () => {
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

describe('staging — commitOutput (rename + EXDEV fallback + audit M3 + S8)', () => {
  it('test_commitOutput_when_same_filesystem_then_uses_rename', () => {
    const stageOut = path.join(stageRoot, 'output.x265.mkv');
    const finalOut = path.join(mediaRoot, 'final.x265.mkv');
    fs.writeFileSync(stageOut, 'encoded');
    // Force same-FS by using one tmpdir tree (mkdtemp in same /tmp).
    const sameFsFinal = path.join(stageRoot, 'committed.x265.mkv');
    commitOutput(stageOut, sameFsFinal);
    expect(fs.existsSync(stageOut)).toBe(false);
    expect(fs.readFileSync(sameFsFinal, 'utf8')).toBe('encoded');
    // Suppress unused.
    void finalOut;
  });

  it('test_commitOutput_when_finalPath_exists_then_throws_output_path_exists', () => {
    const stageOut = path.join(stageRoot, 'output.x265.mkv');
    const finalOut = path.join(stageRoot, 'final.x265.mkv');
    fs.writeFileSync(stageOut, 'new');
    fs.writeFileSync(finalOut, 'existing');
    expect(() => commitOutput(stageOut, finalOut)).toThrow(/output_path_exists/);
    // Stage and final both still exist.
    expect(fs.readFileSync(stageOut, 'utf8')).toBe('new');
    expect(fs.readFileSync(finalOut, 'utf8')).toBe('existing');
  });

  it('test_commitOutput_when_EXDEV_then_falls_back_to_copy_fsync_rename', () => {
    const stageOut = path.join(stageRoot, 'output.x265.mkv');
    const finalOut = path.join(stageRoot, 'final.x265.mkv');
    fs.writeFileSync(stageOut, 'encoded');
    // Spy: throw EXDEV on FIRST renameSync (the stage→final), succeed on SECOND
    // (the tmp→final inside the EXDEV fallback).
    const realRename = fs.renameSync.bind(fs);
    const renameSpy = vi.spyOn(fs, 'renameSync');
    let callCount = 0;
    renameSpy.mockImplementation((src, dest) => {
      callCount++;
      if (callCount === 1) {
        const e = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
        throw e;
      }
      return realRename(src, dest);
    });
    commitOutput(stageOut, finalOut);
    renameSpy.mockRestore();
    expect(fs.existsSync(stageOut)).toBe(false);
    expect(fs.readFileSync(finalOut, 'utf8')).toBe('encoded');
  });

  it('test_commitOutput_when_EXDEV_then_fsync_uses_explicit_fd_pattern', () => {
    const stageOut = path.join(stageRoot, 'output.x265.mkv');
    const finalOut = path.join(stageRoot, 'final.x265.mkv');
    fs.writeFileSync(stageOut, 'data');
    // Force EXDEV path.
    const realRename = fs.renameSync.bind(fs);
    let callCount = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
      callCount++;
      if (callCount === 1) {
        throw Object.assign(new Error('exdev'), { code: 'EXDEV' });
      }
      return realRename(src, dest);
    });
    const openSpy = vi.spyOn(fs, 'openSync');
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync');
    const closeSpy = vi.spyOn(fs, 'closeSync');
    commitOutput(stageOut, finalOut);
    expect(openSpy).toHaveBeenCalledWith(expect.stringMatching(/\.x265-butler\.tmp$/), 'r');
    const fdReturned = openSpy.mock.results[0].value;
    expect(typeof fdReturned).toBe('number');
    expect(fsyncSpy).toHaveBeenCalledWith(fdReturned);
    expect(closeSpy).toHaveBeenCalledWith(fdReturned);
    // Order: open BEFORE fsync BEFORE close.
    expect(openSpy.mock.invocationCallOrder[0]).toBeLessThan(fsyncSpy.mock.invocationCallOrder[0]);
    expect(fsyncSpy.mock.invocationCallOrder[0]).toBeLessThan(closeSpy.mock.invocationCallOrder[0]);
  });

  it('test_commitOutput_when_EXDEV_and_prior_tmp_exists_then_unlinks_first', () => {
    const stageOut = path.join(stageRoot, 'output.x265.mkv');
    const finalOut = path.join(stageRoot, 'final.x265.mkv');
    const priorTmp = `${finalOut}.x265-butler.tmp`;
    fs.writeFileSync(stageOut, 'fresh');
    fs.writeFileSync(priorTmp, 'stale-debris');
    const realRename = fs.renameSync.bind(fs);
    let callCount = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
      callCount++;
      if (callCount === 1) throw Object.assign(new Error('exdev'), { code: 'EXDEV' });
      return realRename(src, dest);
    });
    commitOutput(stageOut, finalOut);
    expect(fs.readFileSync(finalOut, 'utf8')).toBe('fresh');
    expect(fs.existsSync(priorTmp)).toBe(false);
  });

  it('test_commitOutput_when_copy_fails_mid_EXDEV_then_cleans_up_tmp_file', () => {
    const stageOut = path.join(stageRoot, 'output.x265.mkv');
    const finalOut = path.join(stageRoot, 'final.x265.mkv');
    fs.writeFileSync(stageOut, 'data');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('exdev'), { code: 'EXDEV' });
    });
    vi.spyOn(fs, 'copyFileSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(() => commitOutput(stageOut, finalOut)).toThrow(/disk full/);
    const tmp = `${finalOut}.x265-butler.tmp`;
    expect(fs.existsSync(tmp)).toBe(false);
  });
});

describe('staging — trashOriginal', () => {
  it('test_trashOriginal_creates_parent_dir_and_moves', () => {
    const src = path.join(mediaRoot, 'orig.mp4');
    fs.writeFileSync(src, 'orig-data');
    const trashTarget = path.join(stageRoot, 'trash', '7-20250101000000', 'orig.mp4');
    trashOriginal(src, trashTarget);
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.readFileSync(trashTarget, 'utf8')).toBe('orig-data');
  });

  it('test_trashOriginal_handles_EXDEV_fallback', () => {
    const src = path.join(mediaRoot, 'orig.mp4');
    fs.writeFileSync(src, 'orig');
    const trashTarget = path.join(stageRoot, 'trash', '8-20250101000000', 'orig.mp4');
    const realRename = fs.renameSync.bind(fs);
    let callCount = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((s, d) => {
      callCount++;
      if (callCount === 1) throw Object.assign(new Error('exdev'), { code: 'EXDEV' });
      return realRename(s, d);
    });
    trashOriginal(src, trashTarget);
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.readFileSync(trashTarget, 'utf8')).toBe('orig');
  });
});

// 16-05: sanitizeOutputSuffix container-aware contract (AC-3).
// Covers label-style composition for both containers, already-suffixed
// terminal-extension precedence, and container-aware fallback semantics
// (D3=α) for invalid input.
describe('staging — sanitizeOutputSuffix container-aware (16-05 AC-3)', () => {
  // Label-style composition: bare label + BARE_EXT_FOR[container].
  it('test_label_x265_with_container_mkv_returns_label_dot_mkv', () => {
    expect(sanitizeOutputSuffix('-x265', 'mkv')).toBe('-x265.mkv');
  });
  it('test_label_x265_with_container_mp4_returns_label_dot_mp4', () => {
    expect(sanitizeOutputSuffix('-x265', 'mp4')).toBe('-x265.mp4');
  });
  it('test_label_h265_with_container_mp4_closes_pre_16_05_latent_bug', () => {
    // Pre-16-05: label-style ALWAYS appended .mkv regardless of container.
    // 16-05 fix: container-aware bare extension.
    expect(sanitizeOutputSuffix('_h265', 'mp4')).toBe('_h265.mp4');
  });

  // Already-suffixed: terminal-extension precedence (05-15 audit M2
  // carry-forward) — container arg ignored.
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

// 28-09 R3: _cachePoolCooldowns is a process-global Map whose entries are deleted
// today ONLY when the same fileId re-dispatches with sufficient space — a file
// removed from the library leaks its key forever. assertCachePoolFreeSpace now
// (a) lazily evicts an EXPIRED key on read and (b) opportunistically sweeps ALL
// expired entries when the Map crosses CACHE_POOL_COOLDOWN_MAX_KEYS (1024). Live
// cooldown semantics stay byte-identical.
describe('staging — assertCachePoolFreeSpace stale-key eviction (28-09 R3)', () => {
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
