// Skip-Pipeline radically simplified to 2 in-pipeline
// steps (Sidecar + Blocklist): the sidecar is the only loop protection.
// The logical 4-step pipeline is:
//   Step 1 SIDECAR  — sibling JSON with matching contentHash (~1ms stat + JSON parse)
//   Step 2 BLOCKLIST — pattern + file_id pinned check (in-pipeline.ts)
//   Step 3 ENCODE    — orchestrator (outside this function)
//   Step 4 SAVINGS   — orchestrator commit-step verdict (outside this function)
//
// pipeline.ts owns ONLY Steps 1-2. Encode + savings-check live in the orchestrator
// commit-step. All 5 prior defense-layers (suffix-gate, MKV-tag-read, DB-content-
// hash-lookup, codec-check, bitrate-heuristic) removed — user-intent is
// "encode-everything-then-decide"; sidecar is the sole loop-protection mechanism.
//
// SkipReason union narrowed to 2 values:
// decision: 'done-already-evaluated' DROPPED entirely; all sidecar-hash-matches
// collapse to 'skipped-sidecar' uniformly.
//
// Research-driven: internal design notes §5.

import type { FileRepo } from '../db/repos/file';
import type { BlocklistRepo } from '../db/repos/blocklist';
import type { BlocklistRow } from '../db/schema';
import {
  readSidecar,
  readSidecarResolved,
  DEFAULT_SIDECAR_CENTRAL_PATH,
  type SidecarMode,
} from '../encode/sidecar';
import { matchPath } from '../db/repos/blocklist';
import { logger } from '../logger';
import type { Logger } from 'pino';

// patternsCache ownership lives in CALLER not repo.
// Module-scope timestamp updates iff pipeline runs with a NEW patternsCache
// reference (ref-identity check vs previous call). Read via getPatternsCacheTimestamp().
let _patternsCacheTimestamp: string | null = null;
let _lastPatternsCacheRef: BlocklistRow[] | null = null;

export function getPatternsCacheTimestamp(): string | null {
  return _patternsCacheTimestamp;
}

/** Test-only: reset the patternsCache timestamp tracker. */
export function _resetPatternsCacheTimestampForTesting(): void {
  if (process.env.NODE_ENV === 'production' && process.env.VITEST !== 'true') return;
  _patternsCacheTimestamp = null;
  _lastPatternsCacheRef = null;
}

// SkipReason union narrowed — 'done-already-evaluated' DROPPED.
// Aligns with the FileStatus union. Outcome detail
// (done-smaller/done-larger/done-not-worth) preserved in sidecar JSON; downstream
// stats/UI consumers read sidecar payload directly.
export type SkipReason = 'skipped-sidecar' | 'skipped-blocklist';
export type SkipSource = 'sidecar' | 'blocklist';

export type SkipDecision = { skip: false } | { skip: true; reason: SkipReason; source: SkipSource };

export type PipelineDeps = {
  fileRepo: FileRepo;
  // Pre-loaded pattern cache from
  // BlocklistRepo.listAllPatterns() — populated ONCE per scan run by the
  // scanner orchestrator. When provided, step 2 uses matchPathInList (pure,
  // no DB) instead of per-call matchByFileIdOrPath. Callers that omit both
  // fields and step 2 short-circuits — byte-identical behavior.
  blocklistRepo?: BlocklistRepo;
  patternsCache?: BlocklistRow[];
  // Optional pino debug logger for blocklist_evaluation
  // emit consumed by diagnostics blocklist-evaluation surface.
  // When absent, emit is skipped — callers without it see byte-identical behavior.
  logger?: Pick<Logger, 'debug'>;
  // Optional, mirrors the blocklistRepo?/patternsCache?/logger?
  // idiom): when sidecarMode==='central' Step 1 consults the central sidecar tree
  // (with beside fallback) instead of beside-only. Callers resolve these from
  // settings and pass them; legacy callers omit both → Step 1 defaults to a
  // beside read = byte-identical to the beside-only behavior. Pipeline stays pure-input
  // (no settingRepo coupling).
  sidecarMode?: SidecarMode; // absent → beside (byte-identical)
  sidecarCentralPath?: string; // central root; consulted ONLY when sidecarMode==='central'
};

export type PipelineInput = {
  filePath: string;
  probe: import('../scan/ffprobe').ProbeResult;
  /** 3×4 MiB partial-SHA-256 of the disk file. Caller computes this BEFORE
   *  calling the pipeline (scanner already does it for upsertByPath). */
  diskContentHash: string;
};

export async function runSkipPipeline(
  input: PipelineInput,
  deps: PipelineDeps,
): Promise<SkipDecision> {
  const startedAt = Date.now();
  const { filePath, diskContentHash } = input;

  // Step 1: SIDECAR — sibling JSON with matching contentHash (~1ms stat + parse).
  // Lowercase-normalize both sides of contentHash compare.
  // All sidecar-hash-matches collapse to single SkipReason='skipped-sidecar'
  // uniformly (outcome detail stays in sidecar JSON; the
  // orchestrator reads outcome from sidecar at scan time if needed).
  // Central mode reads the central-resolved sidecar first (beside fallback);
  // absent/'beside'/'off' is byte-identical to the beside read (readSidecar = beside).
  // The central-root default comes from the SHARED const, never a
  // re-typed literal — read-default MUST equal the write-default.
  const sidecar =
    deps.sidecarMode === 'central'
      ? await readSidecarResolved(
          filePath,
          'central',
          deps.sidecarCentralPath ?? DEFAULT_SIDECAR_CENTRAL_PATH,
        )
      : await readSidecar(filePath);
  if (sidecar) {
    if (sidecar.source.contentHash.toLowerCase() === diskContentHash.toLowerCase()) {
      return logDecision({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' }, startedAt);
    }
    // Output-file guard: for done-smaller encodes the sidecar lives at the OUTPUT
    // path (movie.x265.mkv.x265-butler.json). On re-scan the source is gone but
    // the output is picked up as a new 'pending' row — source.contentHash never
    // matches the output file's hash. Comparing against output.contentHash catches
    // exactly this case and prevents the re-encode loop. (All V1/V2/V3 carry
    // output.contentHash.)
    if (sidecar.output.contentHash.toLowerCase() === diskContentHash.toLowerCase()) {
      return logDecision({ skip: true, reason: 'skipped-sidecar', source: 'sidecar' }, startedAt);
    }
    logger.warn(
      {
        action: 'sidecar_hash_mismatch_at_source',
        filePath,
        diskContentHash,
        sidecarSourceHash: sidecar.source.contentHash,
      },
      'sidecar exists at source-path but contentHash mismatch — falling through to blocklist; sidecar persists (auto-cleanup deferred to M2 cleanup tool)',
    );
    // Fall through to Step 2.
  }

  // Step 2: BLOCKLIST — only runs when the caller provides blocklistRepo OR
  // patternsCache. Callers without either dep see byte-identical behavior.
  // Prefer patternsCache (pure, no DB) when present; fall back to
  // matchByFileIdOrPath for non-cached callers (test scenarios + ad-hoc API).
  if (deps.blocklistRepo || deps.patternsCache) {
    // Timestamp ref-identity-tracker. When caller
    // passes a NEW patternsCache reference, update _patternsCacheTimestamp.
    if (deps.patternsCache && deps.patternsCache !== _lastPatternsCacheRef) {
      _lastPatternsCacheRef = deps.patternsCache;
      _patternsCacheTimestamp = new Date().toISOString();
    }

    let matched: { id: number; kind: 'file_id' | 'path_pattern'; pattern?: string } | null = null;
    const existing = deps.fileRepo.findByContentHash(diskContentHash);
    const fileId = existing?.id ?? null;

    if (deps.patternsCache) {
      const patternHit = findMatchInPatternList(filePath, deps.patternsCache);
      if (patternHit) {
        matched = {
          id: patternHit.id,
          kind: 'path_pattern',
          pattern: patternHit.path_pattern ?? undefined,
        };
      } else if (deps.blocklistRepo && fileId !== null) {
        const pinned = deps.blocklistRepo.findByFileId(fileId);
        if (pinned) matched = { id: pinned.id, kind: 'file_id' };
      }
    } else if (deps.blocklistRepo) {
      const hit = deps.blocklistRepo.matchByFileIdOrPath(fileId, filePath);
      if (hit) {
        // Legacy path doesn't return the matched-row identity; emit a sentinel.
        matched = { id: -1, kind: fileId !== null ? 'file_id' : 'path_pattern' };
      }
    }

    // blocklist_evaluation emit AFTER outcome,
    // regardless of match/no-match. Optional logger keeps callers without it
    // byte-identical (deps.logger absent → skip emit).
    if (deps.logger) {
      deps.logger.debug(
        { path: filePath, matchedEntry: matched, ts: Date.now() },
        'blocklist_evaluation',
      );
    }

    if (matched) {
      return logDecision(
        { skip: true, reason: 'skipped-blocklist', source: 'blocklist' },
        startedAt,
      );
    }
  }

  // No skip signal — caller proceeds to upsert + enqueue.
  return { skip: false };
}

// Like matchPathInList but returns the matching row for emit-payload.
// matchPathInList is boolean-only; we need the matched row's id + pattern for
// blocklist_evaluation decoder shape. O(N) — same as matchPathInList.
function findMatchInPatternList(filePath: string, patterns: BlocklistRow[]): BlocklistRow | null {
  for (const p of patterns) {
    if (!p.path_pattern) continue;
    if (matchPath(p.path_pattern, filePath)) return p;
  }
  return null;
}

function logDecision(decision: SkipDecision, startedAt: number): SkipDecision {
  if (decision.skip) {
    // audit-added S5: source field always emitted for forensic reconstruction.
    logger.info(
      {
        action: 'skip_pipeline_decision',
        reason: decision.reason,
        source: decision.source,
        durationMs: Date.now() - startedAt,
      },
      'skip pipeline decision',
    );
  }
  return decision;
}
