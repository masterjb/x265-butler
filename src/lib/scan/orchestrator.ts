import { walkFiles } from './walker';
import { hashFile } from './hash';
import { ffprobe } from './ffprobe';
import type { FileRepo } from '../db/repos/file';
import type { FileUpsertInput, ScanResult } from '../db/schema';
import { logger } from '../logger';
import type pino from 'pino';
// 04-01 additive: skip pipeline + sidecar tmp orphan sweep at scan boot.
import { runSkipPipeline, type SkipDecision } from '../skip';
// 10-01: selfHealSidecar, encoderNameFor, qualityModeFor, SidecarPayload, SidecarV1,
// SidecarV2 + defaultJobRepo removed — db-hash self-heal path gone with Step 4.
import { sweepSidecarTmpFiles } from '../encode/sidecar';
// 04-02 additive: blocklist repo + pattern cache for skip-pipeline step 2.
// Audit M2: cache loaded ONCE per scan run before file-walk loop —
// transforms O(N*M) DB calls to O(N+M).
// 14-02: shareRepo singleton for per-share dispatch loop.
import { blocklistRepo as defaultBlocklistRepo, shareRepo as defaultShareRepo } from '../db';

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
};

// Sequential walk: hash + ffprobe per file via Promise.allSettled (audit S5).
// Counter invariant: filesAdded + filesUpdated + filesUnchanged + filesFailed === filesScanned.
//   - hash failure → filesFailed++, no upsert (existing row's last_scanned_at touched per M6)
//   - ffprobe rejection or null → upsert with null metadata, filesAdded/Updated++
// 14-02: per-share dispatch when shareRepo.listAll() non-empty; falls back to opts when empty
// (Q4 CONTEXT.md decision — tolerate empty shares for 14-01..14-04 transition window).
export async function runScan(
  opts: ScanOptions,
  repo: FileRepo,
  // audit-fix:SR3 — default to module-level for non-route callers (tests).
  log: pino.Logger = logger,
): Promise<ScanResult> {
  const startedMs = Date.now();
  const startedAt = Math.floor(startedMs / 1000);

  // 04-02 audit M2: load pattern cache ONCE per scan run. Pure matchPathInList
  // helper consumes this in skip-pipeline step 7 — no per-file DB call. Defensive
  // try/catch — pattern-cache failure must NOT block the scan.
  // 14-02 AC-8: cross-share, NOT per-share — load-once invariant preserved.
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

  // 14-02: determine dispatch mode.
  const shares = defaultShareRepo().listAll();
  const isMultiShare = shares.length > 0;

  // 04-01 audit M5: tmp-file orphan sweep BEFORE walking the tree. Defends
  // against SIGKILL race during writeSidecar atomic step (process killed
  // between fs.writeFile and fs.rename leaves dangling .x265-butler.json.tmp).
  // Errors are warn-logged inside the helper but do NOT block the scan.
  // 14-02 AC-7: per-share rootPath when multi-share; otherwise legacy opts.rootPath.
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

  // Extracted per-share file-walk + hash + probe + upsert + skip-pipeline.
  // Counters are local to the helper; returned to the dispatch loop for aggregation.
  async function scanOneShare(
    rootPath: string,
    filters: { extensions: string[]; minSizeMb: number; maxDepth?: number },
    shareId: number | null,
  ): Promise<PerShareCounters> {
    let filesScanned = 0;
    let filesAdded = 0;
    let filesUpdated = 0;
    let filesUnchanged = 0;
    let filesFailed = 0;

    for await (const entry of walkFiles(rootPath, {
      extensions: filters.extensions,
      minSizeMb: filters.minSizeMb,
      maxDepth: filters.maxDepth,
    })) {
      filesScanned++;
      const lastScannedAt = Math.floor(Date.now() / 1000);
      const existing = repo.findByPath(entry.path);

      // mtime + size unchanged → fast path, only touch last_scanned_at
      if (existing && existing.size_bytes === entry.size && existing.mtime === entry.mtime) {
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
        filesUnchanged++;
        continue;
      }

      // audit-added S5: independent failure handling per component
      const [hashResult, probeResult] = await Promise.allSettled([
        hashFile(entry.path),
        ffprobe(entry.path),
      ]);

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
        filesFailed++;
        // audit-added M6: existing row's last_scanned_at must not drift stale
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
        share_id: shareId,
      };
      const upserted = repo.upsertByPath(payload);

      if (existing) filesUpdated++;
      else filesAdded++;

      // 04-01: skip pipeline runs only when probe succeeded (we need
      // probe.tags / probe.codec / probe.bitrate for steps 2+5+6). audit M2:
      // try/catch wrapper — pipeline failure must NEVER block the scan; on
      // throw, file row stays at upsert-default status (DB content_hash remains
      // authoritative on the next scan run).
      if (probe) {
        let decision: SkipDecision = { skip: false };
        try {
          decision = await runSkipPipeline(
            { filePath: entry.path, probe, diskContentHash: hashResult.value },
            {
              fileRepo: repo,
              // 04-02 audit M2: pattern cache loaded once at scan boot above.
              blocklistRepo: defaultBlocklistRepo(),
              patternsCache,
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

        if (decision.skip) {
          const updated = repo.setStatus(upserted.id, decision.reason, upserted.version);
          if (updated) {
            logger.info(
              {
                action: 'scan_file_skipped',
                file_id: upserted.id,
                reason: decision.reason,
                source: decision.source,
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

          // 10-01: db-hash self-heal removed — Step 4 (DB hash) no longer exists
          // in the skip pipeline. Files previously matched by DB hash now proceed
          // to encode and receive a fresh sidecar via the commit-step path.
        }
      }
    }

    return { filesScanned, filesAdded, filesUpdated, filesUnchanged, filesFailed };
  }

  // 14-02 top-level aggregation. Sequential dispatch preserves single-flight
  // + lock semantics (acquireScanLock in /api/scan route) and avoids
  // interleaved log lines / FK-races inside the same DB transaction window.
  let filesScanned = 0;
  let filesAdded = 0;
  let filesUpdated = 0;
  let filesUnchanged = 0;
  let filesFailed = 0;
  let byShare: NonNullable<ScanResult['byShare']> | undefined;

  if (isMultiShare) {
    byShare = [];
    for (const share of shares) {
      const exts = share.extensions_csv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      let subResult: PerShareCounters;
      try {
        subResult = await scanOneShare(
          share.path,
          {
            extensions: exts,
            minSizeMb: share.min_size_mb,
            maxDepth: share.max_depth ?? undefined,
          },
          share.id,
        );
      } catch (err) {
        // audit-fix:M2 — CONTEXT R5: one share's failure must NOT block others.
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
        subResult = {
          filesScanned: 0,
          filesAdded: 0,
          filesUpdated: 0,
          filesUnchanged: 0,
          filesFailed: 0,
        };
      }
      byShare.push({
        shareId: share.id,
        name: share.name,
        rootPath: share.path,
        ...subResult,
      });
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
    const subResult = await scanOneShare(
      opts.rootPath,
      { extensions: opts.extensions, minSizeMb: opts.minSizeMb, maxDepth: opts.maxDepth },
      null,
    );
    filesScanned = subResult.filesScanned;
    filesAdded = subResult.filesAdded;
    filesUpdated = subResult.filesUpdated;
    filesUnchanged = subResult.filesUnchanged;
    filesFailed = subResult.filesFailed;
  }

  // 05-bonus: bulk-mark previously-known rows that were NOT touched by this
  // scan as 'vanished'. Operator-controlled states preserved (encoding,
  // queued, blocklisted) so an in-flight encode is not silently invalidated
  // by a failing scan probe. last_scanned_at < startedAt is the canonical
  // "not seen this run" predicate — touchLastScanned + upsertByPath both
  // bump it to the current scan's lastScannedAt.
  // 14-02 AC-6: SINGLE call at scan-end (NOT per-share) — global predicate
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

  return {
    rootPath: opts.rootPath,
    filesScanned,
    filesAdded,
    filesUpdated,
    filesUnchanged,
    filesFailed,
    filesVanished,
    ...(byShare !== undefined ? { byShare } : {}),
    durationMs: finishedMs - startedMs,
    startedAt,
    finishedAt,
  };
}
