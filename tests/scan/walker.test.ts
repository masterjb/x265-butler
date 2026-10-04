import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 48-01: the walk-integrity assertions need the log lines. The walker is the
// only consumer of the logger in this module graph, so a module-level mock is
// safe for the pre-48-01 cases too (none of them assert on logs).
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('@/src/lib/logger', () => ({ logger: mockLogger }));

import { walkFiles, type WalkOptions, type WalkStats, type FileEntry } from '@/src/lib/scan/walker';
// 48-02 (AC-15): test seam for the ABSOLUTE prune list + the memoized
// kill-switch — both test-only, never called by production code.
import {
  __setPruneSystemPrefixesForTests,
  __resetSystemPruneMemoForTests,
} from '@/src/lib/fs/system-paths';

const ABOVE_MIN = 2 * 1024 * 1024; // 2 MiB
const BELOW_MIN = 100 * 1024; // 100 KiB

async function collect(root: string, opts: WalkOptions): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of walkFiles(root, opts)) {
    out.push(entry.path);
  }
  return out.sort();
}

// 48-01 (AC-3): the stats only exist on the `done: true` result, so the helper
// drives the iterator manually — `for await` discards the return value.
async function collectWithStats(
  root: string,
  opts: WalkOptions,
): Promise<{ entries: FileEntry[]; stats: WalkStats }> {
  const it = walkFiles(root, opts)[Symbol.asyncIterator]();
  const entries: FileEntry[] = [];
  for (;;) {
    const next = await it.next();
    if (next.done) return { entries, stats: next.value };
    entries.push(next.value);
  }
}

// 48-01 (audit-added S7): the walker calls fs.promises.stat at THREE sites —
// root, directory AND file (the file one supplies size + mtime). A blanket spy
// returning a fixed Stats object would kill the size/mtime filters and turn
// AC-1 green for the wrong reason. This wrapper DELEGATES to the real stat and
// overrides nothing but dev/ino, and only for the listed paths.
function spyStatWithInodeOverrides(overrides: Map<string, { dev: number; ino: number }>): void {
  const realStat = fs.promises.stat.bind(fs.promises);
  vi.spyOn(fs.promises, 'stat').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
    const st = (await (realStat as (...a: unknown[]) => Promise<fs.Stats>)(
      p,
      ...rest,
    )) as fs.Stats & { dev: number; ino: number };
    const ov = overrides.get(String(p));
    if (ov) {
      st.dev = ov.dev;
      st.ino = ov.ino;
    }
    return st;
  }) as unknown as typeof fs.promises.stat);
}

// 48-01: EACCES injection for the DIRECTORY stat site — deterministic and
// independent of the test user's uid (a chmod 000 fixture is a no-op as root).
function spyStatWithFailures(failing: Set<string>): void {
  const realStat = fs.promises.stat.bind(fs.promises);
  vi.spyOn(fs.promises, 'stat').mockImplementation((async (p: fs.PathLike, ...rest: unknown[]) => {
    if (failing.has(String(p))) {
      throw Object.assign(new Error(`EACCES: permission denied, stat '${String(p)}'`), {
        code: 'EACCES',
      });
    }
    return (realStat as (...a: unknown[]) => Promise<fs.Stats>)(p, ...rest);
  }) as unknown as typeof fs.promises.stat);
}

function spyReaddirWithFailures(failing: Set<string>): void {
  const realReaddir = fs.promises.readdir.bind(fs.promises);
  vi.spyOn(fs.promises, 'readdir').mockImplementation((async (
    p: fs.PathLike,
    ...rest: unknown[]
  ) => {
    if (failing.has(String(p))) {
      throw Object.assign(new Error(`EACCES: permission denied, scandir '${String(p)}'`), {
        code: 'EACCES',
      });
    }
    return (realReaddir as (...a: unknown[]) => Promise<fs.Dirent[]>)(p, ...rest);
  }) as unknown as typeof fs.promises.readdir);
}

function warnsMatching(msg: string): number {
  return mockLogger.warn.mock.calls.filter((c) => c[1] === msg).length;
}

function integrityLines(): { level: 'warn' | 'info'; payload: Record<string, unknown> }[] {
  const out: { level: 'warn' | 'info'; payload: Record<string, unknown> }[] = [];
  for (const c of mockLogger.warn.mock.calls) {
    const p = c[0] as Record<string, unknown> | undefined;
    if (p && p.action === 'scan_walk_integrity') out.push({ level: 'warn', payload: p });
  }
  for (const c of mockLogger.info.mock.calls) {
    const p = c[0] as Record<string, unknown> | undefined;
    if (p && p.action === 'scan_walk_integrity') out.push({ level: 'info', payload: p });
  }
  return out;
}

function writeSized(p: string, sizeBytes: number): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(sizeBytes));
}

describe('walkFiles', () => {
  let tmpdir: string;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-test-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    // 48-01: restore BEFORE the rmSync so a leaked fs spy cannot outlive the case.
    vi.restoreAllMocks();
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

  // ── 48-01: ancestor-chain dedup + WalkStats ────────────────────────────────

  it('test_walkFiles_when_sibling_branches_share_inode_then_yields_both', async () => {
    // AC-1: the shfs/FUSE collision — two SIBLING directories reporting the
    // identical dev:ino. The pre-48-01 global Set dropped the second subtree
    // entirely (reporter: 143 of 546 directories indexed).
    const dirA = path.join(tmpdir, 'a');
    const dirB = path.join(tmpdir, 'b');
    writeSized(path.join(dirA, 'movie-a.mp4'), ABOVE_MIN);
    writeSized(path.join(dirB, 'movie-b.mp4'), ABOVE_MIN);
    spyStatWithInodeOverrides(
      new Map([
        [dirA, { dev: 99, ino: 4242 }],
        [dirB, { dev: 99, ino: 4242 }],
      ]),
    );

    const { entries, stats } = await collectWithStats(tmpdir, {
      extensions: ['mp4'],
      minSizeMb: 1,
    });

    expect(entries.map((e) => e.path).sort()).toEqual([
      path.join(dirA, 'movie-a.mp4'),
      path.join(dirB, 'movie-b.mp4'),
    ]);
    expect(stats.dirsSkippedCycle).toBe(0);
    expect(stats.cycleSamples).toEqual([]);
    expect(
      warnsMatching('walker: directory inode already visited (bind-mount loop?), skipping'),
    ).toBe(0);
    // audit-added S7: proves the stat wrapper delegated instead of returning a
    // fixed Stats — otherwise size/mtime would be junk and AC-1 green for the
    // wrong reason.
    for (const e of entries) {
      expect(e.size).toBe(ABOVE_MIN);
      expect(e.mtime).toBeGreaterThan(0);
    }
  });

  it('test_walkFiles_when_inode_matches_real_ancestor_then_prunes_branch', async () => {
    // AC-2: a genuine cycle (bind-mount loop) still terminates the descent.
    const parent = path.join(tmpdir, 'parent');
    const child = path.join(parent, 'child');
    writeSized(path.join(parent, 'top.mp4'), ABOVE_MIN);
    writeSized(path.join(child, 'looped.mp4'), ABOVE_MIN);
    spyStatWithInodeOverrides(
      new Map([
        [parent, { dev: 7, ino: 1001 }],
        [child, { dev: 7, ino: 1001 }],
      ]),
    );

    const { entries, stats } = await collectWithStats(tmpdir, {
      extensions: ['mp4'],
      minSizeMb: 1,
    });

    expect(entries.map((e) => e.path)).toEqual([path.join(parent, 'top.mp4')]);
    expect(stats.dirsSkippedCycle).toBe(1);
    expect(stats.cycleSamples).toEqual([child]);
  });

  it('test_walkFiles_when_walk_completes_then_returns_walkstats', async () => {
    // AC-3: WalkStats arrives as the generator RETURN value; dirsVisited counts
    // the actually-read directories INCLUDING the root.
    writeSized(path.join(tmpdir, 'a.mp4'), ABOVE_MIN);
    writeSized(path.join(tmpdir, 'sub', 'b.mp4'), ABOVE_MIN);
    writeSized(path.join(tmpdir, 'sub', 'sub2', 'c.mp4'), ABOVE_MIN);

    const { entries, stats } = await collectWithStats(tmpdir, {
      extensions: ['mp4'],
      minSizeMb: 1,
    });

    expect(entries).toHaveLength(3);
    expect(stats).toEqual({
      dirsVisited: 3, // root + sub + sub2
      dirsSkippedCycle: 0,
      dirsSkippedUnreadable: 0,
      dirsSkippedMaxDepth: 0,
      dirsSkippedSystemPrefix: 0,
      cycleSamples: [],
      unreadableSamples: [],
      systemPrefixSamples: [],
    });
  });

  it('test_walkFiles_when_25_cycle_skips_then_caps_warns_at_20_but_not_counter', async () => {
    // AC-4 (cycle axis): 25 skips → 20 WARN lines, counter uncapped at 25.
    const colliding = new Map<string, { dev: number; ino: number }>();
    // Every subdir reports the ROOT's key → each is an ancestor hit.
    colliding.set(tmpdir, { dev: 42, ino: 777 });
    for (let i = 0; i < 25; i++) {
      const d = path.join(tmpdir, `c${String(i).padStart(2, '0')}`);
      writeSized(path.join(d, 'inside.mp4'), ABOVE_MIN);
      colliding.set(d, { dev: 42, ino: 777 });
    }
    writeSized(path.join(tmpdir, 'top.mp4'), ABOVE_MIN);
    spyStatWithInodeOverrides(colliding);

    const { entries, stats } = await collectWithStats(tmpdir, {
      extensions: ['mp4'],
      minSizeMb: 1,
    });

    expect(entries.map((e) => e.path)).toEqual([path.join(tmpdir, 'top.mp4')]);
    expect(stats.dirsSkippedCycle).toBe(25);
    expect(stats.cycleSamples).toHaveLength(20);
    expect(
      warnsMatching('walker: directory inode already visited (bind-mount loop?), skipping'),
    ).toBe(20);
  });

  it('test_walkFiles_when_25_unreadable_dirs_then_caps_warns_at_20_across_both_sites', async () => {
    // AC-4 (audit-added M2, unreadable axis): the cap is SHARED across the stat
    // and the readdir catch block — 13 + 12 failures must yield 20 WARN lines
    // total, not 20 per site.
    const statFail = new Set<string>();
    const readdirFail = new Set<string>();
    for (let i = 0; i < 13; i++) {
      const d = path.join(tmpdir, `s${String(i).padStart(2, '0')}`);
      fs.mkdirSync(d, { recursive: true });
      statFail.add(d);
    }
    for (let i = 0; i < 12; i++) {
      const d = path.join(tmpdir, `r${String(i).padStart(2, '0')}`);
      fs.mkdirSync(d, { recursive: true });
      readdirFail.add(d);
    }
    writeSized(path.join(tmpdir, 'visible.mp4'), ABOVE_MIN);
    spyStatWithFailures(statFail);
    spyReaddirWithFailures(readdirFail);

    const { entries, stats } = await collectWithStats(tmpdir, {
      extensions: ['mp4'],
      minSizeMb: 1,
    });

    expect(entries.map((e) => e.path)).toEqual([path.join(tmpdir, 'visible.mp4')]);
    expect(stats.dirsSkippedUnreadable).toBe(25);
    expect(stats.unreadableSamples).toHaveLength(20);
    const totalUnreadableWarns =
      warnsMatching('walker: stat failed on directory') +
      warnsMatching('walker: readdir failed, skipping directory');
    expect(totalUnreadableWarns).toBe(20);
  });

  it('test_walkFiles_when_walk_clean_then_emits_exactly_one_info_summary', async () => {
    // AC-5: exactly one summary line, INFO when nothing was skipped.
    writeSized(path.join(tmpdir, 'a.mp4'), ABOVE_MIN);

    const { stats } = await collectWithStats(tmpdir, { extensions: ['mp4'], minSizeMb: 1 });

    const lines = integrityLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('info');
    expect(lines[0].payload).toMatchObject({
      action: 'scan_walk_integrity',
      rootPath: tmpdir,
      dirsVisited: stats.dirsVisited,
      dirsSkippedCycle: 0,
      dirsSkippedUnreadable: 0,
      dirsSkippedMaxDepth: 0,
    });
    // The 22-01 → 38-02 dark-surface trap: a debug-level line never reaches the
    // ring-buffer, so the evidence would be invisible where it is needed.
    expect(mockLogger.debug).not.toHaveBeenCalled();
  });

  it('test_walkFiles_when_walk_has_skips_then_summary_is_warn', async () => {
    // AC-5: same single line, WARN level once a skip happened.
    const child = path.join(tmpdir, 'looper');
    writeSized(path.join(child, 'x.mp4'), ABOVE_MIN);
    spyStatWithInodeOverrides(
      new Map([
        [tmpdir, { dev: 5, ino: 500 }],
        [child, { dev: 5, ino: 500 }],
      ]),
    );

    await collectWithStats(tmpdir, { extensions: ['mp4'], minSizeMb: 1 });

    const lines = integrityLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('warn');
    expect(lines[0].payload).toMatchObject({ dirsSkippedCycle: 1 });
  });

  it('test_walkFiles_when_maxDepth_truncates_then_counts_refused_roots_only', async () => {
    // AC-6 + audit-added S6: the counter is the number of REFUSED entries (the
    // truncated roots), NOT the directories lost below them. Two levels sit
    // under the cut here, yet exactly ONE refusal is counted.
    writeSized(path.join(tmpdir, 'shallow.mp4'), ABOVE_MIN);
    const a = path.join(tmpdir, 'a');
    const b = path.join(a, 'b');
    const c = path.join(b, 'c');
    writeSized(path.join(a, 'a.mp4'), ABOVE_MIN);
    writeSized(path.join(b, 'b.mp4'), ABOVE_MIN);
    writeSized(path.join(c, 'c.mp4'), ABOVE_MIN);

    const { entries, stats } = await collectWithStats(tmpdir, {
      extensions: ['mp4'],
      minSizeMb: 1,
      maxDepth: 1,
    });

    // Yield behaviour unchanged vs pre-48-01 (regression pin alongside
    // test_walkFiles_when_depth_exceeds_maxDepth_then_does_not_recurse).
    expect(entries.map((e) => e.path).sort()).toEqual([
      path.join(a, 'a.mp4'),
      path.join(tmpdir, 'shallow.mp4'),
    ]);
    expect(stats.dirsSkippedMaxDepth).toBe(1); // `b` refused; `b` AND `c` lost
    expect(stats.dirsVisited).toBe(2); // root + a
  });
});

// ── 48-02 (Bundle B): runtime system-prefix prune ────────────────────────────
//
// The production prune list is ABSOLUTE ('/proc', '/sys', …) while a vitest
// fixture tree lives under os.tmpdir(), so NO fixture path could ever match it.
// `__setPruneSystemPrefixesForTests` (AC-15) is what makes AC-5/AC-6/AC-8
// executable instead of an argument that the code "obviously" does it.
describe('walkFiles — 48-02 system-prefix prune', () => {
  let tmpdir: string;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-prune-'));
    vi.clearAllMocks();
    delete process.env.SCAN_PRUNE_SYSTEM_PATHS;
    __resetSystemPruneMemoForTests();
    // Fixture mirrors the reporter's rootfs shape: system dirs next to media.
    __setPruneSystemPrefixesForTests([
      path.join(tmpdir, 'proc'),
      path.join(tmpdir, 'sys'),
      path.join(tmpdir, 'dev'),
      path.join(tmpdir, 'run'),
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __setPruneSystemPrefixesForTests(null);
    __resetSystemPruneMemoForTests();
    delete process.env.SCAN_PRUNE_SYSTEM_PATHS;
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  function buildRootfsFixture(): void {
    writeSized(path.join(tmpdir, 'proc', 'trap.mp4'), ABOVE_MIN);
    writeSized(path.join(tmpdir, 'sys', 'trap.mp4'), ABOVE_MIN);
    writeSized(path.join(tmpdir, 'dev', 'trap.mp4'), ABOVE_MIN);
    writeSized(path.join(tmpdir, 'run', 'trap.mp4'), ABOVE_MIN);
    writeSized(path.join(tmpdir, 'mnt', 'user', 'Media', 'movie.mp4'), ABOVE_MIN);
  }

  // AC-5 — the healing layer: it fires for a root of tmpdir (the '/' analogue)
  // regardless of what the operator configured.
  it('test_walkFiles_when_root_encloses_system_dirs_then_prunes_and_counts_them', async () => {
    buildRootfsFixture();
    const { entries, stats } = await collectWithStats(tmpdir, {
      extensions: ['mp4'],
      minSizeMb: 1,
    });

    expect(entries.map((e) => e.path)).toEqual([
      path.join(tmpdir, 'mnt', 'user', 'Media', 'movie.mp4'),
    ]);
    expect(stats.dirsSkippedSystemPrefix).toBe(4);
    expect(stats.systemPrefixSamples.sort()).toEqual(
      [
        path.join(tmpdir, 'dev'),
        path.join(tmpdir, 'proc'),
        path.join(tmpdir, 'run'),
        path.join(tmpdir, 'sys'),
      ].sort(),
    );
    // A directory under /mnt/user is still visited normally.
    expect(stats.dirsVisited).toBe(4); // root + mnt + mnt/user + mnt/user/Media
  });

  // AC-6 — a legacy share rooted UNDER a prune prefix must not vanish.
  it('test_walkFiles_when_root_is_under_prune_prefix_then_prune_disabled_with_one_warn', async () => {
    const usbRoot = path.join(tmpdir, 'run', 'media', 'usb1');
    writeSized(path.join(usbRoot, 'Movies', 'a.mp4'), ABOVE_MIN);

    const { entries, stats } = await collectWithStats(usbRoot, {
      extensions: ['mp4'],
      minSizeMb: 1,
    });

    expect(entries.map((e) => e.path)).toEqual([path.join(usbRoot, 'Movies', 'a.mp4')]);
    expect(stats.dirsSkippedSystemPrefix).toBe(0);
    expect(stats.systemPrefixSamples).toEqual([]);
    const rootWarns = mockLogger.warn.mock.calls
      .map((c) => c[0] as { action?: string; rootPath?: string })
      .filter((p) => p?.action === 'scan_root_under_system_prefix');
    expect(rootWarns).toHaveLength(1);
    expect(rootWarns[0].rootPath).toBe(usbRoot);
  });

  // AC-8 — kill-switch: traversal byte-identical to pre-48-02.
  it('test_walkFiles_when_kill_switch_zero_then_no_prune_and_no_counter', async () => {
    process.env.SCAN_PRUNE_SYSTEM_PATHS = '0';
    __resetSystemPruneMemoForTests();
    buildRootfsFixture();

    const { entries, stats } = await collectWithStats(tmpdir, {
      extensions: ['mp4'],
      minSizeMb: 1,
    });

    expect(entries.map((e) => e.path).sort()).toEqual(
      [
        path.join(tmpdir, 'dev', 'trap.mp4'),
        path.join(tmpdir, 'mnt', 'user', 'Media', 'movie.mp4'),
        path.join(tmpdir, 'proc', 'trap.mp4'),
        path.join(tmpdir, 'run', 'trap.mp4'),
        path.join(tmpdir, 'sys', 'trap.mp4'),
      ].sort(),
    );
    expect(stats.dirsSkippedSystemPrefix).toBe(0);
    expect(stats.systemPrefixSamples).toEqual([]);
    expect(
      mockLogger.warn.mock.calls.filter(
        (c) => (c[0] as { action?: string })?.action === 'scan_dir_system_prefix_pruned',
      ),
    ).toHaveLength(0);
  });

  // AC-18 — a DELIBERATE prune is not integrity loss: it must not flip the
  // 48-01 warn-vs-info signal, or every scan of a '/'-rooted install warns
  // forever and the reader learns to ignore the line.
  it('test_walkFiles_when_only_system_prunes_then_integrity_line_stays_info', async () => {
    buildRootfsFixture();
    await collectWithStats(tmpdir, { extensions: ['mp4'], minSizeMb: 1 });

    const lines = integrityLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('info');
    expect(lines[0].payload.dirsSkippedSystemPrefix).toBe(4);
    expect(lines[0].payload.dirsSkippedCycle).toBe(0);
    expect(lines[0].payload.dirsSkippedUnreadable).toBe(0);
  });

  it('test_walkFiles_when_prune_plus_one_cycle_skip_then_integrity_line_is_warn', async () => {
    buildRootfsFixture();
    const mediaDir = path.join(tmpdir, 'mnt', 'user', 'Media');
    // Make Media collide with the ROOT's inode → one ancestor-chain cycle skip.
    const rootStat = fs.statSync(tmpdir);
    spyStatWithInodeOverrides(new Map([[mediaDir, { dev: rootStat.dev, ino: rootStat.ino }]]));

    const { stats } = await collectWithStats(tmpdir, { extensions: ['mp4'], minSizeMb: 1 });
    expect(stats.dirsSkippedCycle).toBe(1);
    expect(stats.dirsSkippedSystemPrefix).toBe(4);

    const lines = integrityLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe('warn'); // exactly as before this plan
  });

  it('test_walkFiles_when_25_pruned_dirs_then_caps_warns_at_20_but_not_counter', async () => {
    const prefixes: string[] = [];
    for (let i = 0; i < 25; i++) {
      const d = path.join(tmpdir, `sysdir${i}`);
      writeSized(path.join(d, 'trap.mp4'), ABOVE_MIN);
      prefixes.push(d);
    }
    __setPruneSystemPrefixesForTests(prefixes);

    const { entries, stats } = await collectWithStats(tmpdir, {
      extensions: ['mp4'],
      minSizeMb: 1,
    });
    expect(entries).toHaveLength(0);
    expect(stats.dirsSkippedSystemPrefix).toBe(25); // counter UNCAPPED
    expect(stats.systemPrefixSamples).toHaveLength(20); // samples capped
    expect(warnsMatching('walker: system directory pruned (not a media path)')).toBe(20);
  });
});
