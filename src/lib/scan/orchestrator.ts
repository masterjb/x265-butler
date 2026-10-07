import fs from 'node:fs';
import { walkFiles, emptyWalkStats, toScanMtime, type FileEntry, type WalkStats } from './walker';
import { matchSidecar, toVerifyKeys, type SidecarVerifyKeys } from './sidecar-verify';
// Process-local last-scan integrity snapshot (diagnostics evidence).
import { recordScanIntegrity, type ScanIntegrityShareRow } from './scan-integrity-store';
import { hashFile } from './hash';
import { ffprobe } from './ffprobe';
import type { FileRepo } from '../db/repos/file';
import type { FileRow, FileStatus, FileUpsertInput, ScanResult } from '../db/schema';
import { logger } from '../logger';
import type { AppLogger } from '@/src/lib/logger';
// Skip pipeline + sidecar tmp orphan sweep at scan boot.
import { runSkipPipeline, type SkipDecision } from '../skip';
// selfHealSidecar, encoderNameFor, qualityModeFor, SidecarPayload, SidecarV1,
// SidecarV2 + defaultJobRepo removed — db-hash self-heal path gone with Step 4.
import {
  sweepSidecarTmpFiles,
  readSidecar,
  readSidecarResolved,
  DEFAULT_SIDECAR_CENTRAL_PATH,
  type SidecarMode,
  type SidecarPayload,
} from '../encode/sidecar';
// Blocklist repo + pattern cache for skip-pipeline step 2.
// Cache loaded ONCE per scan run before file-walk loop —
// transforms O(N*M) DB calls to O(N+M).
// shareRepo singleton for per-share dispatch loop.
import {
  blocklistRepo as defaultBlocklistRepo,
  shareRepo as defaultShareRepo,
  // Read sidecar_mode + sidecar_central_path to also sweep
  // the central tree (lives under /config, outside every scan root).
  settingRepo as defaultSettingRepo,
} from '../db';

// Bounded-window concurrency cap for the per-file hash+ffprobe I/O
// inside the walk and verify phases. Conservative for single-HDD unRAID arrays — too many
// parallel hash reads (each a 3×4 MiB sequential read) thrash a spinning disk
// and can make scans SLOWER, not faster (seek contention). A fixed const is
// chosen over a DB-backed operator setting to avoid a migration per the
// ZERO-migrations invariant.
//
// Env escape-hatch, migration-free (env, NOT DB), matching the
// project's kill-switch culture. Read ONCE at module load. `=1` collapses to
// pure-sequential (zero overlap, byte-identical to the old sequential path) — an operator
// whose spinning array thrashes under concurrent hash reads can revert WITHOUT a
// redeploy. NaN/0/negative → falls back to 4. Documented in the docs/dev/kill-switches.md backend
// kill-switch table (backend-only, restart required).
const SCAN_PROBE_CONCURRENCY = Math.max(1, Number(process.env.SCAN_PROBE_CONCURRENCY) || 4);

// Lets callers queue new work while the scan is still running without the
// scanner knowing about the queue. onPending receives each row this scan
// created or changed that is still `pending` after the skip decision and
// returns true when it queued it (counted in the summary). onBatchEnd follows
// every window that handed over at least one row. Throws are logged and
// ignored; without hooks runScan behaves exactly as before.
export type ScanHooks = {
  onPending?: (row: FileRow) => boolean | void;
  onBatchEnd?: () => void;
};

// Statuses that record a finished evaluation. A row in one of them keeps it
// when its content changes, because the upsert never resets a status.
const STORED_OUTCOME_STATUSES: ReadonlySet<FileStatus> = new Set<FileStatus>([
  'done-smaller',
  'done-larger',
  'done-not-worth',
  'done-already-evaluated',
  'skipped-codec',
  'skipped-bitrate',
  'skipped-suffix',
  'skipped-tag',
  'skipped-sidecar',
  'skipped-blocklist',
  'failed',
]);

export type ScanOptions = {
  rootPath: string;
  extensions: string[];
  minSizeMb: number;
  maxDepth?: number;
};

type PerShareCounters = {
  filesScanned: number;
  filesAdded: number;
  filesUpdated: number;
  filesUnchanged: number;
  filesFailed: number;
  // Walker WalkStats, per share. Directory axis — orthogonal to the
  // files* invariant. Only the four counters reach ScanResult; the samples stop
  // at the scan-integrity store (they are raw filesystem paths).
  dirsVisited: number;
  dirsSkippedCycle: number;
  dirsSkippedUnreadable: number;
  dirsSkippedMaxDepth: number;
  // Fifth directory-axis counter, threaded exactly like the other four.
  dirsSkippedSystemPrefix: number;
  cycleSamples: string[];
  unreadableSamples: string[];
  systemPrefixSamples: string[];
};

// Cap for the store-level sample lists concatenated across shares —
// same magnitude as the walker's per-walk WARN cap.
const SCAN_INTEGRITY_SAMPLE_CAP = 20;

// Per-share numbers for the scan_two_phase_summary line (no paths).
type TwoPhaseStats = {
  deferred: number;
  verifyMatched: number;
  verifyHashed: number;
  verifyGone: number;
  changedKeptOutcome: number;
  enqueuedDuringScan: number;
};

function zeroedTwoPhaseStats(): TwoPhaseStats {
  return {
    deferred: 0,
    verifyMatched: 0,
    verifyHashed: 0,
    verifyGone: 0,
    changedKeptOutcome: 0,
    enqueuedDuringScan: 0,
  };
}

function zeroedShareCounters(): PerShareCounters {
  return {
    filesScanned: 0,
    filesAdded: 0,
    filesUpdated: 0,
    filesUnchanged: 0,
    filesFailed: 0,
    ...emptyWalkStats(),
  };
}

// Bounded batched-window walk — hash + ffprobe parallelized across a
// capped window (SCAN_PROBE_CONCURRENCY) per file via Promise.allSettled,
// DB writes serial + walk-order.
// Counter invariant: filesAdded + filesUpdated + filesUnchanged + filesFailed === filesScanned.
//   - hash failure → filesFailed++, no upsert (existing row's last_scanned_at touched)
//   - ffprobe rejection or null → upsert with null metadata, filesAdded/Updated++
// Per-share dispatch when shareRepo.listAll() non-empty; falls back to opts when empty
// (tolerates empty shares, e.g. before the first share is configured).
export async function runScan(
  opts: ScanOptions,
  repo: FileRepo,
  // audit-fix:SR3 — default to module-level for non-route callers (tests).
  log: AppLogger = logger,
  hooks?: ScanHooks,
): Promise<ScanResult> {
  const startedMs = Date.now();
  const startedAt = Math.floor(startedMs / 1000);

  // Load pattern cache ONCE per scan run. Pure matchPathInList
  // helper consumes this in the skip-pipeline blocklist step — no per-file DB call. Defensive
  // try/catch — pattern-cache failure must NOT block the scan.
  // Cross-share, NOT per-share — load-once invariant preserved.
  let patternsCache: import('../db/schema').BlocklistRow[] = [];
  try {
    patternsCache = defaultBlocklistRepo().listAllPatterns();
  } catch (err) {
    logger.warn(
      {
        action: 'blocklist_pattern_cache_load_failed',
        err: err instanceof Error ? err.message : String(err),
      },
      'pattern cache load failed — skip-pipeline step 7 will fall back to per-file lookup',
    );
  }

  // Determine dispatch mode.
  const shares = defaultShareRepo().listAll();
  const isMultiShare = shares.length > 0;

  // tmp-file orphan sweep BEFORE walking the tree. Defends
  // against SIGKILL race during writeSidecar atomic step (process killed
  // between fs.writeFile and fs.rename leaves dangling .x265-butler.json.tmp).
  // Errors are warn-logged inside the helper but do NOT block the scan.
  // Per-share rootPath when multi-share; otherwise legacy opts.rootPath.
  if (isMultiShare) {
    for (const share of shares) {
      try {
        await sweepSidecarTmpFiles(share.path);
      } catch (err) {
        log.warn(
          {
            action: 'scan_sidecar_sweep_failed',
            shareId: share.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'sweep failed for share — continuing',
        );
      }
    }
  } else {
    await sweepSidecarTmpFiles(opts.rootPath);
  }

  // Resolve sidecar_mode + sidecar_central_path ONCE per
  // scan run — reused BOTH by the central tmp-sweep below AND threaded into every
  // runSkipPipeline call in the walk (so the swept tree and the read tree provably
  // agree, and no second settings.get fires per-file). Code-fallback defaults match
  // the write side (beside / DEFAULT_SIDECAR_CENTRAL_PATH). A settings-read
  // failure soft-degrades to beside (byte-identical to the beside read) — never blocks the scan.
  let sidecarMode: SidecarMode = 'beside';
  let sidecarCentralPath: string = DEFAULT_SIDECAR_CENTRAL_PATH;
  try {
    const settings = defaultSettingRepo();
    const rawMode = settings.get('sidecar_mode');
    sidecarMode = rawMode === 'off' || rawMode === 'central' ? rawMode : 'beside';
    sidecarCentralPath = settings.get('sidecar_central_path') ?? DEFAULT_SIDECAR_CENTRAL_PATH;
  } catch (err) {
    log.warn(
      {
        action: 'scan_sidecar_mode_resolve_failed',
        err: err instanceof Error ? err.message : String(err),
      },
      'sidecar_mode resolution failed — defaulting to beside (skip-pipeline reads beside)',
    );
  }

  // The central sidecar tree lives under sidecar_central_path
  // (default /config/x265-butler/sidecars/), OUTSIDE every scan root — a SIGKILL
  // mid-`central`-write orphans a `*.json.tmp` that the scan-root sweep above can
  // NEVER reach → permanent cumulative leak. When mode=central, ALSO sweep the
  // central root (best-effort, never blocks the scan), mirroring the scan-root envelope.
  // Reuse the single hoisted resolve above (no second settings.get).
  if (sidecarMode === 'central') {
    try {
      await sweepSidecarTmpFiles(sidecarCentralPath);
    } catch (err) {
      log.warn(
        {
          action: 'scan_sidecar_central_sweep_failed',
          err: err instanceof Error ? err.message : String(err),
        },
        'central-tree sidecar sweep failed — continuing',
      );
    }
  }

  // Two phases per scan so new work is not stuck behind files that were
  // already processed:
  //   walk phase   — every share is walked first. Unknown or changed files
  //                  WITHOUT a sidecar are hashed, probed, upserted, run through
  //                  the skip pipeline and handed to the enqueue hook window by
  //                  window. Files WITH a sidecar are only remembered.
  //   verify phase — after all shares were walked: each remembered file is
  //                  stat'ed again; size and mtime equal to a sidecar side mark
  //                  it skipped-sidecar without hashing, anything else takes the
  //                  same hash path as the walk phase.
  // better-sqlite3 is synchronous, so every repo.* call stays in the serial
  // parts; only hash/ffprobe/stat/sidecar reads run in the capped parallel
  // stages (≤ SCAN_PROBE_CONCURRENCY).

  type WorkItem = {
    entry: FileEntry;
    existing: ReturnType<FileRepo['findByPath']>;
    lastScannedAt: number;
    // Set when size and mtime matched a sidecar side: that side's hash stands in
    // for hashing the file.
    sidecarHash?: string;
  };

  type DeferredVerify = { path: string; keys: SidecarVerifyKeys };

  type ShareScan = {
    shareId: number | null;
    counters: PerShareCounters;
    deferred: DeferredVerify[];
    stats: TwoPhaseStats;
  };

  function readSidecarForScan(filePath: string): Promise<SidecarPayload | null> {
    const read =
      sidecarMode === 'central'
        ? readSidecarResolved(filePath, 'central', sidecarCentralPath)
        : readSidecar(filePath);
    // Both readers soft-degrade to null; a throw anyway means "no usable
    // sidecar", and the hash path then decides exactly as before.
    return read.catch(() => null);
  }

  function touchUnchanged(
    entry: FileEntry,
    existing: NonNullable<WorkItem['existing']>,
    lastScannedAt: number,
    shareId: number | null,
  ): void {
    repo.upsertByPath({
      path: entry.path,
      size_bytes: entry.size,
      mtime: entry.mtime,
      content_hash: existing.content_hash,
      codec: existing.codec,
      bitrate: existing.bitrate,
      duration_seconds: existing.duration_seconds,
      width: existing.width,
      height: existing.height,
      container: existing.container,
      last_scanned_at: lastScannedAt,
      share_id: shareId,
    });
  }

  function isUnchanged(
    existing: WorkItem['existing'],
    entry: FileEntry,
  ): existing is NonNullable<WorkItem['existing']> {
    return !!existing && existing.size_bytes === entry.size && existing.mtime === entry.mtime;
  }

  // Only rows this scan created or changed reach the hook. A pending backlog
  // the fast path merely touches stays with the capped end-of-scan / reconcile
  // sweeps, otherwise every scan would queue the whole backlog at once.
  function handOver(rows: FileRow[], scan: ShareScan): void {
    if (!hooks || rows.length === 0) return;
    for (const row of rows) {
      try {
        if (hooks.onPending?.(row) === true) scan.stats.enqueuedDuringScan++;
      } catch (err) {
        log.warn(
          {
            action: 'scan_enqueue_hook_failed',
            file_id: row.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'scan enqueue hook threw, file stays pending for the end-of-scan sweep',
        );
      }
    }
    try {
      hooks.onBatchEnd?.();
    } catch (err) {
      log.warn(
        {
          action: 'scan_enqueue_hook_failed',
          err: err instanceof Error ? err.message : String(err),
        },
        'scan enqueue batch-end hook threw, scan continues',
      );
    }
  }

  // Hash (or sidecar hash) + ffprobe in parallel, then upsert + skip decision
  // serially in input order. Counter moves: filesAdded/filesUpdated/filesFailed
  // only; filesScanned was counted once at walk time.
  async function processWork(items: WorkItem[], scan: ShareScan): Promise<void> {
    if (items.length === 0) return;
    const c = scan.counters;
    // Per-component independent failure handling: one
    // rejected hash/probe cannot poison the window (allSettled per item).
    const settled = await Promise.all(
      items.map((w) =>
        Promise.allSettled([
          w.sidecarHash !== undefined ? Promise.resolve(w.sidecarHash) : hashFile(w.entry.path),
          ffprobe(w.entry.path),
        ]),
      ),
    );

    const pending: FileRow[] = [];
    for (let i = 0; i < items.length; i++) {
      const { entry, existing, lastScannedAt, sidecarHash } = items[i];
      const [hashResult, probeResult] = settled[i];

      if (hashResult.status === 'rejected') {
        logger.warn(
          {
            err:
              hashResult.reason instanceof Error
                ? hashResult.reason.message
                : String(hashResult.reason),
            file: entry.path,
          },
          'orchestrator: hash failed, skipping upsert',
        );
        c.filesFailed++;
        // The existing row's last_scanned_at must not drift stale (it would end vanished).
        if (existing) {
          repo.touchLastScanned(existing.id, lastScannedAt);
        }
        continue;
      }

      let probe: Awaited<ReturnType<typeof ffprobe>> = null;
      if (probeResult.status === 'fulfilled') {
        probe = probeResult.value;
      } else {
        logger.warn(
          {
            err:
              probeResult.reason instanceof Error
                ? probeResult.reason.message
                : String(probeResult.reason),
            file: entry.path,
          },
          'orchestrator: ffprobe rejected, persisting hash with null metadata',
        );
      }

      const payload: FileUpsertInput = {
        path: entry.path,
        size_bytes: entry.size,
        mtime: entry.mtime,
        content_hash: hashResult.value,
        codec: probe?.codec ?? null,
        bitrate: probe?.bitrate ?? null,
        duration_seconds: probe?.durationSeconds ?? null,
        width: probe?.width ?? null,
        height: probe?.height ?? null,
        container: probe?.container ?? null,
        last_scanned_at: lastScannedAt,
        share_id: scan.shareId,
      };
      const upserted = repo.upsertByPath(payload);

      if (existing) c.filesUpdated++;
      else c.filesAdded++;

      // A size+mtime sidecar match is the sidecar step's own verdict, reached
      // without the hash; it does not depend on probe metadata.
      if (sidecarHash !== undefined) {
        scan.stats.verifyMatched++;
        applySkip(upserted, { skip: true, reason: 'skipped-sidecar', source: 'sidecar' }, true);
        continue;
      }

      // Skip pipeline runs only when probe succeeded (we need probe metadata).
      // The try/catch wrapper — pipeline failure must NEVER block the scan; on
      // throw, file row stays at upsert-default status (DB content_hash remains
      // authoritative on the next scan run).
      let decision: SkipDecision = { skip: false };
      if (probe) {
        try {
          decision = await runSkipPipeline(
            { filePath: entry.path, probe, diskContentHash: hashResult.value },
            {
              fileRepo: repo,
              // Pattern cache loaded once at scan boot above.
              blocklistRepo: defaultBlocklistRepo(),
              patternsCache,
              // Mode-aware Step-1 read (central → consult central sidecar
              // tree, beside fallback). Resolved ONCE per scan run above.
              sidecarMode,
              sidecarCentralPath,
            },
          );
        } catch (err) {
          logger.warn(
            {
              action: 'skip_pipeline_failed',
              filePath: entry.path,
              err: err instanceof Error ? err.stack : String(err),
            },
            'skip pipeline threw — falling through (DB content_hash authoritative on next scan)',
          );
        }
      }

      if (decision.skip) {
        applySkip(upserted, decision, false);
        continue;
      }

      if (upserted.status === 'pending') {
        pending.push(upserted);
      } else if (
        existing &&
        existing.content_hash !== hashResult.value &&
        STORED_OUTCOME_STATUSES.has(upserted.status)
      ) {
        // The row keeps its stored outcome although the content changed (the
        // upsert never resets a status). Counted so the summary shows it.
        scan.stats.changedKeptOutcome++;
      }
    }
    handOver(pending, scan);
  }

  function applySkip(
    upserted: FileRow,
    decision: Extract<SkipDecision, { skip: true }>,
    bySizeAndMtime: boolean,
  ): void {
    const updated = repo.setStatus(upserted.id, decision.reason, upserted.version);
    if (updated) {
      logger.info(
        {
          action: 'scan_file_skipped',
          file_id: upserted.id,
          reason: decision.reason,
          source: decision.source,
          ...(bySizeAndMtime ? { verifiedBy: 'size_mtime' } : {}),
        },
        'scan: file skipped by pipeline',
      );
    } else {
      // OCC stale — another writer raced. Continue to next file.
      logger.warn(
        {
          action: 'skip_setstatus_stale',
          file_id: upserted.id,
          reason: decision.reason,
        },
        'skip-pipeline setStatus failed OCC version check — continuing to next file',
      );
    }
  }

  // Walk phase. A throw from the walker's .next() (root-stat failure, see
  // walker.ts) MUST propagate unchanged so the caller zeroes the share; the
  // windowing must not swallow or defer it.
  async function walkShare(
    rootPath: string,
    filters: { extensions: string[]; minSizeMb: number; maxDepth?: number },
    shareId: number | null,
  ): Promise<ShareScan> {
    const scan: ShareScan = {
      shareId,
      counters: zeroedShareCounters(),
      deferred: [],
      stats: zeroedTwoPhaseStats(),
    };
    const c = scan.counters;
    const walkIterator = walkFiles(rootPath, {
      extensions: filters.extensions,
      minSizeMb: filters.minSizeMb,
      maxDepth: filters.maxDepth,
    })[Symbol.asyncIterator]();

    // The walker hands its directory-integrity counters back as the
    // generator's RETURN value (`next.value` on the `done: true` result).
    let walkStats: WalkStats | undefined;

    for (;;) {
      // 1. Drain up to SCAN_PROBE_CONCURRENCY entries. filesScanned is counted
      //    EXACTLY ONCE per entry here, so the invariant
      //    filesAdded+filesUpdated+filesUnchanged+filesFailed === filesScanned
      //    holds by construction across both phases.
      const window: FileEntry[] = [];
      while (window.length < SCAN_PROBE_CONCURRENCY) {
        const next = await walkIterator.next();
        if (next.done) {
          // Capture ONCE: re-entering the drain calls .next() on the exhausted
          // generator, which yields `{value: undefined, done: true}`. The `??`
          // covers a mocked walker whose generator returns nothing.
          if (walkStats === undefined) walkStats = next.value ?? emptyWalkStats();
          break;
        }
        c.filesScanned++;
        window.push(next.value);
      }
      if (window.length === 0) break;

      // 2. SERIAL pre-pass: unchanged known rows take the fast path (only
      //    last_scanned_at is touched) and never reach any file I/O.
      const candidates: WorkItem[] = [];
      for (const entry of window) {
        const lastScannedAt = Math.floor(Date.now() / 1000);
        const existing = repo.findByPath(entry.path);
        if (isUnchanged(existing, entry)) {
          touchUnchanged(entry, existing, lastScannedAt, shareId);
          c.filesUnchanged++;
          continue;
        }
        candidates.push({ entry, existing, lastScannedAt });
      }

      // 3. Sidecar lookup (I/O only): files with one wait for the verify phase.
      const sidecars = await Promise.all(candidates.map((w) => readSidecarForScan(w.entry.path)));
      const work: WorkItem[] = [];
      candidates.forEach((w, i) => {
        const sidecar = sidecars[i];
        if (sidecar) scan.deferred.push({ path: w.entry.path, keys: toVerifyKeys(sidecar) });
        else work.push(w);
      });

      await processWork(work, scan);
    }

    const ws = walkStats ?? emptyWalkStats();
    c.dirsVisited = ws.dirsVisited;
    c.dirsSkippedCycle = ws.dirsSkippedCycle;
    c.dirsSkippedUnreadable = ws.dirsSkippedUnreadable;
    c.dirsSkippedMaxDepth = ws.dirsSkippedMaxDepth;
    c.dirsSkippedSystemPrefix = ws.dirsSkippedSystemPrefix;
    c.cycleSamples = ws.cycleSamples;
    c.unreadableSamples = ws.unreadableSamples;
    c.systemPrefixSamples = ws.systemPrefixSamples;
    scan.stats.deferred = scan.deferred.length;
    return scan;
  }

  // Verify phase. Hours can pass between walk and verify, so every file is
  // stat'ed and looked up again; failures are per file and never throw.
  async function verifyShare(scan: ShareScan): Promise<void> {
    const c = scan.counters;
    for (let start = 0; start < scan.deferred.length; start += SCAN_PROBE_CONCURRENCY) {
      const window = scan.deferred.slice(start, start + SCAN_PROBE_CONCURRENCY);
      const stats = await Promise.allSettled(window.map((d) => fs.promises.stat(d.path)));
      const work: WorkItem[] = [];
      window.forEach((d, i) => {
        const lastScannedAt = Math.floor(Date.now() / 1000);
        const existing = repo.findByPath(d.path);
        const st = stats[i];
        if (st.status === 'rejected' || !st.value.isFile()) {
          c.filesFailed++;
          scan.stats.verifyGone++;
          // A file that is gone is left untouched and ends `vanished`; one that
          // only failed to stat (EACCES, I/O) must not be marked vanished.
          const code = st.status === 'rejected' ? (st.reason as NodeJS.ErrnoException)?.code : null;
          if (existing && code !== 'ENOENT') repo.touchLastScanned(existing.id, lastScannedAt);
          return;
        }
        const entry: FileEntry = {
          path: d.path,
          size: st.value.size,
          mtime: toScanMtime(st.value),
        };
        if (isUnchanged(existing, entry)) {
          touchUnchanged(entry, existing, lastScannedAt, scan.shareId);
          c.filesUnchanged++;
          return;
        }
        const sidecarHash = matchSidecar(d.keys, entry);
        if (sidecarHash === null) scan.stats.verifyHashed++;
        work.push({ entry, existing, lastScannedAt, sidecarHash: sidecarHash ?? undefined });
      });
      await processWork(work, scan);
    }
    // Release the list; a large first scan can hold many entries.
    scan.deferred = [];
  }

  function logTwoPhaseSummary(scan: ShareScan): void {
    log.info(
      { action: 'scan_two_phase_summary', shareId: scan.shareId, ...scan.stats },
      'scan phases complete for share',
    );
  }

  // Top-level aggregation. Sequential dispatch preserves single-flight
  // + lock semantics (acquireScanLock in /api/scan route) and avoids
  // interleaved log lines / FK-races inside the same DB transaction window.
  let filesScanned = 0;
  let filesAdded = 0;
  let filesUpdated = 0;
  let filesUnchanged = 0;
  let filesFailed = 0;
  let byShare: NonNullable<ScanResult['byShare']> | undefined;

  // Directory-axis aggregation. The four counters travel on into
  // ScanResult; samples, the failed-flag and sharesFailed stop at the store.
  let dirsVisited = 0;
  let dirsSkippedCycle = 0;
  let dirsSkippedUnreadable = 0;
  let dirsSkippedMaxDepth = 0;
  let dirsSkippedSystemPrefix = 0;
  const cycleSamples: string[] = [];
  const unreadableSamples: string[] = [];
  const systemPrefixSamples: string[] = [];
  let sharesFailed = 0;
  const integrityShares: ScanIntegrityShareRow[] = [];

  function absorbWalkStats(c: PerShareCounters): void {
    dirsVisited += c.dirsVisited;
    dirsSkippedCycle += c.dirsSkippedCycle;
    dirsSkippedUnreadable += c.dirsSkippedUnreadable;
    dirsSkippedMaxDepth += c.dirsSkippedMaxDepth;
    dirsSkippedSystemPrefix += c.dirsSkippedSystemPrefix;
    for (const s of c.cycleSamples) {
      if (cycleSamples.length < SCAN_INTEGRITY_SAMPLE_CAP) cycleSamples.push(s);
    }
    for (const s of c.unreadableSamples) {
      if (unreadableSamples.length < SCAN_INTEGRITY_SAMPLE_CAP) unreadableSamples.push(s);
    }
    for (const s of c.systemPrefixSamples) {
      if (systemPrefixSamples.length < SCAN_INTEGRITY_SAMPLE_CAP) systemPrefixSamples.push(s);
    }
  }

  if (isMultiShare) {
    byShare = [];
    // Walk phase for EVERY share before any verify phase, otherwise new files
    // in the second share would wait for the first share's verify.
    type ShareRun = { share: (typeof shares)[number]; scan: ShareScan | null };
    const runs: ShareRun[] = [];
    for (const share of shares) {
      const exts = share.extensions_csv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      try {
        const scan = await walkShare(
          share.path,
          {
            extensions: exts,
            minSizeMb: share.min_size_mb,
            maxDepth: share.max_depth ?? undefined,
          },
          share.id,
        );
        runs.push({ share, scan });
      } catch (err) {
        // One share's failure must NOT block the others.
        // Push zeroed entry so byShare.length === shares.length (caller can detect
        // failure via per-share log + counter-zero signature). Top-level totals
        // reflect survivors only.
        log.warn(
          {
            action: 'scan_share_failed',
            shareId: share.id,
            shareName: share.name,
            rootPath: share.path,
            err: err instanceof Error ? err.message : String(err),
          },
          'share scan threw — continuing to next share',
        );
        runs.push({ share, scan: null });
      }
    }
    for (const run of runs) {
      if (!run.scan) continue;
      try {
        await verifyShare(run.scan);
      } catch (err) {
        // Per-file failures never throw; this is a repo/DB failure. Same
        // treatment as a failed walk: the share is reported zeroed.
        log.warn(
          {
            action: 'scan_share_verify_failed',
            shareId: run.share.id,
            shareName: run.share.name,
            err: err instanceof Error ? err.message : String(err),
          },
          'share verify threw — continuing to next share',
        );
        run.scan = null;
      }
    }
    for (const { share, scan } of runs) {
      // A share that walked 10.000 directories and only THEN threw would
      // otherwise be indistinguishable from an empty share.
      const shareFailed = scan === null;
      if (shareFailed) sharesFailed++;
      else logTwoPhaseSummary(scan);
      const subResult = scan?.counters ?? zeroedShareCounters();
      byShare.push({
        shareId: share.id,
        name: share.name,
        rootPath: share.path,
        filesScanned: subResult.filesScanned,
        filesAdded: subResult.filesAdded,
        filesUpdated: subResult.filesUpdated,
        filesUnchanged: subResult.filesUnchanged,
        filesFailed: subResult.filesFailed,
        dirsVisited: subResult.dirsVisited,
        dirsSkippedCycle: subResult.dirsSkippedCycle,
        dirsSkippedUnreadable: subResult.dirsSkippedUnreadable,
        dirsSkippedMaxDepth: subResult.dirsSkippedMaxDepth,
        dirsSkippedSystemPrefix: subResult.dirsSkippedSystemPrefix,
      });
      integrityShares.push({
        shareId: share.id,
        name: share.name,
        rootPath: share.path,
        failed: shareFailed,
        dirsVisited: subResult.dirsVisited,
        dirsSkippedCycle: subResult.dirsSkippedCycle,
        dirsSkippedUnreadable: subResult.dirsSkippedUnreadable,
        dirsSkippedMaxDepth: subResult.dirsSkippedMaxDepth,
        dirsSkippedSystemPrefix: subResult.dirsSkippedSystemPrefix,
      });
      absorbWalkStats(subResult);
      filesScanned += subResult.filesScanned;
      filesAdded += subResult.filesAdded;
      filesUpdated += subResult.filesUpdated;
      filesUnchanged += subResult.filesUnchanged;
      filesFailed += subResult.filesFailed;
    }
    log.info(
      {
        action: 'scan_complete_multi_share',
        shareCount: byShare.length,
        byShareSummary: byShare.map((s) => ({
          id: s.shareId,
          name: s.name,
          scanned: s.filesScanned,
        })),
      },
      'multi-share scan complete',
    );
  } else {
    log.info(
      { action: 'scan_empty_shares_fallback', rootPath: opts.rootPath },
      'shares-table empty — falling back to opts.rootPath',
    );
    // This path has NO per-share catch — a
    // walker root-stat failure propagates straight out of runScan, and
    // reconcile.ts SWALLOWS it (`auto_scan_reconcile_run_scan_failed`,
    // then return). Without the failure snapshot below, /api/diagnostics would
    // keep showing the last SUCCESSFUL scan's numbers as if they were current —
    // an operator reads "546 directories, 0 skips" while no scan has completed
    // for days. Same silent loss, one level up. The throw is re-raised
    // unchanged: caller behaviour is byte-identical to pre-48-01.
    let subResult: PerShareCounters;
    try {
      const scan = await walkShare(
        opts.rootPath,
        { extensions: opts.extensions, minSizeMb: opts.minSizeMb, maxDepth: opts.maxDepth },
        null,
      );
      await verifyShare(scan);
      logTwoPhaseSummary(scan);
      subResult = scan.counters;
    } catch (err) {
      recordScanIntegrity({
        startedAtIso: new Date(startedMs).toISOString(),
        finishedAtIso: new Date().toISOString(),
        outcome: 'failed',
        rootPath: opts.rootPath,
        dirsVisited: 0,
        dirsSkippedCycle: 0,
        dirsSkippedUnreadable: 0,
        dirsSkippedMaxDepth: 0,
        dirsSkippedSystemPrefix: 0,
        cycleSamples: [],
        unreadableSamples: [],
        systemPrefixSamples: [],
        sharesFailed: 1,
        byShare: [],
      });
      throw err;
    }
    filesScanned = subResult.filesScanned;
    filesAdded = subResult.filesAdded;
    filesUpdated = subResult.filesUpdated;
    filesUnchanged = subResult.filesUnchanged;
    filesFailed = subResult.filesFailed;
    absorbWalkStats(subResult);
    integrityShares.push({
      shareId: null,
      name: '(fallback)',
      rootPath: opts.rootPath,
      failed: false,
      dirsVisited: subResult.dirsVisited,
      dirsSkippedCycle: subResult.dirsSkippedCycle,
      dirsSkippedUnreadable: subResult.dirsSkippedUnreadable,
      dirsSkippedMaxDepth: subResult.dirsSkippedMaxDepth,
      dirsSkippedSystemPrefix: subResult.dirsSkippedSystemPrefix,
    });
  }

  // 05-bonus: bulk-mark previously-known rows that were NOT touched by this
  // scan as 'vanished'. Operator-controlled states preserved (encoding,
  // queued, blocklisted) so an in-flight encode is not silently invalidated
  // by a failing scan probe. last_scanned_at < startedAt is the canonical
  // "not seen this run" predicate — touchLastScanned + upsertByPath both
  // bump it to the current scan's lastScannedAt.
  // SINGLE call at scan-end (NOT per-share) — global predicate
  // captures rows untouched by ANY share-iteration.
  const filesVanished = repo.markVanishedNotIn(startedAt, ['encoding', 'queued', 'blocklisted']);
  if (filesVanished > 0) {
    logger.info(
      { action: 'scan_files_vanished', count: filesVanished, startedAt },
      'scan: marked rows as vanished — paths absent from disk this run',
    );
  }

  const finishedMs = Date.now();
  const finishedAt = Math.floor(finishedMs / 1000);

  // ONE store write per completed scan, AFTER the vanished-marking so the
  // snapshot describes a fully finished run. The failure counterpart sits in the
  // single-share catch above.
  recordScanIntegrity({
    startedAtIso: new Date(startedMs).toISOString(),
    finishedAtIso: new Date(finishedMs).toISOString(),
    outcome: 'complete',
    // audit-added M4: opts.rootPath is pro-forma in the multi-share case
    // (reconcile.ts passes shares[0].path); reporting it top-level would claim
    // the whole scan ran under that one root. The real roots are in byShare.
    rootPath: isMultiShare ? null : opts.rootPath,
    dirsVisited,
    dirsSkippedCycle,
    dirsSkippedUnreadable,
    dirsSkippedMaxDepth,
    dirsSkippedSystemPrefix,
    cycleSamples,
    unreadableSamples,
    systemPrefixSamples,
    sharesFailed,
    byShare: integrityShares,
  });

  return {
    rootPath: opts.rootPath,
    filesScanned,
    filesAdded,
    filesUpdated,
    filesUnchanged,
    filesFailed,
    filesVanished,
    dirsVisited,
    dirsSkippedCycle,
    dirsSkippedUnreadable,
    dirsSkippedMaxDepth,
    dirsSkippedSystemPrefix,
    ...(byShare !== undefined ? { byShare } : {}),
    durationMs: finishedMs - startedMs,
    startedAt,
    finishedAt,
  };
}
