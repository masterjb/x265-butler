import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';
import { isSystemPruneEnabled, isUnderPruneSystemPrefix } from '../fs/system-paths';

export type FileEntry = {
  path: string;
  size: number;
  mtime: number;
};

export type WalkOptions = {
  extensions: string[];
  minSizeMb: number;
  maxDepth?: number;
};

// 48-01: directory-axis integrity counters, returned as the generator's RETURN
// value (D1=A). File-level failures are NOT tracked here — they run over
// `filesFailed` in the orchestrator; mixing both axes into one counter would
// make the number unreadable on the diagnostics surface.
export type WalkStats = {
  dirsVisited: number;
  dirsSkippedCycle: number;
  dirsSkippedUnreadable: number; // stat- OR readdir-error on a DIRECTORY
  dirsSkippedMaxDepth: number; // was SILENT before 48-01
  // 48-02 (Bundle B): directories refused because they sit at or under a
  // PRUNE_SYSTEM_PREFIXES entry. DELIBERATE prune, not integrity loss — it is
  // therefore kept OUT of the warn-vs-info `skipped` boolean below (AC-18).
  dirsSkippedSystemPrefix: number;
  cycleSamples: string[]; // first ≤ CYCLE_WARN_CAP pruned paths
  unreadableSamples: string[]; // first ≤ UNREADABLE_WARN_CAP EACCES paths
  systemPrefixSamples: string[]; // first ≤ SYSTEM_PREFIX_WARN_CAP pruned paths
};

const DEFAULT_MAX_DEPTH = 12;

// 48-01 (D3=B): per-skip WARN lines are capped; the COUNTERS stay uncapped.
// A `/sys`-style EACCES tree or a wide FUSE-collision fan-out would otherwise
// flush the 1000-line ring-buffer — i.e. exactly the evidence this plan adds.
const CYCLE_WARN_CAP = 20;
const UNREADABLE_WARN_CAP = 20;
const SYSTEM_PREFIX_WARN_CAP = 20;

function normalizeExtensions(extensions: string[]): Set<string> {
  return new Set(
    extensions.map((e) => e.toLowerCase().replace(/^\./, '')).filter((e) => e.length > 0),
  );
}

// 48-01: exported so the orchestrator can defensively fill in for a mocked
// walker whose generator returns `undefined` instead of WalkStats.
export function emptyWalkStats(): WalkStats {
  return {
    dirsVisited: 0,
    dirsSkippedCycle: 0,
    dirsSkippedUnreadable: 0,
    dirsSkippedMaxDepth: 0,
    dirsSkippedSystemPrefix: 0,
    cycleSamples: [],
    unreadableSamples: [],
    systemPrefixSamples: [],
  };
}

export async function* walkFiles(
  root: string,
  opts: WalkOptions,
): AsyncGenerator<FileEntry, WalkStats> {
  if (!path.isAbsolute(root)) {
    throw new Error(`walkFiles: root must be absolute, got: ${root}`);
  }
  let rootStat: fs.Stats;
  try {
    rootStat = await fs.promises.stat(root);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`walkFiles: root not accessible: ${root} (${cause})`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`walkFiles: root is not a directory: ${root}`);
  }

  const minBytes = opts.minSizeMb * 1024 * 1024;
  const allowedExts = normalizeExtensions(opts.extensions);
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;

  // 48-01 (replaces the pre-48-01 GLOBAL visited-inode Set):
  // cycle protection is now an ANCESTOR-CHAIN test — the procedure GNU `find`
  // uses. Only the `dev:ino` keys of the directories on the CURRENT descent path
  // are considered, so two sibling branches that happen to share a key no longer
  // prune each other.
  //
  // Why the global Set was wrong on unRAID: `/mnt/user` is ONE FUSE (shfs) mount
  // ⇒ ONE `st_dev` for the whole tree, while the N array disks behind it each own
  // an independent inode namespace whose numbers shfs passes through verbatim.
  // `dev:ino` is therefore NOT unique on `/mnt/user`, and the second hit dropped
  // the COMPLETE subtree (reporter: 143 of 546 directories indexed).
  //
  // Termination does NOT depend on this check: DEFAULT_MAX_DEPTH caps the
  // recursion hard and symlinks are skipped outright (see the loop below). The
  // inode test is work-saving + bind-mount hygiene, never the loop guard —
  // which is why the weaker ancestor-only test is safe.
  //
  // Residual risk (≠ 0, but tiny): a child whose inode number coincidentally
  // equals that of a REAL ancestor is still dropped. `dirsSkippedCycle` +
  // `cycleSamples` exist precisely so that case is detectable instead of silent.
  const stats = emptyWalkStats();

  // 48-02 (Bundle B, AC-5/AC-6/AC-8): resolve the prune predicate ONCE, before
  // the first walkDir call — NEVER per directory (that would re-read env on
  // every recursion). Three states:
  //   kill-switch off        → never prune (byte-identical to pre-48-02)
  //   root under a prefix    → never prune + ONE warn (a legacy share rooted at
  //                            e.g. /run/media/usb1 must not vanish entirely)
  //   otherwise              → prune
  // '/' is NOT itself a prune prefix, so a '/'-rooted share can never buy the
  // exemption — which is what makes the healing behaviour of AC-5 hold for the
  // reporter's already-broken install.
  let shouldPrune: (p: string) => boolean = () => false;
  if (isSystemPruneEnabled()) {
    if (isUnderPruneSystemPrefix(root)) {
      logger.warn(
        { action: 'scan_root_under_system_prefix', rootPath: root },
        'walker: scan root lies under a system prefix — system-prefix prune DISABLED for this walk',
      );
    } else {
      shouldPrune = isUnderPruneSystemPrefix;
    }
  }

  yield* walkDir(root, 0, allowedExts, minBytes, maxDepth, new Set<string>(), stats, shouldPrune);

  // AC-5: EXACTLY ONE summary line per exhausted walk. Deliberately NOT in a
  // `finally` — a consumer that `break`s early (estimate-engine) would otherwise
  // emit a misleading partial statistic. NOT at debug level: `debug` (20) does
  // not reach the ring-buffer, so the line would be lost to the copy-report
  // (the 22-01 → 38-02 dark-surface trap); `telemetry` (25) is the lowest level
  // that does reach it — tier table in src/lib/logger.ts.
  // 48-02 (audit-fix S5 / AC-18): dirsSkippedSystemPrefix is deliberately NOT
  // part of `skipped`. `skipped` exists to flag UNINTENDED loss (48-01); a
  // system-prefix prune is intentional and happens on EVERY scan of a
  // `/`-rooted install. Folding the two together would make that case
  // permanently WARN and retrain the reader to ignore the 48-01 signal.
  const skipped = stats.dirsSkippedCycle > 0 || stats.dirsSkippedUnreadable > 0;
  const summary = {
    action: 'scan_walk_integrity',
    rootPath: root,
    dirsVisited: stats.dirsVisited,
    dirsSkippedCycle: stats.dirsSkippedCycle,
    dirsSkippedUnreadable: stats.dirsSkippedUnreadable,
    dirsSkippedMaxDepth: stats.dirsSkippedMaxDepth,
    dirsSkippedSystemPrefix: stats.dirsSkippedSystemPrefix,
  };
  if (skipped) {
    logger.warn(summary, 'walker: walk complete with skipped directories');
  } else {
    logger.info(summary, 'walker: walk complete');
  }

  return stats;
}

async function* walkDir(
  dir: string,
  depth: number,
  allowedExts: Set<string>,
  minBytes: number,
  maxDepth: number,
  // 48-01: `dev:ino` of the directories on the CURRENT descent path only.
  ancestorInodes: ReadonlySet<string>,
  // 48-01: mutable accumulator. Deliberately a SEPARATE parameter from
  // ancestorInodes — the two have opposite lifetimes (one is per-branch and
  // copied, the other is walk-global and shared).
  stats: WalkStats,
  // 48-02: resolved ONCE in walkFiles and handed down — never re-derived here.
  shouldPrune: (p: string) => boolean,
): AsyncGenerator<FileEntry> {
  if (depth > maxDepth) {
    // audit-added S6: counts the REFUSED walkDir entries, i.e. the truncated
    // ROOTS — NOT the number of directories lost underneath them (the walk
    // never looks inside, so it cannot know). `dirsSkippedMaxDepth: 3` may hide
    // 3000 directories; the copy-report wording must not imply otherwise.
    stats.dirsSkippedMaxDepth++;
    return;
  }

  let dirStat: fs.Stats;
  try {
    dirStat = await fs.promises.stat(dir);
  } catch (err) {
    stats.dirsSkippedUnreadable++;
    if (stats.unreadableSamples.length < UNREADABLE_WARN_CAP) {
      stats.unreadableSamples.push(dir);
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), dir },
        'walker: stat failed on directory',
      );
    }
    return;
  }
  const inodeKey = `${dirStat.dev}:${dirStat.ino}`;
  if (ancestorInodes.has(inodeKey)) {
    stats.dirsSkippedCycle++;
    if (stats.cycleSamples.length < CYCLE_WARN_CAP) {
      stats.cycleSamples.push(dir);
      logger.warn(
        { dir, inodeKey },
        'walker: directory inode already visited (bind-mount loop?), skipping',
      );
    }
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    stats.dirsSkippedUnreadable++;
    // audit-added M2: the cap is shared across BOTH unreadable call sites
    // (gate on unreadableSamples.length, not one counter per catch block).
    if (stats.unreadableSamples.length < UNREADABLE_WARN_CAP) {
      stats.unreadableSamples.push(dir);
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), dir },
        'walker: readdir failed, skipping directory',
      );
    }
    return;
  }
  stats.dirsVisited++;

  // 48-01: extend the ancestor chain ONCE per directory (not per child) and hand
  // the copy down. No add-before/delete-after backtracking on a shared Set: this
  // is an async generator a consumer can abandon at any yield via `.return()`,
  // where a `finally`-delete would be correct but subtle. The copy is bounded by
  // maxDepth (12) entries.
  const nextAncestors = new Set(ancestorInodes);
  nextAncestors.add(inodeKey);

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // 48-02 (Bundle B, AC-5): test the CHILD before recursing — the cheap
      // place. This is the layer that heals an ALREADY-broken install: it fires
      // regardless of what root the operator configured, so a share pointing at
      // '/' no longer descends /proc, /sys, /dev or /run.
      if (shouldPrune(fullPath)) {
        stats.dirsSkippedSystemPrefix++;
        if (stats.systemPrefixSamples.length < SYSTEM_PREFIX_WARN_CAP) {
          stats.systemPrefixSamples.push(fullPath);
          logger.warn(
            { action: 'scan_dir_system_prefix_pruned', dir: fullPath },
            'walker: system directory pruned (not a media path)',
          );
        }
        continue;
      }
      yield* walkDir(
        fullPath,
        depth + 1,
        allowedExts,
        minBytes,
        maxDepth,
        nextAncestors,
        stats,
        shouldPrune,
      );
      continue;
    }

    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase().replace(/^\./, '');
    if (!allowedExts.has(ext)) continue;

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(fullPath);
    } catch (err) {
      // 48-01: deliberately UNCOUNTED + UNCAPPED — WalkStats is the DIRECTORY
      // axis; file-level failures run over `filesFailed` in the orchestrator.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), file: fullPath },
        'walker: stat failed on file, skipping',
      );
      continue;
    }

    if (stat.size < minBytes) continue;

    yield {
      path: fullPath,
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs / 1000),
    };
  }
}
