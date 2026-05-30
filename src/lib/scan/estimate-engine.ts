// Phase 13 Plan 13-04 Task 2 — read-only walker + skip-aware aggregator.
//
// Mirrors src/lib/scan/orchestrator.ts logic where it intersects (walker
// reuse + sidecar/blocklist skip-pipeline), but emits ZERO DB writes /
// ZERO sidecar writes / ZERO queue additions. Consumed by
// app/api/scan/estimate/route.ts only.
//
// Audit notes:
//   M1 — matchPathInList signature corrected to (filePath, patterns) per
//        src/lib/db/repos/blocklist.ts:59. Two-arg, not three.
//   M2 — file_id-pinned blocklist fallback added to mirror
//        src/lib/skip/pipeline.ts:97-117. Without it, blocklist entries
//        pinned to a specific file_id (no path-pattern match) silently
//        undercount and the estimate diverges from the real scan.
//   SR2 — sidecar_hash_mismatch_at_source warn-log emitted (with
//         via:'estimate' tag) to keep the forensic trail symmetric with
//         pipeline.ts:81-89. Post-incident reconstruction must not depend
//         on which entry-point a file was last evaluated through.
//   SR4 — AbortSignal threading. Operator can navigate away mid-walk on a
//         10TB tree; loop checks signal.aborted between iterations and
//         breaks within ≤1 file-iteration so the shared scan-lock
//         releases promptly in the route's finally block.
//   SR5 — ESTIMATE_MAX_FILES = 100_000 hard cap. Operator can accidentally
//         point at `/` or a huge mount; the cap bounds worst-case memory
//         + walltime and surfaces via the `truncated` flag for explicit
//         UI signaling.

import { walkFiles } from './walker';
import { hashFile } from './hash';
import { ffprobe } from './ffprobe';
import { readSidecar } from '../encode/sidecar';
import { matchPathInList } from '../db/repos/blocklist';
import { logger } from '../logger';
import { estimateSavings, type EstimatorResult } from './savings-estimator';
import type { EncoderId } from '../encode/profiles';
import type { FileRepo } from '../db/repos/file';
import type { BlocklistRepo } from '../db/repos/blocklist';
import type { BlocklistRow } from '../db/schema';
import type { BenchRunRepo } from '../db/repos/bench-run';
import type { BenchComboRepo } from '../db/repos/bench-combo';

export interface EstimateOptions {
  rootPath: string;
  extensions: string[];
  minSizeMb: number;
  maxDepth?: number;
  encoder: EncoderId;
  signal?: AbortSignal; // SR4 — client-disconnect early-exit
}

export interface EstimateBuckets {
  sidecar: number;
  blocklist: number;
  eligible: number;
  scanned: number;
}

export interface EstimateResult {
  filesScanned: number;
  filesEligible: number;
  skipBuckets: EstimateBuckets;
  savings: EstimatorResult['savings'];
  encodeTime: EstimatorResult['encodeTime'];
  durationMs: number;
  truncated: boolean;
  aborted: boolean;
}

export interface EstimateDeps {
  fileRepo: FileRepo;
  blocklistRepo: BlocklistRepo;
  benchRunRepo: BenchRunRepo;
  benchComboRepo: BenchComboRepo;
}

// SR5 — hard cap on files walked. When hit, engine breaks the walker loop,
// sets truncated=true, returns partial aggregate. UI surfaces an explicit
// "truncated at N files" banner.
export const ESTIMATE_MAX_FILES = 100_000;

export async function runEstimate(
  opts: EstimateOptions,
  deps: EstimateDeps,
): Promise<EstimateResult> {
  const startMs = Date.now();

  // Pattern-cache loaded once (mirror scan/orchestrator.ts:43). Defensive
  // try/catch — pattern-cache failure must NOT block the estimate.
  let patternsCache: BlocklistRow[] = [];
  try {
    patternsCache = deps.blocklistRepo.listAllPatterns();
  } catch (err) {
    logger.warn(
      {
        action: 'blocklist_pattern_cache_load_failed',
        err: err instanceof Error ? err.message : String(err),
        via: 'estimate',
      },
      'estimate: pattern cache load failed — skip-pipeline blocklist step will undercount',
    );
  }

  const eligibleSizes: number[] = [];
  const eligibleDurations: (number | null)[] = [];
  const buckets: EstimateBuckets = { sidecar: 0, blocklist: 0, eligible: 0, scanned: 0 };
  let truncated = false;
  let aborted = false;

  for await (const entry of walkFiles(opts.rootPath, {
    extensions: opts.extensions,
    minSizeMb: opts.minSizeMb,
    maxDepth: opts.maxDepth,
  })) {
    if (opts.signal?.aborted) {
      aborted = true;
      logger.info(
        { action: 'estimate_aborted', filesScannedAtAbort: buckets.scanned },
        'estimate: aborted by client signal',
      );
      break;
    }
    if (buckets.scanned >= ESTIMATE_MAX_FILES) {
      truncated = true;
      logger.info(
        { action: 'estimate_truncated', cap: ESTIMATE_MAX_FILES },
        'estimate: hit max-files cap, returning partial aggregate',
      );
      break;
    }

    buckets.scanned++;

    let hash: string;
    try {
      hash = await hashFile(entry.path);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), file: entry.path },
        'estimate: hash failed, treating as eligible (size-only contribution)',
      );
      // Hash failure → cannot run skip-pipeline; treat as eligible by size only,
      // duration unknown. Mirrors orchestrator's filesFailed bucket but the
      // estimate has no DB row to touch — counter-only.
      eligibleSizes.push(entry.size);
      eligibleDurations.push(null);
      buckets.eligible++;
      continue;
    }

    const skip = await checkSkipReadOnly(
      entry.path,
      hash,
      deps.fileRepo,
      deps.blocklistRepo,
      patternsCache,
    );
    if (skip === 'sidecar') {
      buckets.sidecar++;
      continue;
    }
    if (skip === 'blocklist') {
      buckets.blocklist++;
      continue;
    }

    // Eligible — ffprobe for duration only. Failure → push null duration but
    // still count by size (SR3 partial-duration scaling in estimator handles
    // the under-sample by upscaling rawSeconds proportionally).
    let duration: number | null = null;
    try {
      const probe = await ffprobe(entry.path);
      duration = probe?.durationSeconds ?? null;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), file: entry.path },
        'estimate: ffprobe rejected, duration unknown for this file',
      );
    }
    eligibleSizes.push(entry.size);
    eligibleDurations.push(duration);
    buckets.eligible++;
  }

  // Bench-augmented derivation (skipped on empty or aborted paths — both
  // collapse to naive-fallback against a 0-byte total, which renders as
  // "no eligible files" in the UI).
  const benchData = resolveBenchData(opts.encoder, deps.benchRunRepo, deps.benchComboRepo);

  const estimatorOut = estimateSavings({
    eligibleFileSizes: eligibleSizes,
    eligibleFileDurations: eligibleDurations,
    encoder: opts.encoder,
    benchData,
  });

  return {
    filesScanned: buckets.scanned,
    filesEligible: buckets.eligible,
    skipBuckets: buckets,
    savings: estimatorOut.savings,
    encodeTime: estimatorOut.encodeTime,
    durationMs: Date.now() - startMs,
    truncated,
    aborted,
  };
}

// Inline read-only sidecar+blocklist check. Mirrors src/lib/skip/pipeline.ts
// Steps 1+2 EXACTLY (M1 + M2 + SR2) but signature is engine-internal so we
// avoid the mock-probe contortion that pipeline.ts requires for its
// PipelineInput.probe field. This is the ONLY place outside pipeline.ts
// that reads sidecar contentHash + matches blocklist patterns + falls back
// to file_id-pinned entries; if pipeline.ts logic changes, mirror it here.
async function checkSkipReadOnly(
  filePath: string,
  diskContentHash: string,
  fileRepo: FileRepo,
  blocklistRepo: BlocklistRepo,
  patternsCache: BlocklistRow[],
): Promise<'sidecar' | 'blocklist' | null> {
  const sidecar = await readSidecar(filePath);
  if (sidecar) {
    const lower = diskContentHash.toLowerCase();
    if (sidecar.source.contentHash.toLowerCase() === lower) return 'sidecar';
    if (sidecar.output.contentHash.toLowerCase() === lower) return 'sidecar';
    // SR2 — emit warn to match pipeline.ts:81-89 forensic trail.
    logger.warn(
      {
        action: 'sidecar_hash_mismatch_at_source',
        filePath,
        diskContentHash,
        sidecarSourceHash: sidecar.source.contentHash,
        via: 'estimate',
      },
      'estimate: sidecar exists at source-path but contentHash mismatch — falling through to blocklist',
    );
  }

  // Blocklist — mirror pipeline.ts:97-117 (patternsCache primary + fileId fallback).
  // M1: matchPathInList(filePath, patterns) — two-arg per blocklist.ts:59.
  let matched = matchPathInList(filePath, patternsCache);
  // M2: fileId-pinned fallback — entries pinned to a specific file_id with NO
  // matching path-pattern still belong in the blocklist bucket.
  if (!matched) {
    const existing = fileRepo.findByContentHash(diskContentHash);
    const fileId = existing?.id ?? null;
    if (fileId !== null) {
      const pinned = blocklistRepo.findByFileId(fileId);
      matched = pinned !== undefined;
    }
  }
  if (matched) return 'blocklist';
  return null;
}

function resolveBenchData(
  encoder: EncoderId,
  benchRunRepo: BenchRunRepo,
  benchComboRepo: BenchComboRepo,
): { runId: number; ratio: number; encodeFpsRatio: number } | null {
  const latestRun = benchRunRepo.findLatestComplete();
  if (!latestRun) return null;

  const sampleDurationSec = latestRun.sample_duration_seconds;
  if (!(sampleDurationSec > 0)) return null;

  const combos = benchComboRepo
    .listByRun(latestRun.id)
    .filter((c) => c.encoder === encoder && c.top3_role === 'quality');
  if (combos.length === 0) return null;

  // Per-combo savings ratio (1 - encoded/source) — skip nulls / non-positive
  // sources. Same arithmetic basis as src/lib/format/savings.ts:21.
  const savingsRatios: number[] = [];
  for (const c of combos) {
    if (c.source_sample_bytes === null || c.source_sample_bytes <= 0) continue;
    if (c.size_bytes === null) continue;
    savingsRatios.push(1 - c.size_bytes / c.source_sample_bytes);
  }

  // Per-combo encode-fps ratio (sample_duration_seconds / encode_seconds).
  const fpsRatios: number[] = [];
  for (const c of combos) {
    if (c.encode_seconds === null || c.encode_seconds <= 0) continue;
    fpsRatios.push(sampleDurationSec / c.encode_seconds);
  }

  if (savingsRatios.length === 0 || fpsRatios.length === 0) return null;

  const ratio = savingsRatios.reduce((s, r) => s + r, 0) / savingsRatios.length;
  const encodeFpsRatio = fpsRatios.reduce((s, r) => s + r, 0) / fpsRatios.length;

  return { runId: latestRun.id, ratio, encodeFpsRatio };
}
