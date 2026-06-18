// audit-added S11: SINGLE-PROCESS ASSUMPTION
//
// Module-level state below (_loopStarted, _activeControllers, _idleTimer)
// assumes ONE Node process per Docker container, as mandated by PROJECT.md
// (unRAID single-tenant deployment model). Multi-worker / cluster mode would
// spawn parallel orchestrators competing on `claimNext` (which IS TX-safe via
// 02-01 M4) but each running its own poll loop — Skip / Cancel-All would
// silently fail to propagate across processes (in-memory _activeControllers
// is not shared). Do NOT enable cluster / multi-worker without re-architecting
// orchestrator state to a shared store (Redis pub/sub kill-switch, distributed
// lock for the cancel-all snapshot).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger as defaultLogger } from '../logger';
type Logger = typeof defaultLogger;
import {
  fileRepo as defaultFileRepo,
  jobRepo as defaultJobRepo,
  settingRepo as defaultSettingRepo,
  trashRepo as defaultTrashRepo,
} from '../db';
import type { FileRow, JobRow } from '../db/schema';
import type { FileRepo } from '../db/repos/file';
import type { JobRepo } from '../db/repos/job';
import type { SettingRepo } from '../db/repos/setting';
import type { TrashRepo } from '../db/repos/trash';
import { ffprobe as defaultFfprobe, type ProbeResult } from '../scan/ffprobe';
import { runEncode as defaultRunEncode, type EncodeResult } from './ffmpeg';
import { DEFAULT_PRESET_BY_ENCODER } from './profiles';
import { isValidPreset } from './presets';
import { resolveEffectiveCachePath } from './cache-path';
// 05-14 (additive): output-container helper + subtitle/audio compat for the
// dispatch-boundary read + ffprobe pre-flight (AC-6 / AC-11 / AC-12 / AC-13).
// 05-15 (additive): isOutputContainerSetting + resolveContainerFromSource +
// OutputContainerSetting drive the match-source dispatch resolver.
import {
  extensionFor,
  isOutputContainer,
  isOutputContainerSetting,
  resolveContainerFromSource,
  type OutputContainer,
  type OutputContainerSetting,
} from './output-container';
// 26-02 (F5): output-mode helper (suffix-sibling vs in-place replace).
import { isOutputMode, type OutputMode } from './output-mode';
import { analyzeStreams } from './subtitle-compat';
import { analyzeAudioStreams, type AudioAutoTranscodeTarget } from './audio-compat';
import { openJobLogStream, type JobLogStream } from './log-capture';
import * as defaultStaging from './staging';
import {
  assertCachePoolFreeSpace,
  CachePoolPreFlightError,
  CachePoolConfigError,
  CachePoolUnavailableError,
} from './staging';
// 04-01 additive: sidecar JSON write at commit step. writeSidecar errors are
// caught + warn-logged + NEVER propagate (DB content_hash authoritative).
import {
  encoderNameFor,
  qualityModeFor,
  writeSidecar as defaultWriteSidecar,
  // 26-01 (F3): central-mode resolved writer. beside writes still go through the
  // 2-arg deps.writeSidecar to keep existing orchestrator-test arg-assertions green
  // (AC-1 sentinel / audit-M3 dep-shape); central routes through this dep.
  writeSidecarResolved as defaultWriteSidecarResolved,
  type SidecarMode,
  type SidecarV2,
  type SidecarV3,
  type AudioTranscodeRecord,
  type ContainerFallbackRecord,
} from './sidecar';
// 04-01 additive: output content_hash compute for sidecar payload.
import { hashFile as defaultHashFile } from '../scan/hash';
// 04-01 additive: read getVersionInfo().version via existing version helper to avoid a
// JSON-import attribute that may interact poorly with vitest module hoisting.
import { getVersionInfo } from '../version';
import { engineEvents as defaultEngineEvents, type EngineEvents } from './events';
// 03-01 audit-added (additive): encoder detection + dispatch.
import { detectEncoders as defaultDetectEncoders, type DetectionResult } from './detection';
import { ENCODER_IDS, type EncoderId } from './profiles';
// 03-02 audit-added (additive): per-encoder concurrency limits.
import { computePerEncoderLimits, type PerEncoderLimits } from './concurrency';
// 32-02: dependency-free pause flag (audit SR-3 — keeps light consumers off the
// orchestrator graph). isQueuePaused is re-exported below for the encode barrel.
import { isQueuePaused, __setPausedFlag, __resetPausedFlag } from './pause-state';

// Reconcile-on-boot (Option B): threshold=0 means EVERY 'encoding' job at boot
// is treated as orphaned. Sound under the single-process orchestrator
// invariant (audit S11 from 02-02): there is no concurrent encoder, so any
// 'encoding' row in the DB at startup must be a leftover from a prior process
// that died (dev:restart, SIGKILL, container OOM). Without this, a fresh boot
// would leave orphans visible as "encoding" in the Recent jobs table for up
// to 12 h while the new orchestrator picks up the next queued row, producing
// the multi-orphan symptom users hit during iterative dev:restart cycles.
const STALE_ENCODING_THRESHOLD_SECONDS = 0;
const IDLE_POLL_MS = 1000;
// 24-03: the legacy `DEFAULT_CACHE_POOL_PATH = '/mnt/cache/x265-butler'` const
// was the sole consumer at readSettings; the dispatch chokepoint now routes
// through resolveEffectiveCachePath (DC-B auto-resolution). The /mnt/cache
// default lives in cache-path.ts as MNT_CACHE_DEFAULT (single source of truth).

// 22-00 IMP-5: pre-flight statfs probe — evidence-only, pure, never throws.
// Exported for direct unit tests + reused at dispatch boundary below.
export interface PreflightStatfsEntry {
  path: string;
  statfs_ok: boolean;
  errno?: string;
}

export function preflightStatfsProbe(
  paths: readonly string[],
  statfsSync: (p: string) => unknown,
): PreflightStatfsEntry[] {
  return paths.map((p) => {
    try {
      statfsSync(p);
      return { path: p, statfs_ok: true };
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code: unknown }).code)
          : 'UNKNOWN';
      return { path: p, statfs_ok: false, errno: code };
    }
  });
}

export type EngineDeps = {
  runEncode: typeof defaultRunEncode;
  ffprobe: typeof defaultFfprobe;
  fs: {
    statSync: typeof fs.statSync;
    statfsSync: typeof fs.statfsSync;
    existsSync: typeof fs.existsSync;
    // 05-bonus: hard-delete original when delete_original_after_encode=true.
    unlinkSync: typeof fs.unlinkSync;
    // 05-13 audit M2: W_OK pre-flight on source-path's parent dir before
    // writeSidecar at source-path. Read-only-source-mount unRAID configs
    // throw EACCES/EROFS/ENOENT here → soft-degrade path skips writeSidecar
    // but still runs setStatus + markCompleted (forensic record preserved).
    accessSync: typeof fs.accessSync;
    // 31-02: best-effort source-mtime preservation on the committed output.
    // OPTIONAL so the ~8 legacy inline fs:{…} test mocks stay byte-identical —
    // an absent dep makes the cosmetic stamp a no-op (correct best-effort
    // behavior). Production makeDefaultDeps ALWAYS wires fs.utimesSync.
    utimesSync?: typeof fs.utimesSync;
  };
  staging: typeof defaultStaging;
  jobRepo: () => JobRepo;
  fileRepo: () => FileRepo;
  trashRepo: () => TrashRepo;
  settingRepo: () => SettingRepo;
  logger: Logger;
  now: () => number; // seconds since epoch
  // 02-03 Task 2 (additive): engine event emitter consumed by SSE Route Handler.
  // engineEvents.emit is internally safeEmit-wrapped (audit M1) — listener throws
  // are caught/pino-warned and NEVER propagate back into the orchestrator.
  events: EngineEvents;
  // 03-01 audit S1 (additive): boot-time detection probe lifted out of the
  // per-job hot path. startEncoderLoop awaits this once + caches the result;
  // processOne reads the cached value synchronously via the global cache.
  detectEncoders: typeof defaultDetectEncoders;
  // 04-01 additive: sidecar writer + output hash. Test deps may inject mocks;
  // production wires the defaults from sidecar.ts + scan/hash.ts.
  writeSidecar: typeof defaultWriteSidecar;
  // 26-01 (F3): central-mode resolved writer (mode + centralRoot aware). Added
  // as a SEPARATE dep so the 2-arg `writeSidecar` dep + its existing test
  // arg-assertions stay byte-identical (audit-M3). Only invoked for mode==='central'.
  writeSidecarResolved: typeof defaultWriteSidecarResolved;
  hashFile: typeof defaultHashFile;
};

function makeDefaultDeps(): EngineDeps {
  return {
    runEncode: defaultRunEncode,
    ffprobe: defaultFfprobe,
    fs: {
      statSync: fs.statSync,
      statfsSync: fs.statfsSync,
      existsSync: fs.existsSync,
      unlinkSync: fs.unlinkSync,
      accessSync: fs.accessSync,
      utimesSync: fs.utimesSync,
    },
    staging: defaultStaging,
    jobRepo: defaultJobRepo,
    fileRepo: defaultFileRepo,
    trashRepo: defaultTrashRepo,
    settingRepo: defaultSettingRepo,
    logger: defaultLogger,
    now: () => Math.floor(Date.now() / 1000),
    events: defaultEngineEvents,
    detectEncoders: defaultDetectEncoders,
    writeSidecar: defaultWriteSidecar,
    writeSidecarResolved: defaultWriteSidecarResolved,
    hashFile: defaultHashFile,
  };
}

// 03-01 audit S1: boot-time detection result cache. startEncoderLoop awaits
// detectEncoders() ONCE during bootstrap and stores the resolved DetectionResult
// here. processOne reads it synchronously — no per-job spawn latency.
let _detectionResult: DetectionResult | null = null;

// 02-03 Task 2: emit fresh queue.updated counts after every terminal transition
// + on enqueue (HTTP-side). Uses jobRepo.countByStatus (audit M2) — accurate past
// 500 queued rows, unlike the old listRecent(500).filter pattern.
//
// 05-09 Decision §2: `paused` field stays in the wire format permanently.
// 32-02: pause-after-current is RE-ACTIVATED — `paused` now carries the real
// in-memory `_paused` flag (no longer hardcoded `false`). The wire field never
// changed shape, so unmigrated SSE consumers keep deserializing; they simply now
// observe the true paused state. The 05-08 setPaused/isPaused implementation that
// 05-09 retired is NOT what 32-02 restores: this is a fresh in-memory flag with
// pause-after-current semantics (running encode finishes; only NEW dispatch stops).
function emitQueueUpdated(deps: EngineDeps): void {
  const activeJobs = deps.jobRepo().listActive().length;
  const pendingJobs = deps.jobRepo().countByStatus('queued');
  deps.events.emit({ type: 'queue.updated', activeJobs, pendingJobs, paused: isQueuePaused() });
}

let _deps: EngineDeps = makeDefaultDeps();
let _loopStarted = false;
let _stopping = false;
// 32-02: in-memory pause-after-current flag. The raw boolean + getter live in the
// dependency-free './pause-state' module (audit SR-3 — keeps GET /api/queue/status,
// the watcher, and the SSR page off the heavy orchestrator graph). The gate reads
// isQueuePaused(); setQueuePaused (below) flips it via __setPausedFlag.
let _idleTimer: NodeJS.Timeout | null = null;
const _activeControllers = new Map<number, AbortController>();

// 03-02 audit-added — multi-slot dispatch state.
//
// Slot accounting:
//   _activeJobEncoders: Map<jobId, EncoderId>  — per-job slot ownership
//   _activeCountByEncoder: Map<EncoderId, number>  — O(1) capacity counter (audit S9)
// These two maps are kept in lockstep via reserveSlot / releaseSlot helpers.
//
// _perEncoderLimits: computed at boot in startEncoderLoop from settings.concurrency
// + os.cpus().length. recomputePerEncoderLimits() exported for the future
// 03-03 Settings UI consumer (operator-confirmed concurrency change).
//
// _dispatching: single-flight mutex (audit M2) on dispatchUntilFull. Without it,
// concurrent dispatch loops (one from .finally chain, one from idle-poll timer)
// can both pass hasCapacityFor checks → briefly exceed _perEncoderLimits.
//
// _inflight: Set of in-flight background processOne promises. Used by
// stopEncoderLoop to await graceful drain. Each promise removes itself on
// .finally (per audit S1 const-capture pattern).
let _perEncoderLimits: PerEncoderLimits = { libx265: 1, nvenc: 1, qsv: 1, vaapi: 1 };
const _activeJobEncoders = new Map<number, EncoderId>();
const _activeCountByEncoder = new Map<EncoderId, number>();
let _dispatching = false;
const _inflight = new Set<Promise<void>>();
// Post-05-12 CI hardening: track fire-and-forget dispatchUntilFull invocations
// (boot path + scheduleNext callback) so __forTests_resetOrchestrator can
// drain them before tests rmSync the stage directory. Without this, an idle
// poll callback that already fired but has not yet returned can race with the
// test teardown and leave orphan files behind, surfacing as ENOTEMPTY on CI's
// overlayfs (where statSync/rmdir timing is tighter than ext4).
const _pendingDispatches = new Set<Promise<void>>();

// 10-01: bench-channel bypass marker. Jobs in this Set skip all commit-step
// side effects (writeSidecar, setStatus, markCompleted). P11 wires the real
// bench-dispatch path; for now the Set is populated only via the test escape-hatch.
const _benchSampleJobIds = new Set<number>();

function trackDispatch(p: Promise<void>): Promise<void> {
  _pendingDispatches.add(p);
  void p.finally(() => {
    _pendingDispatches.delete(p);
  });
  return p;
}

function reserveSlot(jobId: number, encoder: EncoderId): void {
  _activeJobEncoders.set(jobId, encoder);
  _activeCountByEncoder.set(encoder, (_activeCountByEncoder.get(encoder) ?? 0) + 1);
}

function releaseSlot(jobId: number): void {
  const enc = _activeJobEncoders.get(jobId);
  _activeJobEncoders.delete(jobId);
  if (enc) {
    const cnt = _activeCountByEncoder.get(enc) ?? 1;
    _activeCountByEncoder.set(enc, Math.max(0, cnt - 1));
  }
}

function activeCountFor(encoder: EncoderId): number {
  return _activeCountByEncoder.get(encoder) ?? 0;
}

function hasCapacityFor(encoder: EncoderId): boolean {
  return activeCountFor(encoder) < _perEncoderLimits[encoder];
}

// audit-added M3 (03-02): capacity-aware encoder resolver.
// For 'auto' requests, walks det.detected[] preference order picking the FIRST
// encoder with free capacity. Without this, ALL 'auto' jobs serialize through
// det.activeFromAuto on multi-core hosts with NVENC=1 + libx265=4 — defeating
// the entire purpose of multi-slot.
//
// Pinned-encoder requests preserve 03-01 behavior byte-identical:
//   - Valid + detected → dispatch as requested
//   - Valid + undetected → libx265 fallback with `encoder_unavailable` warn
//   - Invalid (gibberish, tampering) → 'auto' walk with `encoder_setting_invalid` warn
function resolveEncoderFor(
  jobRow: JobRow,
  settingsAll: Record<string, string>,
  det: DetectionResult,
  deps: EngineDeps,
): EncoderId {
  const requestedRaw = settingsAll.encoder;
  let requested: EncoderId | 'auto';
  if (requestedRaw === undefined || requestedRaw === 'auto') {
    requested = 'auto';
  } else if ((ENCODER_IDS as readonly string[]).includes(requestedRaw)) {
    requested = requestedRaw as EncoderId;
  } else {
    deps.logger.warn(
      {
        action: 'encoder_setting_invalid',
        value: requestedRaw,
        fallback: 'auto',
        jobId: jobRow.id,
      },
      'invalid settings.encoder — defaulting to auto resolution',
    );
    requested = 'auto';
  }

  if (requested === 'auto') {
    for (const candidate of det.detected) {
      if (hasCapacityFor(candidate)) return candidate;
    }
    return 'libx265';
  }
  if (det.detected.includes(requested)) {
    return requested;
  }
  deps.logger.warn(
    { action: 'encoder_unavailable', requested, fallback: 'libx265', jobId: jobRow.id },
    'requested encoder not available — falling back to libx265',
  );
  return 'libx265';
}

// 03-03 audit-added M3: clear module-local _detectionResult so the next
// processOne falls through to globalThis __x265butler_encoder_cache (which the
// /api/encoders/refresh endpoint populates fresh via invalidateEncoderCache +
// detectEncoders({force:true}) before calling this hook). Without this reset,
// the orchestrator dispatches with stale boot-time detection until container
// restart — defeating the operator-confirmed-change refresh flow entirely.
export function invalidateOrchestratorDetectionCache(): void {
  _detectionResult = null;
}

// audit-added S3 (03-02): exported recompute hook for 03-03 Settings UI.
// Re-reads settings.concurrency + os.cpus().length and updates _perEncoderLimits
// in place. Subsequent dispatch ticks honor the new limits without a container
// restart.
export function recomputePerEncoderLimits(): void {
  const concurrency = _deps.settingRepo().get('concurrency');
  _perEncoderLimits = computePerEncoderLimits({
    concurrency,
    cpuCount: os.cpus().length,
    logger: _deps.logger,
  });
}

// Test-only inspection helpers — never exported via the barrel.
export function __forTests_getPerEncoderLimits(): PerEncoderLimits {
  return { ..._perEncoderLimits };
}

export function __forTests_getActiveCount(encoder: EncoderId): number {
  return activeCountFor(encoder);
}

// 05-09: skipActive — single-job hard-cancel + file→pending. Replaces the
// 05-08 B1 hard-cancel-with-re-queue mechanic forward (Option B chosen
// 2026-04-29 after critical evaluation of A/B/C/D — User-intent shifted from
// "Stop preserves intent and queue resumes the same files later" to "Skip =
// throw this away, I'll trigger again if I really want it").
//
// Branches:
//   A) status='encoding' + controller present → ctrl.abort() → drain THIS job's
//      inflight promise → markCancelled + file→pending + cleanupWorkDir +
//      sidecar-tmp-unlink.
//   B) status='encoding' + NO controller (orphan from crash) → markCancelled +
//      file→pending; emit job.cancelled SSE so UI reconciles.
//   C) status='queued' → markCancelled + file→pending. No abort, no cleanup.
//   D) terminal status → idempotent no-op (jobRepo.markCancelled returns null
//      on terminal; caller treats this as "already terminal"; route layer maps
//      to alreadyTerminal=true).
//
// actorId is the authenticated session username, OR the literal 'auth_disabled'
// when auth is off — NEVER null/undefined/empty so post-incident `grep actorId`
// always returns a value.
export async function skipActive(
  jobId: number,
  actorId: string,
): Promise<{ skipped: boolean; prevStatus: string; alreadyTerminal: boolean }> {
  const deps = _deps;
  const jobRow = deps.jobRepo().findById(jobId);
  if (!jobRow) {
    return { skipped: false, prevStatus: 'not_found', alreadyTerminal: false };
  }
  const prevStatus = jobRow.status;

  // Terminal short-circuit — 05-09 idempotent contract.
  if (prevStatus !== 'encoding' && prevStatus !== 'queued') {
    return { skipped: true, prevStatus, alreadyTerminal: true };
  }

  // Branch A vs B/C — abort + drain only when ffmpeg is live.
  if (prevStatus === 'encoding') {
    const ctrl = _activeControllers.get(jobId);
    if (ctrl) {
      ctrl.abort();
      // Drain the SINGLE matching inflight promise (best-effort — multi-slot
      // means _inflight may hold N promises, but we only need ours to settle so
      // processOne's AbortError catch runs markCancelled + setStatus + cleanup).
      // Promise.allSettled on the snapshot is a defensive over-drain — bounded
      // by remaining encodes, completes within the existing 02-02 SIGTERM grace.
      if (_inflight.size > 0) {
        await Promise.allSettled([..._inflight]);
      }
    } else {
      // Branch B — orphan encoding row. processOne never registered a
      // controller (process killed mid-stage or test fixture). Skip abort.
      deps.logger.info(
        {
          action: 'queue_skip_orphan_encoding_row',
          jobId,
          fileId: jobRow.file_id,
          actorId,
        },
        'skipActive: orphan encoding row — no in-memory controller, skipping abort',
      );
    }
  }

  // markCancelled is status-guarded ('queued','encoding'); idempotent on terminal.
  // For Branch A, processOne's AbortError catch may have already markCancelled +
  // setStatus(file, 'interrupted'). We then flip file→'pending' BELOW so 05-09
  // semantics dominate: file goes back to library wait state regardless of which
  // catch path ran first.
  const cancelled = deps.jobRepo().markCancelled(jobId);

  // file→pending flip — fresh-read version because processOne's catch may have
  // bumped it. Defensive try; never throws to caller.
  let fileFlipped = false;
  try {
    const fileNow = deps.fileRepo().getById(jobRow.file_id);
    if (fileNow) {
      // status guard — if scan/trash flow already moved this file into a
      // terminal state we don't overwrite; pending is fine for queued/encoding/
      // interrupted (which processOne's catch may have set).
      if (
        fileNow.status === 'queued' ||
        fileNow.status === 'encoding' ||
        fileNow.status === 'interrupted'
      ) {
        fileFlipped = deps.fileRepo().setStatus(fileNow.id, 'pending', fileNow.version);
      }
    }
  } catch (err) {
    deps.logger.warn(
      {
        action: 'queue_skip_file_flip_failed',
        jobId,
        fileId: jobRow.file_id,
        actorId,
        err: err instanceof Error ? err.message : String(err),
      },
      'skipActive: file→pending flip threw — operator may need to retry',
    );
  }

  // Cleanup partial output + sidecar tmp (Branch A path only — queued has
  // nothing on disk). Fire-and-forget; cleanupWorkDir / unlinkSidecarTmpAt are
  // log-on-failure-but-no-throw.
  if (prevStatus === 'encoding') {
    const settings = readSettings(deps);
    void deps.staging.cleanupWorkDir(deps.staging.workDirFor(settings.stageRoot, jobId));
    try {
      const file = deps.fileRepo().getById(jobRow.file_id);
      if (file) {
        // 05-15 audit M2: under match-source, the in-flight job could have
        // resolved to EITHER .x265.mkv or .x265.mp4 — clean both candidates.
        const cleanupSuffixes = cleanupSuffixesFor(settings);
        for (const suffix of cleanupSuffixes) {
          const finalOutputPath = deps.staging.outputPathFor(file.path, suffix);
          void deps.staging.unlinkSidecarTmpAt(finalOutputPath);
        }
      }
    } catch {
      // best-effort
    }
  }

  // SSE — orphan branch needs explicit emit (Branch A's processOne catch
  // already emitted job.cancelled). Idempotent emit is fine — UI dedupes by
  // jobId + status convergence.
  try {
    deps.events.emit({ type: 'job.cancelled', jobId, fileId: jobRow.file_id });
    emitQueueUpdated(deps);
  } catch {
    // best-effort
  }

  // SOC-2 audit-trail entry per skip (mirrors 05-08 job_hard_cancelled pattern).
  deps.logger.info(
    {
      action: 'job_skipped',
      jobId,
      fileId: jobRow.file_id,
      actorId,
      prevStatus,
      cancelledByUs: cancelled !== null,
      fileFlippedToPending: fileFlipped,
    },
    'job skipped by user',
  );

  return { skipped: true, prevStatus, alreadyTerminal: false };
}

// 05-09: cancelAllQueued — mass-skip every active+queued row in one click.
//
// Three-phase ordering (mirrors 05-08 audit M2 sync-TX boundary precedent):
//   1. Snapshot listActive() — bounded batch (Decision §4 — jobs enqueued
//      mid-flight are NOT cancelled by this invocation).
//   2. Async kill phase OUTSIDE any TX — abort every encoding controller,
//      drain Promise.allSettled, run cleanupWorkDir + sidecar-tmp-unlink for
//      every encoding job (audit M1 parity with skipActive hygiene).
//   3. Single sync TX wraps markCancelledBulk(allIds) + bulkSetStatusToPendingByIds(
//      fileIds, ['queued','encoding']) — atomic, OCC-race-free, no per-row
//      setStatus inside the TX (forbidden — version snapshot races concurrent
//      scan/trash flows).
//   4. Post-TX SSE emit per affected job + ONE final emitQueueUpdated. Without
//      these the UI does not transition status chips live (audit M5).
//
// Audit S2 — empty-queue path: still emits a `queue_cancel_all_empty` info-level
// pino event (SOC-2 logs every operator action including no-ops). NO state
// mutations; route layer also avoids mirroring this to keep audit-trail
// single-source.
export async function cancelAllQueued(
  actorId: string,
): Promise<{ skipped: number; cancelled: number }> {
  const deps = _deps;
  const snapshot = deps.jobRepo().listActive();
  const encodingJobs = snapshot.filter((j) => j.status === 'encoding');
  const queuedJobs = snapshot.filter((j) => j.status === 'queued');

  // Audit S2 — empty no-op path. Pino entry preserves operator audit-trail.
  if (encodingJobs.length === 0 && queuedJobs.length === 0) {
    deps.logger.info(
      { action: 'queue_cancel_all_empty', actorId },
      'cancelAllQueued: no active or queued jobs — no-op',
    );
    return { skipped: 0, cancelled: 0 };
  }

  // Phase 2 — abort every encoding controller, then drain.
  for (const jobRow of encodingJobs) {
    const ctrl = _activeControllers.get(jobRow.id);
    if (ctrl) {
      ctrl.abort();
    } else {
      deps.logger.info(
        {
          action: 'queue_cancel_all_orphan_encoding_row',
          jobId: jobRow.id,
          fileId: jobRow.file_id,
          actorId,
        },
        'cancelAllQueued: orphan encoding row — no in-memory controller',
      );
    }
  }
  if (_inflight.size > 0) {
    await Promise.allSettled([..._inflight]);
  }

  // Phase 2b — cleanupWorkDir + sidecar-tmp parity per encoding job (audit M1).
  // Fire-and-forget; cleanup helpers are log-on-failure-but-no-throw.
  // 05-15 audit M2: cleanupSuffixesFor returns BOTH .x265.mkv + .x265.mp4 under
  // match-source so unlinkSidecarTmpAt covers either dispatch resolution.
  const settings = readSettings(deps);
  const cleanupSuffixes = cleanupSuffixesFor(settings);
  for (const jobRow of encodingJobs) {
    void deps.staging.cleanupWorkDir(deps.staging.workDirFor(settings.stageRoot, jobRow.id));
    try {
      const file = deps.fileRepo().getById(jobRow.file_id);
      if (file) {
        for (const suffix of cleanupSuffixes) {
          const finalOutputPath = deps.staging.outputPathFor(file.path, suffix);
          void deps.staging.unlinkSidecarTmpAt(finalOutputPath);
        }
      }
    } catch {
      // best-effort
    }
  }

  // Phase 3 — single sync TX wraps both bulk operations (audit M2).
  // jobRepo.cancelJobsAndPendFilesTx commits both writes atomically OR neither.
  const allJobIds = [...encodingJobs, ...queuedJobs].map((j) => j.id);
  const allFileIds = [...encodingJobs, ...queuedJobs].map((j) => j.file_id);
  const txResult = deps
    .jobRepo()
    .cancelJobsAndPendFilesTx(allJobIds, allFileIds, ['queued', 'encoding']);

  // Phase 4 — per-job SSE + final queue.updated.
  for (const jobRow of [...encodingJobs, ...queuedJobs]) {
    try {
      deps.events.emit({ type: 'job.cancelled', jobId: jobRow.id, fileId: jobRow.file_id });
    } catch {
      // best-effort
    }
  }
  try {
    emitQueueUpdated(deps);
  } catch {
    // best-effort
  }

  // SOC-2 audit-trail — per-job + summary.
  for (const jobRow of [...encodingJobs, ...queuedJobs]) {
    deps.logger.info(
      {
        action: 'job_skipped',
        jobId: jobRow.id,
        fileId: jobRow.file_id,
        actorId,
        prevStatus: jobRow.status,
        viaCancelAll: true,
      },
      'job skipped via cancel-all',
    );
  }
  deps.logger.info(
    {
      action: 'queue_cancelled_all',
      actorId,
      skipped: encodingJobs.length,
      cancelled: queuedJobs.length,
      txCancelledChanges: txResult.cancelled,
      txFileChanges: txResult.fileChanges,
    },
    'cancelAllQueued: complete',
  );

  return { skipped: encodingJobs.length, cancelled: queuedJobs.length };
}

export function cancelJob(jobId: number): boolean {
  // In-flight: AbortController triggers SIGTERM → orchestrator catches AbortError
  // → markCancelled is called inside processOne. Return true; UI polls status.
  const ctrl = _activeControllers.get(jobId);
  if (ctrl) {
    ctrl.abort();
    return true;
  }
  // Queued (or encoding-but-not-in-map after recoverStaleEncoding race): mark
  // cancelled directly so the orchestrator skips it on next claimNext, and
  // revert the file row appropriately.
  //
  // 2026-04-27 bug fix: handle the pre-stage race where processOne has
  // already setStatus(file, 'encoding') but not yet registered the
  // AbortController. cancelJob falls to this queued-path; without flipping
  // file 'encoding' → 'interrupted' here, the file row stays orphaned in
  // 'encoding' even though the job is 'cancelled'. processOne's commit
  // path will additionally see markCompleted return null (SQL guard) and
  // take its own cleanup path; this defensive flip closes the gap when
  // processOne is killed before reaching markCompleted.
  const deps = _deps;
  const row = deps.jobRepo().markCancelled(jobId);
  if (!row) return false;
  try {
    const file = deps.fileRepo().getById(row.file_id);
    if (file && file.status === 'queued') {
      deps.fileRepo().setStatus(row.file_id, 'pending', file.version);
    } else if (file && file.status === 'encoding') {
      deps.fileRepo().setStatus(row.file_id, 'interrupted', file.version);
    }
  } catch (err) {
    deps.logger.warn(
      { jobId, fileId: row.file_id, err: err instanceof Error ? err.message : String(err) },
      'cancelJob: failed to revert file.status — operator may need to retry',
    );
  }
  try {
    deps.events.emit({
      type: 'job.cancelled',
      jobId,
      fileId: row.file_id,
    });
    emitQueueUpdated(deps);
  } catch {
    // best-effort
  }
  return true;
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
  );
}

function readSettings(deps: EngineDeps): {
  stageRoot: string;
  crf: number;
  minSavingsPercent: number;
  retentionDays: number;
  // 05-bonus: skip trash + hard-delete original after successful commit.
  // Default false → existing 02-02 behavior (trash + retention).
  deleteOriginalAfterEncode: boolean;
  // 05-bonus / 16-05: configurable output filename suffix. Default '-x265'
  // (post-16-05 / migration 0028). isDefaultOutputSuffix() recognizes both
  // the new default and the legacy '.x265.mkv' as defensive safety-net.
  outputSuffix: string;
  // 05-14: operator-selectable output container (AC-6: dispatch-boundary read).
  // The settings-read happens INSIDE this function which is called fresh at
  // every dispatch path — no module-level cache exists, in-flight jobs are
  // unaffected by mid-encode setting changes.
  // 05-15: widened to the 3-value setting union (mkv | mp4 | match-source).
  // The orchestrator dispatch resolves match-source to a concrete
  // OutputContainer (2-value) BEFORE threading through to runEncode.
  outputContainer: OutputContainerSetting;
  // 10-02 E-D3: when true, incompatible MP4 audio → auto-transcode to AAC.
  // When false (operator opt-out), retains 05-14 fail-fast behavior.
  audioAutoTranscode: boolean;
  // 26-02 (F5): output strategy. Default 'suffix' via code-fallback (byte-
  // identical). Guarded so any non-'replace' value → 'suffix'.
  outputMode: OutputMode;
  // 26-01 (F3): sidecar location mode + central root. Defaults via code-fallback
  // (no default-seed migration) → fresh/upgraded install is byte-identical (beside).
  sidecarMode: SidecarMode;
  sidecarCentralPath: string;
} {
  const settings = deps.settingRepo();
  const rawContainer = settings.get('output_container');
  const rawSidecarMode = settings.get('sidecar_mode');
  const rawOutputMode = settings.get('output_mode');
  return {
    // 24-03 (F2): DC-B auto-resolution chokepoint. PURE resolver — fresh
    // per-read so a late-mounting /mnt/cache is honoured at dispatch time.
    stageRoot: resolveEffectiveCachePath(settings.get('cache_pool_path')).effectivePath,
    crf: parseInt(settings.get('default_crf') ?? '23', 10),
    minSavingsPercent: parseInt(settings.get('min_savings_percent') ?? '5', 10),
    retentionDays: parseInt(settings.get('trash_retention_days') ?? '30', 10),
    deleteOriginalAfterEncode: settings.get('delete_original_after_encode') === 'true',
    outputSuffix: settings.get('output_suffix') ?? '-x265',
    outputContainer: isOutputContainerSetting(rawContainer) ? rawContainer : 'mkv',
    // Default 'true': absent setting → auto-transcode enabled (migration 0017 seeds 'true').
    audioAutoTranscode: settings.get('audio_auto_transcode_mp4') !== 'false',
    // 26-02 (F5): code-fallback default 'suffix' — guard so ANY non-'replace'
    // value (unset / legacy / typo) → 'suffix' = byte-identical to pre-26-02.
    outputMode: isOutputMode(rawOutputMode) ? rawOutputMode : 'suffix',
    // 26-01 (F3): code-fallback defaults — beside = byte-identical to pre-26-01.
    sidecarMode:
      rawSidecarMode === 'off' || rawSidecarMode === 'central' ? rawSidecarMode : 'beside',
    sidecarCentralPath: settings.get('sidecar_central_path') ?? '/config/x265-butler/sidecars/',
  };
}

// 16-05: dual-sentinel default-suffix detector. Returns true for either the
// NEW default ('-x265', migrated to from 0011's legacy default by 0028) OR
// the LEGACY default ('.x265.mkv', the 0011 seed value). Used by
// resolveOutputSuffix + cleanupSuffixesFor to identify "operator did not
// customize" without literal-string drift across call-sites.
//
// The LEGACY-recognition is the defensive safety-net for D1=β: 0028 should
// have migrated all '.x265.mkv' rows to '-x265', but cached settings readers
// during the migration window, manual DB-edits, or partial-apply scenarios
// could leave a row at the legacy value. Recognizing both keeps the
// orchestrator's auto-derive path robust.
export function isDefaultOutputSuffix(s: string): boolean {
  return s === '-x265' || s === '.x265.mkv';
}

// 16-05 (audit M2 rewrite): single composition site for the operator's
// output-suffix → final-suffix mapping. outputPathFor stays 1-arg and
// receives already-suffixed strings only. Three composition branches:
//   - operator-customized (label != either default): delegate to sanitizer
//     so label-style values get the container's BARE extension
//   - NEW default '-x265' (post-migration 0028 OR fresh-install): compose
//     '-x265' + bare ext, byte-identical to sanitizer output
//   - LEGACY default '.x265.mkv' (dual-sentinel safety-net): yield
//     extensionFor(container) — byte-identical to pre-16-05 behavior so any
//     half-migrated edge case still produces a working filename
export function resolveOutputSuffix(legacy: string, container: OutputContainer): string {
  if (legacy && !isDefaultOutputSuffix(legacy)) {
    return defaultStaging.sanitizeOutputSuffix(legacy, container);
  }
  if (legacy === '-x265') {
    return '-x265' + (container === 'mp4' ? '.mp4' : '.mkv');
  }
  // LEGACY default '.x265.mkv' (dual-sentinel safety-net per above).
  return extensionFor(container);
}

// 16-05 (audit M4 rewrite): cleanup paths must cover BOTH default styles
// whenever the persisted suffix is EITHER default sentinel, since:
//   (a) match-source dispatch can resolve to mkv OR mp4 mid-encode, and
//   (b) an install that upgraded from legacy may have filesystem orphans
//       in both styles ('-x265.{mkv,mp4}' NEW + '.x265.{mkv,mp4}' LEGACY).
// Operator-customized values short-circuit to the single custom suffix.
export function cleanupSuffixesFor(settings: ReturnType<typeof readSettings>): readonly string[] {
  const sfx = settings.outputSuffix;
  if (sfx && !isDefaultOutputSuffix(sfx)) {
    return [sfx];
  }
  if (settings.outputContainer === 'match-source') {
    return ['-x265.mkv', '-x265.mp4', '.x265.mkv', '.x265.mp4'];
  }
  // Explicit container — clean both default styles for THAT container only.
  const c = settings.outputContainer;
  return ['-x265' + (c === 'mp4' ? '.mp4' : '.mkv'), extensionFor(c)];
}

type FailContext = {
  job: JobRow;
  file?: FileRow;
  expectedFileVersion?: number;
  workDir?: string;
};

function failJob(
  deps: EngineDeps,
  ctx: FailContext,
  errorMsg: string,
  // CHECK constraint on job.exit_code is `NULL OR >= 0`. We use 0 as the
  // placeholder for "failed before any real exit code was produced"
  // (cache_pool_full, source_vanished, etc.). Real ffmpeg exit codes pass
  // through unchanged.
  exitCode = 0,
  logTail: string | null = null,
): void {
  const updated = deps.jobRepo().markFailed(ctx.job.id, {
    exit_code: exitCode,
    error_msg: errorMsg,
    log_tail: logTail,
  });
  if (ctx.file && ctx.expectedFileVersion !== undefined) {
    deps.fileRepo().setStatus(ctx.file.id, 'failed', ctx.expectedFileVersion);
  }
  if (ctx.workDir) {
    try {
      deps.staging.cleanupStage(ctx.workDir);
    } catch {
      // best-effort
    }
  }
  deps.logger.info(
    {
      action: 'job_transition',
      jobId: ctx.job.id,
      fileId: ctx.file?.id ?? ctx.job.file_id,
      transition: 'encoding→failed',
      cause: errorMsg,
      exitCode: updated?.exit_code ?? exitCode,
    },
    'job transition: encoding→failed',
  );
  // 02-03 Task 2: SSE event for the HTTP layer
  deps.events.emit({
    type: 'job.failed',
    jobId: ctx.job.id,
    fileId: ctx.file?.id ?? ctx.job.file_id,
    exitCode: updated?.exit_code ?? exitCode,
    errorMsg,
  });
  emitQueueUpdated(deps);
}

// Single-slot legacy entrypoint — preserved byte-identical for back-compat with
// existing 02-02 + 03-01 tests. Production scheduleNext path uses
// dispatchUntilFull → tryDispatchOne → processOne instead.
export async function loopOnce(): Promise<void> {
  const deps = _deps;

  const job = deps.jobRepo().claimNext();
  if (!job) return;

  // 03-02 audit-added: resolve encoder + reserve slot up-front so the slot map
  // is consistent with the in-flight job throughout processOne. For single-slot
  // legacy path the limits default to 1 each → behavior matches pre-03-02.
  const settingsAll = deps.settingRepo().getAll();
  const det = _detectionResult ?? (await deps.detectEncoders());
  const activeEncoder = resolveEncoderFor(job, settingsAll, det, deps);
  reserveSlot(job.id, activeEncoder);
  try {
    await processOne(job, activeEncoder, det, settingsAll);
  } finally {
    releaseSlot(job.id);
  }
}

// ── L1 (28-09): processOne phase-helpers ──────────────────────────────────
// processOne is a free async function (not a class method), so each phase is a
// module-level helper taking explicit params + returning a discriminated-union
// result the caller switches on. The pervasive `failJob(...); return;` early-exit
// is preserved BYTE-IDENTICAL: the helper calls failJob then returns a {kind}
// sentinel; the caller `return`s on it. assertNever makes a future-added `kind` a
// tsc error at the call-site (SR-1) rather than a silent success-path fall-through.
function assertNever(x: never): never {
  throw new Error(`unexpected discriminated result: ${JSON.stringify(x)}`);
}

type BeginEncodingResult =
  | { kind: 'fail' }
  | { kind: 'aborted' }
  | { kind: 'ok'; file: FileRow; fileVersionBeforeEncoding: number };

// beginEncoding — claim guard + queued→encoding transition + job.started emit.
// version-conflict path returns {kind:'aborted'} (caller just returns — NOT failJob).
function beginEncoding(
  deps: EngineDeps,
  job: JobRow,
  activeEncoder: EncoderId,
): BeginEncodingResult {
  const file = deps.fileRepo().getById(job.file_id);
  if (!file) {
    failJob(deps, { job }, 'file_not_found');
    return { kind: 'fail' };
  }

  const fileVersionBeforeEncoding = file.version;
  const ok = deps.fileRepo().setStatus(file.id, 'encoding', fileVersionBeforeEncoding);
  if (!ok) {
    deps.jobRepo().markCancelled(job.id);
    deps.logger.warn(
      {
        action: 'job_transition',
        jobId: job.id,
        fileId: file.id,
        transition: 'queued→cancelled',
        cause: 'file_version_conflict',
      },
      'file version conflict — another writer raced',
    );
    // 02-03 Task 2: queue.updated reflects the cancelled queued row
    emitQueueUpdated(deps);
    return { kind: 'aborted' };
  }

  // 03-01 audit M4: write resolved encoder back BEFORE any spawn so the column
  // reflects what actually ran.
  deps.jobRepo().setEncoder(job.id, activeEncoder);

  deps.logger.info(
    {
      action: 'job_transition',
      jobId: job.id,
      fileId: file.id,
      transition: 'queued→encoding',
      encoder: activeEncoder,
    },
    'job transition: queued→encoding',
  );
  // 02-03 Task 2: SSE event — UI shows "encoding..." indicator
  // audit-added S6: NO filePath — PII surface on unauthenticated v1.0 wire
  // 2026-04-27 hotfix: encoder included so ActiveSlotCard renders the badge
  deps.events.emit({
    type: 'job.started',
    jobId: job.id,
    fileId: file.id,
    encoder: activeEncoder,
  });

  return { kind: 'ok', file, fileVersionBeforeEncoding };
}

interface ResolveEncodeParamsResult {
  crfDispatch: number;
  presetDispatch: string;
}

// resolveEncodeParams — per-encoder crf + preset resolve/persist/log. No early returns.
function resolveEncodeParams(
  deps: EngineDeps,
  job: JobRow,
  activeEncoder: EncoderId,
  settings: ReturnType<typeof readSettings>,
  settingsAll: Record<string, string>,
): ResolveEncodeParamsResult {
  // 05-08 B4: persist resolved CRF alongside encoder. The per-encoder
  // settings.crf_<encoder> override (migration 0005) wins over default_crf so
  // operators can tune each path independently. crfForEncode below is the same
  // value passed to runEncode → guarantees DB row + ffmpeg invocation agree.
  const perEncoderCrfRawDispatch = settingsAll[`crf_${activeEncoder}`];
  const perEncoderCrfDispatch = perEncoderCrfRawDispatch
    ? parseInt(perEncoderCrfRawDispatch, 10)
    : settings.crf;
  const crfDispatch = Number.isFinite(perEncoderCrfDispatch) ? perEncoderCrfDispatch : settings.crf;
  deps.jobRepo().setCrf(job.id, crfDispatch);

  // 12-03 audit M4: symmetric per-encoder preset resolution at dispatch
  // boundary. Mirrors crf_<encoder> read. Out-of-Catalog (operator-edited DB
  // OR Catalog drift) → DEFAULT_PRESET_BY_ENCODER fallback + WARN log.
  const perEncoderPresetRawDispatch = settingsAll[`preset_${activeEncoder}`];
  const presetValid =
    typeof perEncoderPresetRawDispatch === 'string' &&
    isValidPreset(activeEncoder, perEncoderPresetRawDispatch);
  const presetDispatch = presetValid
    ? perEncoderPresetRawDispatch
    : DEFAULT_PRESET_BY_ENCODER[activeEncoder];
  const presetSource: 'settings' | 'fallback' = presetValid ? 'settings' : 'fallback';
  deps.logger.info(
    { jobId: job.id, encoder: activeEncoder, presetResolved: presetDispatch, presetSource },
    'dispatch_preset_resolved',
  );
  if (perEncoderPresetRawDispatch != null && !presetValid) {
    deps.logger.warn(
      {
        jobId: job.id,
        encoder: activeEncoder,
        requested: perEncoderPresetRawDispatch,
        fallback: presetDispatch,
      },
      'dispatch_preset_invalid_fallback',
    );
  }
  // 12-03 inline-extend Route-1 (migration 0025): persist resolved preset to
  // job row alongside setEncoder + setCrf — same boundary, same status guard.
  deps.jobRepo().setPresetUsed(job.id, presetDispatch);

  return { crfDispatch, presetDispatch };
}

type PreflightCachePoolResult =
  | { kind: 'fail' }
  | { kind: 'requeued' }
  | { kind: 'ok'; sourceSize: number };

// preflightCachePool — assertCachePoolWritable + source-stat + assertCachePoolFreeSpace.
// CachePoolPreFlightError → file re-queued pending ({kind:'requeued'}, caller just returns).
function preflightCachePool(
  deps: EngineDeps,
  job: JobRow,
  file: FileRow,
  settings: ReturnType<typeof readSettings>,
  expectedFileVersion: number,
): PreflightCachePoolResult {
  // 22-02 A (audit-revised 2026-05-24): lazy ensure cache_pool_path exists + is writable.
  try {
    deps.staging.assertCachePoolWritable(settings.stageRoot);
  } catch (err) {
    if (err instanceof CachePoolUnavailableError) {
      // audit-added M5: structured-log enrichment with cachePath + syscall BEFORE failJob.
      const syscall =
        err.cause && typeof err.cause === 'object' && 'syscall' in err.cause
          ? String((err.cause as { syscall: unknown }).syscall)
          : null;
      deps.logger.warn(
        {
          action: 'cache_pool_unavailable',
          cachePath: settings.stageRoot,
          code: err.code,
          syscall,
          jobId: job.id,
          fileId: file.id,
          phase: 'dispatch',
        },
        'cache_pool pre-flight failed — dispatch aborted',
      );
      failJob(deps, { job, file, expectedFileVersion }, `cache_pool_unavailable:${err.code}`);
      return { kind: 'fail' };
    }
    const msg = err instanceof Error ? err.message : 'invalid_cache_pool_path';
    failJob(deps, { job, file, expectedFileVersion }, msg);
    return { kind: 'fail' };
  }

  // audit-added M2: source-vanished pre-stage check
  let sourceSize: number;
  try {
    sourceSize = deps.fs.statSync(file.path).size;
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : 'unknown';
    const msg = code === 'ENOENT' ? 'source_vanished' : `stat_source:${code}`;
    deps.logger.warn(
      {
        action: code === 'ENOENT' ? 'source_vanished' : 'stat_source',
        jobId: job.id,
        fileId: file.id,
        path: file.path,
      },
      'source-stat failed pre-stage',
    );
    failJob(deps, { job, file, expectedFileVersion }, msg);
    return { kind: 'fail' };
  }

  // 10-02 C5: cache-pool free-space pre-flight via staging helper.
  try {
    assertCachePoolFreeSpace(sourceSize, {
      cooldownKey: String(file.id),
      cachePoolPath: settings.stageRoot,
      statfsSync: deps.fs.statfsSync as (path: string) => {
        bavail: number | bigint;
        bsize: number | bigint;
      },
    });
  } catch (err) {
    if (err instanceof CachePoolPreFlightError) {
      deps.logger.warn(
        {
          action: 'cache_pool_full',
          jobId: job.id,
          fileId: file.id,
          availableBytes: err.availableBytes,
          requiredBytes: err.requiredBytes,
          sourceSize,
          stageRoot: settings.stageRoot,
        },
        'cache pool full — file re-queued as pending',
      );
      // C5: job fails, file stays pending for next dispatch cycle.
      deps
        .jobRepo()
        .markFailed(job.id, { exit_code: 0, error_msg: 'cache_pool_full', log_tail: null });
      deps.fileRepo().setStatus(file.id, 'pending', expectedFileVersion);
      return { kind: 'requeued' };
    }
    if (err instanceof CachePoolConfigError) {
      failJob(deps, { job, file, expectedFileVersion }, `cache_pool_config:${err.message}`);
      return { kind: 'fail' };
    }
    // 22-02 A (audit-revised 2026-05-24): remap downstream statfs catch to
    // cache_pool_unavailable for operator-actionable consistency.
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : 'unknown';
    const syscall =
      err && typeof err === 'object' && 'syscall' in err
        ? String((err as { syscall: unknown }).syscall)
        : null;
    // audit-added M5: structured-log enrichment with cachePath BEFORE failJob.
    deps.logger.warn(
      {
        action: 'cache_pool_unavailable',
        cachePath: settings.stageRoot,
        code,
        syscall,
        jobId: job.id,
        fileId: file.id,
        phase: 'statfs-late',
      },
      'cache_pool statfs failed mid-dispatch — mount disappeared between pre-flight and free-space check',
    );
    failJob(deps, { job, file, expectedFileVersion }, `cache_pool_unavailable:${code}`);
    return { kind: 'fail' };
  }

  return { kind: 'ok', sourceSize };
}

interface ContainerCompat {
  effectiveContainer: OutputContainer;
  isMatchSource: boolean;
  forceContainer: OutputContainer | null;
  dropIncompatibleSubtitles: boolean;
  droppedSubtitleCount: number | undefined;
  droppedSubtitleCodecs: ReadonlyArray<string> | undefined;
  audioPerStreamTargets: ReadonlyArray<AudioAutoTranscodeTarget> | undefined;
  containerFallbackRecord: ContainerFallbackRecord | undefined;
  preflightSourceProbe: ProbeResult | null;
}
type ResolveContainerAndCompatResult = { kind: 'fail' } | ({ kind: 'ok' } & ContainerCompat);

// resolveContainerAndCompat — forceContainer + effectiveContainer (match-source) +
// the MP4 source pre-flight ffprobe (P4 RETIRED — STAYS HERE, AC-4) + audio/subtitle
// analysis. The mp4 audio fail_fast path is the one hard-fail → {kind:'fail'} (the
// plan text said "no hard-fail returns"; the source's fail_fast at orchestrator.ts:1225
// is preserved byte-identical via a discriminated fail result — see SUMMARY).
async function resolveContainerAndCompat(
  deps: EngineDeps,
  job: JobRow,
  file: FileRow,
  settings: ReturnType<typeof readSettings>,
  expectedFileVersion: number,
): Promise<ResolveContainerAndCompatResult> {
  // 10-03 E-D5: forceContainer from retry API overrides all other settings.
  const forceContainer =
    typeof job.force_container === 'string' && isOutputContainer(job.force_container)
      ? job.force_container
      : null;
  if (forceContainer !== null) {
    deps.logger.info(
      {
        action: 'job_retry_force_container',
        jobId: job.id,
        fileId: file.id,
        forceContainer,
      },
      'E-D5: forceContainer override active — bypassing container_override + output_container',
    );
  }

  // 05-15: resolve match-source directive to a concrete OutputContainer at
  // the dispatch boundary BEFORE pre-flight.
  // 10-02 E-D1: per-file container_override (NULL = inherit global setting).
  const fileOverride = file.container_override;
  const resolvedContainerSetting: OutputContainerSetting =
    forceContainer !== null
      ? forceContainer // E-D5: forceContainer beats file override + global setting
      : fileOverride !== null && isOutputContainerSetting(fileOverride)
        ? fileOverride
        : settings.outputContainer;
  const isMatchSource = resolvedContainerSetting === 'match-source';
  let effectiveContainer: OutputContainer =
    resolvedContainerSetting === 'match-source'
      ? resolveContainerFromSource(file.path)
      : resolvedContainerSetting;

  // 05-14 (audit G3 + AC-11/AC-12): MP4 source pre-flight. ffprobe the SOURCE
  // file at the dispatch boundary to detect mp4-muxer-incompatible audio/subs.
  // 05-15 (AC-5/6/12): under match-source, every MP4-incompat surface auto-
  // falls back to MKV. No source ffprobe runs when the resolved container is MKV.
  let dropIncompatibleSubtitles = false;
  let droppedSubtitleCount: number | undefined;
  let droppedSubtitleCodecs: ReadonlyArray<string> | undefined;
  // 10-02 E-D3: per-stream audio transcode targets (auto_transcode outcome only).
  let audioPerStreamTargets: ReadonlyArray<AudioAutoTranscodeTarget> | undefined;
  // 10-03 E-D5: containerFallback record — set at each mp4→mkv fallback site.
  let containerFallbackRecord: ContainerFallbackRecord | undefined;
  // 10-02 E-D3: hoisted so sidecar emission can build V3 with source metadata.
  let preflightSourceProbe: ProbeResult | null = null;
  if (effectiveContainer === 'mp4') {
    preflightSourceProbe = await deps.ffprobe(file.path);
    const sourceProbe = preflightSourceProbe;
    if (sourceProbe) {
      // 10-02 E-D3: audio branch with discriminated union outcome.
      const audioAnalysis = analyzeAudioStreams(sourceProbe, 'mp4', {
        autoTranscode: settings.audioAutoTranscode,
        isMatchSource,
      });
      if (audioAnalysis.outcome === 'fallback_to_mkv') {
        deps.logger.warn(
          {
            action: 'mp4_fallback_to_mkv',
            jobId: job.id,
            fileId: file.id,
            sourcePath: file.path,
            fallbackReason: 'audio',
            from: 'mp4',
            to: 'mkv',
            allIncompatibleCodecs: audioAnalysis.droppedCodecs,
          },
          'match-source dispatch: audio codec cannot be muxed into mp4 — falling back to mkv',
        );
        containerFallbackRecord = { reason: 'audio', from: 'mp4', to: 'mkv' };
        effectiveContainer = 'mkv';
      } else if (audioAnalysis.outcome === 'fail_fast') {
        const firstCodec = audioAnalysis.droppedCodecs[0] ?? 'unknown';
        const errorMsg = `mp4_audio_codec_incompatible:${firstCodec}`;
        deps.logger.warn(
          {
            action: 'mp4_audio_codec_incompatible',
            jobId: job.id,
            fileId: file.id,
            codec_name: firstCodec,
            container: 'mp4',
            preflightDecision: 'fail-fast',
            allIncompatibleCodecs: audioAnalysis.droppedCodecs,
          },
          'mp4 dispatch fail-fast: source audio codec cannot be muxed into mp4',
        );
        failJob(deps, { job, file, expectedFileVersion }, errorMsg);
        return { kind: 'fail' };
      } else if (audioAnalysis.outcome === 'auto_transcode') {
        audioPerStreamTargets = audioAnalysis.perStreamTargets;
        deps.logger.info(
          {
            action: 'mp4_audio_auto_transcode',
            jobId: job.id,
            fileId: file.id,
            streams: audioPerStreamTargets.map((t) => ({
              idx: t.sourceStreamIndex,
              from: t.fromCodec,
              to: t.action,
              bitrate: t.bitrate,
            })),
          },
          'mp4 audio auto-transcode: incompatible streams will be transcoded to AAC',
        );
      }
      // Subtitle branch — inspected whenever effectiveContainer is still 'mp4'.
      if (effectiveContainer === 'mp4') {
        const subtitleAnalysis = analyzeStreams(sourceProbe, 'mp4');
        if (subtitleAnalysis.hasIncompatibleSubs) {
          if (isMatchSource) {
            deps.logger.warn(
              {
                action: 'mp4_fallback_to_mkv',
                jobId: job.id,
                fileId: file.id,
                sourcePath: file.path,
                fallbackReason: 'subtitle',
                from: 'mp4',
                to: 'mkv',
                allIncompatibleCodecs: subtitleAnalysis.droppedCodecs,
              },
              'match-source dispatch: subtitle codec cannot be muxed into mp4 — falling back to mkv',
            );
            containerFallbackRecord = { reason: 'subtitle', from: 'mp4', to: 'mkv' };
            effectiveContainer = 'mkv';
          } else {
            dropIncompatibleSubtitles = true;
            droppedSubtitleCount = subtitleAnalysis.incompatibleSubtitleStreams.length;
            droppedSubtitleCodecs = subtitleAnalysis.droppedCodecs;
          }
        }
      }
    } else if (isMatchSource) {
      // 05-15 audit M3: ffprobe-null on a match-source-resolved-to-mp4 source
      // is a defensive fallback to MKV.
      deps.logger.warn(
        {
          action: 'mp4_fallback_to_mkv',
          jobId: job.id,
          fileId: file.id,
          sourcePath: file.path,
          fallbackReason: 'preflight_unavailable',
          from: 'mp4',
          to: 'mkv',
          allIncompatibleCodecs: [],
        },
        'match-source dispatch: ffprobe returned null — falling back to mkv',
      );
      containerFallbackRecord = { reason: 'preflight_unavailable', from: 'mp4', to: 'mkv' };
      effectiveContainer = 'mkv';
    } else {
      // ffprobe returned null on explicit-mp4 — not a hard failure; soft-degrade.
      deps.logger.warn(
        {
          action: 'mp4_preflight_ffprobe_unavailable',
          jobId: job.id,
          fileId: file.id,
          container: 'mp4',
        },
        'mp4 dispatch pre-flight: ffprobe returned null — proceeding without compat analysis',
      );
    }
  }

  return {
    kind: 'ok',
    effectiveContainer,
    isMatchSource,
    forceContainer,
    dropIncompatibleSubtitles,
    droppedSubtitleCount,
    droppedSubtitleCodecs,
    audioPerStreamTargets,
    containerFallbackRecord,
    preflightSourceProbe,
  };
}

interface OutputTarget {
  effectiveMode: OutputMode;
  replaceHardlinkFallback: boolean;
  finalOutputPath: string;
  replaceTargetIsOriginal: boolean;
}
type ResolveOutputTargetResult = { kind: 'fail' } | ({ kind: 'ok' } & OutputTarget);

// resolveOutputTarget — effectiveMode + dispatch-time replace_skipped_hardlink
// fallback + finalOutputPath + output_path_exists collision guard.
function resolveOutputTarget(
  deps: EngineDeps,
  job: JobRow,
  file: FileRow,
  settings: ReturnType<typeof readSettings>,
  effectiveContainer: OutputContainer,
  resolvedSuffix: string,
  expectedFileVersion: number,
): ResolveOutputTargetResult {
  // 26-02 (F5): resolve the EFFECTIVE per-file output mode. Starts at the global
  // setting, but a 'replace' on a HARDLINKED source degrades to 'suffix' AND
  // sets replaceHardlinkFallback (AC-5): trashing or renaming-over a hardlinked
  // file would break the OTHER link. The fallback writes the '-x265' sibling and
  // leaves the original UNTOUCHED. A second TOCTOU re-probe runs at the commit step.
  let effectiveMode: OutputMode = settings.outputMode;
  let replaceHardlinkFallback = false;
  if (effectiveMode === 'replace') {
    let nlink = 1;
    let statOk = true;
    try {
      nlink = deps.fs.statSync(file.path).nlink;
    } catch (err) {
      // statSync failure → defensive suffix-fallback (never throw the job here).
      statOk = false;
      effectiveMode = 'suffix';
      replaceHardlinkFallback = true;
      deps.logger.warn(
        {
          action: 'replace_skipped_hardlink',
          reason: 'stat_failed',
          jobId: job.id,
          fileId: file.id,
          path: file.path,
          err: err instanceof Error ? err.message : String(err),
        },
        'replace mode: statSync failed at dispatch — falling back to suffix mode, leaving original intact',
      );
    }
    if (statOk && nlink > 1) {
      effectiveMode = 'suffix';
      replaceHardlinkFallback = true;
      deps.logger.warn(
        {
          action: 'replace_skipped_hardlink',
          reason: 'dispatch',
          jobId: job.id,
          fileId: file.id,
          nlink,
          path: file.path,
        },
        'replace mode: source is hardlinked (nlink>1) — falling back to suffix mode, leaving original intact to avoid breaking the other link',
      );
    }
  }

  // audit-added S1: pre-encode output-path collision check (before any spawn).
  // 26-02: `let` because the commit-step TOCTOU hardlink fallback reassigns it.
  const finalOutputPath =
    effectiveMode === 'replace'
      ? deps.staging.replaceOutputPathFor(file.path, effectiveContainer)
      : deps.staging.outputPathFor(file.path, resolvedSuffix);
  // 26-02 (F5): for replace SAME-EXT the finalOutputPath IS the original.
  const replaceTargetIsOriginal = effectiveMode === 'replace' && finalOutputPath === file.path;
  if (!replaceTargetIsOriginal && deps.fs.existsSync(finalOutputPath)) {
    deps.logger.warn(
      { action: 'output_path_exists', jobId: job.id, fileId: file.id, finalOutputPath },
      'output path exists — refusing to encode',
    );
    failJob(deps, { job, file, expectedFileVersion }, 'output_path_exists');
    return { kind: 'fail' };
  }

  return {
    kind: 'ok',
    effectiveMode,
    replaceHardlinkFallback,
    finalOutputPath,
    replaceTargetIsOriginal,
  };
}

// processOne — runs the per-job state machine after the job has been claimed
// AND its slot reserved. Phase 2 + 03-01 logic preserved byte-identical
// (state machine, recover, pre-stage gates, encode, verify, commit, terminal
// transitions). Caller (loopOnce or tryDispatchOne) owns slot lifecycle.
async function processOne(
  job: JobRow,
  activeEncoder: EncoderId,
  det: DetectionResult,
  settingsAll: Record<string, string>,
): Promise<void> {
  const deps = _deps;

  const begin = beginEncoding(deps, job, activeEncoder);
  switch (begin.kind) {
    case 'fail':
    case 'aborted':
      return;
    case 'ok':
      break;
    default:
      return assertNever(begin);
  }
  const { file, fileVersionBeforeEncoding } = begin;

  const expectedFileVersion = fileVersionBeforeEncoding + 1;
  const settings = readSettings(deps);

  const { crfDispatch, presetDispatch } = resolveEncodeParams(
    deps,
    job,
    activeEncoder,
    settings,
    settingsAll,
  );

  const preflight = preflightCachePool(deps, job, file, settings, expectedFileVersion);
  switch (preflight.kind) {
    case 'fail':
    case 'requeued':
      return;
    case 'ok':
      break;
    default:
      return assertNever(preflight);
  }
  const { sourceSize } = preflight;

  const compat = await resolveContainerAndCompat(deps, job, file, settings, expectedFileVersion);
  switch (compat.kind) {
    case 'fail':
      return;
    case 'ok':
      break;
    default:
      return assertNever(compat);
  }
  const {
    effectiveContainer,
    dropIncompatibleSubtitles,
    droppedSubtitleCount,
    droppedSubtitleCodecs,
    audioPerStreamTargets,
    containerFallbackRecord,
    preflightSourceProbe,
  } = compat;

  // 05-14 + 05-15 (audit M2 RE-ORDER): legacy `output_suffix` precedence vs
  // container-derived suffix. MUST run AFTER pre-flight because under
  // match-source the effectiveContainer can flip mid-pre-flight.
  const resolvedSuffix = resolveOutputSuffix(settings.outputSuffix, effectiveContainer);

  const target = resolveOutputTarget(
    deps,
    job,
    file,
    settings,
    effectiveContainer,
    resolvedSuffix,
    expectedFileVersion,
  );
  switch (target.kind) {
    case 'fail':
      return;
    case 'ok':
      break;
    default:
      return assertNever(target);
  }
  // 28-09 SR-4: effectiveMode/replaceHardlinkFallback/finalOutputPath are NOT
  // reassigned in processOne — the commit-step TOCTOU reassignment is local to
  // commitEncodeResult (passed by value). const here proves no post-helper read.
  const { effectiveMode, replaceHardlinkFallback, finalOutputPath } = target;

  const crfForEncode = crfDispatch;
  const stage = await runEncodeStage(deps, job, file, settings, expectedFileVersion, {
    activeEncoder,
    effectiveContainer,
    crfForEncode,
    presetDispatch,
    det,
    dropIncompatibleSubtitles,
    droppedSubtitleCount,
    droppedSubtitleCodecs,
    audioPerStreamTargets,
    finalOutputPath,
  });
  switch (stage.kind) {
    case 'fail':
    case 'cancelled':
      return;
    case 'ok':
      break;
    default:
      return assertNever(stage);
  }
  const { workDir, stageOut, encodeResult, commitNowIso, gitHash } = stage;

  const verify = await verifyOutput(
    deps,
    job,
    file,
    stageOut,
    sourceSize,
    settings,
    expectedFileVersion,
    workDir,
  );
  switch (verify.kind) {
    case 'fail':
    case 'cancelled':
      return;
    case 'ok':
      break;
    default:
      return assertNever(verify);
  }
  const { outputSize, verdict } = verify;

  // 05-13 AC-4 invariant: hash the staged output BEFORE any cleanup branch.
  // For done-not-worth / done-larger, the output is discarded via cleanupStage;
  // the sidecar still needs to record output.contentHash + output.sizeBytes
  // for forensic reconstruction. For done-smaller, we hash stageOut before
  // commitOutput renames the file (basenames are identical so the resulting
  // payload describes the final committed file accurately). Hash failure is
  // soft-degraded: sidecarPayload stays null, encode commit continues.
  let outputContentHash: string | null = null;
  try {
    outputContentHash = await deps.hashFile(stageOut);
  } catch (err) {
    deps.logger.warn(
      {
        action: 'output_hash_failed',
        jobId: job.id,
        fileId: file.id,
        err: err instanceof Error ? err.message : String(err),
      },
      'output hash failed — sidecar payload will not be written; encode commit continues',
    );
  }

  await commitEncodeResult(deps, job, file, {
    activeEncoder,
    crfForEncode,
    outputContentHash,
    sourceSize,
    outputSize,
    verdict,
    effectiveMode,
    replaceHardlinkFallback,
    finalOutputPath,
    resolvedSuffix,
    preflightSourceProbe,
    audioPerStreamTargets,
    containerFallbackRecord,
    encodeResult,
    stageOut,
    commitNowIso,
    gitHash,
    settings,
    workDir,
    expectedFileVersion,
  });
}

// commitEncodeResult — the sidecar-payload build + bench-bypass early-return +
// the data-loss-CRITICAL verdict-dispatch (trash-first→atomic-rename replace, the
// TOCTOU nlink suffix-degrade, zero-unlink replace, replace-always-trashes, the
// replace_commit_failed_original_trashed dedicated error, and the audit-M1
// writeSidecar→setStatus→markCompleted→log+SSE ORDER). Moved as a COHESIVE UNIT,
// byte-identical (AC-3). effectiveMode/finalOutputPath/replaceHardlinkFallback are
// passed BY VALUE — reassigned only inside the commit TOCTOU branch, and processOne
// reads NONE of them after this call (SR-4 grep-gated), so by-value is byte-identical.
interface CommitEncodeResultCtx {
  activeEncoder: EncoderId;
  crfForEncode: number;
  outputContentHash: string | null;
  sourceSize: number;
  outputSize: number;
  verdict: 'done-smaller' | 'done-not-worth' | 'done-larger';
  effectiveMode: OutputMode;
  replaceHardlinkFallback: boolean;
  finalOutputPath: string;
  resolvedSuffix: string;
  preflightSourceProbe: ProbeResult | null;
  audioPerStreamTargets: ReadonlyArray<AudioAutoTranscodeTarget> | undefined;
  containerFallbackRecord: ContainerFallbackRecord | undefined;
  encodeResult: EncodeResult;
  stageOut: string;
  commitNowIso: string;
  gitHash: string;
  settings: ReturnType<typeof readSettings>;
  workDir: string;
  expectedFileVersion: number;
}

async function commitEncodeResult(
  deps: EngineDeps,
  job: JobRow,
  file: FileRow,
  ctx: CommitEncodeResultCtx,
): Promise<void> {
  const {
    activeEncoder,
    crfForEncode,
    outputContentHash,
    sourceSize,
    outputSize,
    verdict,
    resolvedSuffix,
    preflightSourceProbe,
    audioPerStreamTargets,
    containerFallbackRecord,
    encodeResult,
    stageOut,
    commitNowIso,
    gitHash,
    settings,
    workDir,
    expectedFileVersion,
  } = ctx;
  // effectiveMode/finalOutputPath/replaceHardlinkFallback reassigned in the TOCTOU branch.
  let { effectiveMode, replaceHardlinkFallback, finalOutputPath } = ctx;

  // 05-13: build sidecar payload ONCE with explicit outcome (audit M1 ORDER —
  // payload built once, written at the right call site per verdict). Encoder
  // / CRF preconditions (existing 05-08 B4 V2 contract) skip the payload
  // build; downstream branches treat null as "no sidecar this run".
  let sidecarPayload: SidecarV2 | SidecarV3 | null = null;
  const encoderName = encoderNameFor(activeEncoder);
  if (!encoderName) {
    deps.logger.warn(
      {
        action: 'sidecar_write_skipped_unknown_encoder',
        jobId: job.id,
        fileId: file.id,
        activeEncoder,
      },
      'sidecar write skipped — encoder not mappable to EncoderName',
    );
  } else if (!Number.isInteger(crfForEncode) || crfForEncode < 0 || crfForEncode > 51) {
    deps.logger.warn(
      {
        action: 'sidecar_write_skipped_missing_crf',
        jobId: job.id,
        fileId: file.id,
        crfForEncode,
      },
      'sidecar write skipped — crfForEncode outside 0..51',
    );
  } else if (outputContentHash !== null) {
    const versionInfo = getVersionInfo();
    // 10-02 E-D3: upgrade to V3 when audio auto-transcode was active AND
    // preflightSourceProbe has the required fields (codec, dimensions, duration).
    // V3 requires durationSec on source — fall back to V2 when probe missing.
    if (
      (audioPerStreamTargets ?? containerFallbackRecord) &&
      preflightSourceProbe &&
      typeof preflightSourceProbe.codec === 'string' &&
      typeof preflightSourceProbe.width === 'number' &&
      typeof preflightSourceProbe.height === 'number' &&
      typeof preflightSourceProbe.durationSeconds === 'number'
    ) {
      const savingsBytes = sourceSize - outputSize;
      const audioTranscode: AudioTranscodeRecord[] = (audioPerStreamTargets ?? [])
        .filter((t) => t.action === 'aac')
        .map((t) => ({
          sourceStreamIndex: t.sourceStreamIndex,
          fromCodec: t.fromCodec,
          toCodec: 'aac' as const,
          bitrate: t.bitrate ?? 192000,
        }));
      const v3payload: SidecarV3 = {
        schema: 'x265-butler/v3',
        processedBy: 'x265-butler',
        version: versionInfo.version,
        gitHash,
        processedAt: commitNowIso,
        durationSec: encodeResult.durationMs / 1000,
        source: {
          filename: path.basename(file.path),
          contentHash: file.content_hash,
          sizeBytes: sourceSize,
          codec: preflightSourceProbe.codec,
          width: preflightSourceProbe.width,
          height: preflightSourceProbe.height,
          durationSec: preflightSourceProbe.durationSeconds,
        },
        output: {
          filename: path.basename(finalOutputPath),
          contentHash: outputContentHash,
          sizeBytes: outputSize,
        },
        savings: {
          bytes: savingsBytes,
          ratio: sourceSize > 0 ? savingsBytes / sourceSize : 0,
          thresholdUsed: settings.minSavingsPercent / 100,
        },
        encoder: {
          name: encoderName,
          preset: String(crfForEncode),
          ffmpegVersion: 'unknown',
        },
        quality: { mode: qualityModeFor(encoderName), value: crfForEncode },
        outcome: verdict,
        audioTranscode: audioTranscode.length > 0 ? audioTranscode : undefined,
        containerFallback: containerFallbackRecord,
      };
      sidecarPayload = v3payload;
    } else {
      sidecarPayload = {
        schema: 'x265-butler/v2',
        processedBy: 'x265-butler',
        version: versionInfo.version,
        gitHash,
        processedAt: commitNowIso,
        source: {
          filename: path.basename(file.path),
          contentHash: file.content_hash,
          sizeBytes: sourceSize,
        },
        output: {
          filename: path.basename(finalOutputPath),
          contentHash: outputContentHash,
          sizeBytes: outputSize,
        },
        encoder: encoderName,
        quality: { mode: qualityModeFor(encoderName), value: crfForEncode },
        // 05-13 audit M1: outcome ALWAYS set on 05-13 emissions.
        outcome: verdict,
      };
    }
  }

  // 10-01 BENCH-CHANNEL-BYPASS: skip all commit-step side effects for bench
  // samples. P11 will wire the real dispatch path; _benchSampleJobIds is
  // populated via __forTests_markJobAsBenchSample during test runs.
  if (_benchSampleJobIds.has(job.id)) {
    const savingsBytes = sourceSize - outputSize;
    const savingsRatio = sourceSize > 0 ? savingsBytes / sourceSize : 0;
    deps.logger.info(
      {
        action: 'bench_sample_bypass',
        jobId: job.id,
        filePath: file.path,
        sourcePath: file.path,
        sourceSizeBytes: sourceSize,
        outputPath: finalOutputPath,
        outputSizeBytes: outputSize,
        encoder: encoderName ?? String(activeEncoder),
        preset: String(crfForEncode ?? 'unset'),
        durationSec: encodeResult.durationMs / 1000,
        savingsBytes,
        savingsRatio,
      },
      'bench sample bypass — commit-step skipped; no DB write',
    );
    deps.staging.cleanupStage(workDir);
    return;
  }

  try {
    if (verdict === 'done-smaller') {
      // 31-02: capture the source {atime,mtime} HERE — at the TOP of done-smaller,
      // BEFORE any trash/rename. Replace trashes the original FIRST (see below), so
      // a late capture would stat a vanished file. The captured stamps are applied
      // to the committed output after the commit if/else (cosmetic, best-effort).
      let sourceTimes: { atime: Date; mtime: Date } | null = null;
      try {
        const st = deps.fs.statSync(file.path);
        sourceTimes = { atime: st.atime, mtime: st.mtime };
      } catch (err) {
        // audit-added (SR-1): capture runs BEFORE any trash — the source MUST still
        // exist here, so a stat failure is a genuine anomaly, not an expected branch.
        // Leave a forensic breadcrumb (best-effort, NEVER throw) instead of swallowing
        // silently; sourceTimes stays null → the apply step below no-ops (no stamp).
        sourceTimes = null; // soft-degrade: source vanished/unreadable → skip stamp
        deps.logger.warn(
          {
            action: 'output_mtime_capture_failed',
            jobId: job.id,
            fileId: file.id,
            sourcePath: file.path,
            err: err instanceof Error ? err.message : String(err),
          },
          'source mtime capture failed before commit — output will keep its fresh mtime; encode unaffected',
        );
      }

      // 05-13 KEEP path — output committed, sidecar at OUTPUT-path.
      // 26-02 (F5): branch on the EFFECTIVE per-file output mode.
      if (effectiveMode === 'replace') {
        // 26-02 REPLACE — trash-original-FIRST → atomic-rename. Data-loss-safe
        // ordering (AC-3/AC-6): a kill between trash and rename leaves the
        // original in trash (recoverable) + the staged output in workDir
        // (discardable) — there is NEVER a both-gone window. This entire branch
        // contains ZERO fs.unlinkSync (AC-11/M2): replace ALWAYS trashes
        // (recoverability is mandatory for a one-way-door), so
        // delete_original_after_encode is deliberately IGNORED here. The suffix
        // unlink path lives only in the else-branch below — structurally
        // unreachable from replace.

        // S1 TOCTOU re-probe: a hardlink can appear mid-encode (Sonarr/Radarr
        // "Use Hardlinks" import during the multi-minute encode). Re-probe nlink
        // HERE, not only at dispatch. nlink>1 NOW → abandon replace: commit to
        // the '-x265' suffix path and LEAVE the original intact (AC-5 parity —
        // never trash or rename-over a hardlinked file), and SKIP the trash-first
        // replace ordering. NO unlink anywhere here (AC-11).
        let toctouHardlink = false;
        try {
          if (deps.fs.statSync(file.path).nlink > 1) toctouHardlink = true;
        } catch {
          // stat failure mid-commit → defensive suffix-fallback; never throw here.
          toctouHardlink = true;
        }

        if (toctouHardlink) {
          const suffixPath = deps.staging.outputPathFor(file.path, resolvedSuffix);
          deps.logger.warn(
            {
              action: 'replace_skipped_hardlink',
              reason: 'commit_toctou',
              jobId: job.id,
              fileId: file.id,
              path: file.path,
              suffixPath,
            },
            'replace mode: source became hardlinked during encode — committing to suffix path + leaving original intact instead of rename-over',
          );
          deps.staging.commitOutput(stageOut, suffixPath);
          // Downstream sidecar + forensic logs follow the ACTUAL committed path
          // + mode (the job degraded to suffix — report the truth, not 'replace').
          // replaceHardlinkFallback → the suffix else-branch leaves the original
          // intact (the other hardlink survives; no trash, no unlink).
          finalOutputPath = suffixPath;
          effectiveMode = 'suffix';
          replaceHardlinkFallback = true;
        } else {
          // True replace: TRASH original FIRST (frees the basename slot + writes
          // the durable recovery row), THEN rename the staged output into it.
          const trashedAt = deps.now();
          const trashPath = deps.staging.trashPathFor(
            file.path,
            settings.stageRoot,
            job.id,
            trashedAt,
          );
          deps.staging.trashOriginal(file.path, trashPath);
          const trashRow = deps.trashRepo().create({
            file_id: file.id,
            original_path: file.path,
            trash_path: trashPath,
            size_bytes: sourceSize,
            retention_days: settings.retentionDays,
          });
          try {
            // commitOutput's internal existsSync guard now passes (slot freed by
            // the trash-rename). Same-ext: renames into the exact original path;
            // diff-ext: into the sibling basename.
            deps.staging.commitOutput(stageOut, finalOutputPath);
          } catch (commitErr) {
            // M1/AC-12: commit failed AFTER the original was trashed (ENOSPC /
            // EROFS / EXDEV-copy failure on the destination). The trash row is
            // the durable recovery record — do NOT attempt a fragile multi-step
            // rollback (a rename-back can itself fail mid-way). Emit a DEDICATED
            // error BEFORE re-throwing into the top-level failJob catch so the
            // operator/diagnostics surface knows the original is in trash
            // (recoverable) and the destination basename may be empty. The
            // generic `terminal:${msg}` alone is insufficient for a data-loss
            // feature.
            deps.logger.error(
              {
                action: 'replace_commit_failed_original_trashed',
                jobId: job.id,
                fileId: file.id,
                originalPath: file.path,
                trashPath,
                trashId: trashRow?.id ?? null,
                err: commitErr instanceof Error ? commitErr.message : String(commitErr),
              },
              'replace commit failed AFTER original trashed — original recoverable via trash row; destination basename may be empty',
            );
            throw commitErr;
          }
        }
      } else {
        // 26-02 SUFFIX path (effectiveMode !== 'replace') — BYTE-IDENTICAL to
        // pre-26-02 (AC-1 sentinel). commitOutput → delete_original_after_encode
        // ? unlink : trash. This is the ONLY branch containing fs.unlinkSync.
        deps.staging.commitOutput(stageOut, finalOutputPath);
        // 26-02 (F5, AC-5): a replace job that degraded to suffix because the
        // source is HARDLINKED leaves the original UNTOUCHED — neither trashed
        // nor unlinked — so the other link survives intact. The '-x265' sibling
        // is the only new artifact. This guard is reachable ONLY from a
        // replace→suffix degrade (replaceHardlinkFallback); a genuine suffix job
        // always has it false → byte-identical pre-26-02 behavior (AC-1).
        if (replaceHardlinkFallback) {
          deps.logger.info(
            {
              action: 'replace_hardlink_original_kept',
              jobId: job.id,
              fileId: file.id,
              originalPath: file.path,
              outputPath: finalOutputPath,
            },
            'hardlinked source kept in place (replace→suffix degrade); -x265 sibling written',
          );
        } else if (settings.deleteOriginalAfterEncode) {
          // 05-bonus: branch on operator's delete_original_after_encode setting.
          // Default false → trash + retention (existing 02-02 behavior).
          // True → hard-delete the original via fs.unlink. NO trash row created;
          // FK CASCADE remains intact since we only delete the disk file, not
          // the file row itself (status flips to done-smaller below).
          try {
            deps.fs.unlinkSync(file.path);
            deps.logger.info(
              {
                action: 'original_deleted_post_encode',
                jobId: job.id,
                fileId: file.id,
                originalPath: file.path,
                sizeBytes: sourceSize,
              },
              'original deleted (delete_original_after_encode=true)',
            );
          } catch (err) {
            deps.logger.warn(
              {
                action: 'original_delete_failed',
                jobId: job.id,
                fileId: file.id,
                originalPath: file.path,
                err: err instanceof Error ? err.message : String(err),
              },
              'original delete failed — leaving original in place',
            );
          }
        } else {
          // TRASH (existing 02-02 path).
          const trashedAt = deps.now();
          const trashPath = deps.staging.trashPathFor(
            file.path,
            settings.stageRoot,
            job.id,
            trashedAt,
          );
          deps.staging.trashOriginal(file.path, trashPath);
          deps.trashRepo().create({
            file_id: file.id,
            original_path: file.path,
            trash_path: trashPath,
            size_bytes: sourceSize,
            retention_days: settings.retentionDays,
          });
        }
      }

      // 31-02: stamp the committed output with the captured source mtime/atime.
      // Single apply point — covers all three done-smaller commit sub-branches
      // (suffix, replace-true, replace→suffix TOCTOU) AND both the rename and EXDEV
      // crossDeviceMove paths (copyFileSync writes a fresh mtime that this corrects).
      // Best-effort + soft-degrade: a failure here is cosmetic and must NEVER fail a
      // committed encode. The `?.` short-circuits cleanly when the optional dep is
      // absent (legacy test mock) — a silent no-op, NOT a warn (AC-3b).
      if (sourceTimes && deps.fs.utimesSync) {
        try {
          deps.fs.utimesSync(finalOutputPath, sourceTimes.atime, sourceTimes.mtime);
        } catch (err) {
          deps.logger.warn(
            {
              action: 'output_mtime_preserve_failed',
              jobId: job.id,
              fileId: file.id,
              outputPath: finalOutputPath,
              err: err instanceof Error ? err.message : String(err),
            },
            'source mtime preservation failed — output committed with fresh mtime; encode unaffected',
          );
        }
      }

      // 05-13 audit M1 ORDER: writeSidecar FIRST (best-effort try/catch — non-EACCES
      // errors like ENOSPC/EIO log warn + do NOT propagate). DB content_hash
      // remains authoritative.
      // 26-01 (F3): mode-aware sidecar write. off → no write (AC-2); beside →
      // existing 2-arg deps.writeSidecar (byte-identical, keeps test arg-assertions
      // green — AC-1/M3); central → resolved writer (own soft-degrade envelope).
      if (sidecarPayload && settings.sidecarMode !== 'off') {
        if (settings.sidecarMode === 'central') {
          await deps.writeSidecarResolved(
            finalOutputPath,
            sidecarPayload,
            'central',
            settings.sidecarCentralPath,
          );
        } else {
          try {
            await deps.writeSidecar(finalOutputPath, sidecarPayload);
          } catch (err) {
            const code =
              err && typeof err === 'object' && 'code' in err
                ? String((err as { code: unknown }).code)
                : 'unknown';
            deps.logger.warn(
              {
                action: 'sidecar_write_failed',
                errno: code,
                filePath: finalOutputPath,
                verdict: 'done-smaller',
                jobId: job.id,
                fileId: file.id,
                err: err instanceof Error ? err.message : String(err),
              },
              'sidecar write at output-path failed — DB content_hash authoritative; encode commit continues',
            );
          }
        }
      }

      // 05-13 audit M1 ORDER: setStatus SECOND (deterministic — must succeed for
      // OCC version contract; if throws OCC mismatch, top-level catch routes to
      // failJob and DB state mismatch reconciles via skip-pipeline step-4 enrichment).
      deps.fileRepo().setStatus(file.id, 'done-smaller', expectedFileVersion);

      // 05-13 audit M1 ORDER: markCompleted THIRD (forensic close — bytes_in +
      // bytes_out + duration_ms preserved on JobRow regardless of verdict).
      const updated = deps.jobRepo().markCompleted(job.id, {
        bytes_in: sourceSize,
        bytes_out: outputSize,
        duration_ms: encodeResult.durationMs,
      });
      deps.staging.cleanupStage(workDir);

      // 05-13 audit M1 ORDER: log + SSE emit FOURTH.
      deps.logger.info(
        {
          action: 'job_transition',
          jobId: job.id,
          fileId: file.id,
          transition: 'encoding→done',
          outcome: 'done-smaller',
          verdict: 'done-smaller',
          // 26-01 (F3, S4): forensic — distinguishes mode=off (intentional, no
          // sidecar on disk) from a silent write failure post-incident.
          sidecarMode: settings.sidecarMode,
          // 26-02 (F5, S?): EFFECTIVE committed output mode (replace vs suffix —
          // a hardlink-degraded replace reports 'suffix' here, the truth).
          outputMode: effectiveMode,
          bytesIn: updated?.bytes_in ?? sourceSize,
          bytesOut: updated?.bytes_out ?? outputSize,
          durationMs: updated?.duration_ms ?? encodeResult.durationMs,
        },
        'job transition: encoding→done (smaller)',
      );
      deps.events.emit({
        type: 'job.completed',
        jobId: job.id,
        fileId: file.id,
        outcome: 'done-smaller',
        sidecarMode: settings.sidecarMode,
        outputMode: effectiveMode,
        bytesIn: updated?.bytes_in ?? sourceSize,
        bytesOut: updated?.bytes_out ?? outputSize,
        durationMs: updated?.duration_ms ?? encodeResult.durationMs,
      });
      emitQueueUpdated(deps);
    } else {
      // 05-13 DISCARD path (verdict ∈ {done-not-worth, done-larger}) — output
      // never renamed (workDir cleanup destroys it), source preserved on disk,
      // sidecar at SOURCE-path with M2 W_OK pre-flight + soft-degrade.
      const cause: 'savings_below_threshold' | 'output_larger_than_source' =
        verdict === 'done-not-worth' ? 'savings_below_threshold' : 'output_larger_than_source';

      // 26-01 (F3, audit-M1 / AC-7): mode-aware discard-branch sidecar write.
      //   off     → no write (AC-2).
      //   central → write under the central root REGARDLESS of source-mount
      //     writability. The 05-13 source-parent W_OK pre-flight is correct ONLY
      //     for `beside`/source writes; central targets a DIFFERENT, writable
      //     directory (/config), so gating it on the read-only source mount would
      //     defeat F3's headline use case (relocate sidecars OUT of a read-only
      //     media tree). The resolved writer carries its own soft-degrade.
      //   beside  → 05-13 behavior byte-identical: W_OK pre-flight on the source
      //     parent + soft-degrade (read-only /input is SUPPORTED), then the 2-arg
      //     deps.writeSidecar (keeps test arg-assertions green — AC-1/M3).
      if (sidecarPayload && settings.sidecarMode === 'central') {
        await deps.writeSidecarResolved(
          file.path,
          sidecarPayload,
          'central',
          settings.sidecarCentralPath,
        );
      } else if (sidecarPayload && settings.sidecarMode === 'beside') {
        // 05-13 audit M2: W_OK pre-flight on source's parent dir before sidecar
        // write. Read-only-source-mount (unRAID least-privilege /input mount) is
        // a SUPPORTED config — EACCES/EROFS/ENOENT here triggers soft-degrade:
        // skip writeSidecar, STILL run setStatus + markCompleted; next scan's
        // skip-pipeline step-4 DB-hash enrichment (M3) covers the skip.
        let sourceWritable = true;
        try {
          deps.fs.accessSync(path.dirname(file.path), fs.constants.W_OK);
        } catch (err) {
          sourceWritable = false;
          const code =
            err && typeof err === 'object' && 'code' in err
              ? String((err as { code: unknown }).code)
              : 'unknown';
          deps.logger.warn(
            {
              action: 'sidecar_source_path_not_writable',
              errno: code,
              filePath: file.path,
              verdict,
              jobId: job.id,
              fileId: file.id,
            },
            'source-path parent dir not writable — sidecar skipped; DB-step-4 enrichment covers next-scan skip',
          );
        }

        // 05-13 audit M1 ORDER: writeSidecar FIRST (best-effort, only when
        // sourceWritable AND payload available; non-EACCES errors like ENOSPC
        // / EIO are logged + non-propagated — encode commit continues).
        if (sourceWritable) {
          try {
            await deps.writeSidecar(file.path, sidecarPayload);
          } catch (err) {
            const code =
              err && typeof err === 'object' && 'code' in err
                ? String((err as { code: unknown }).code)
                : 'unknown';
            deps.logger.warn(
              {
                action: 'sidecar_write_failed',
                errno: code,
                filePath: file.path,
                verdict,
                jobId: job.id,
                fileId: file.id,
                err: err instanceof Error ? err.message : String(err),
              },
              'sidecar write at source-path failed — DB-step-4 enrichment covers next-scan skip',
            );
          }
        }
      }

      // 05-13 audit M1 ORDER: setStatus SECOND. Branch on verdict so literal
      // status values appear inline (verify-grep gate counts 3 distinct
      // setStatus(file.id, 'done-...') call sites across the commit step).
      if (verdict === 'done-not-worth') {
        deps.fileRepo().setStatus(file.id, 'done-not-worth', expectedFileVersion);
      } else {
        deps.fileRepo().setStatus(file.id, 'done-larger', expectedFileVersion);
      }

      // 05-13 audit M1 ORDER: markCompleted THIRD (forensic close — bytes_in +
      // bytes_out + duration_ms preserved despite output DISCARD).
      const updated = deps.jobRepo().markCompleted(job.id, {
        bytes_in: sourceSize,
        bytes_out: outputSize,
        duration_ms: encodeResult.durationMs,
      });
      deps.staging.cleanupStage(workDir);

      // 05-13 audit M1 ORDER: log + SSE emit FOURTH. Each verdict has its own
      // emit call site so SSE outcome literals are grep-able (verify-grep
      // gate counts 3 distinct outcome: 'done-...' literals).
      deps.logger.info(
        {
          action: 'job_transition',
          jobId: job.id,
          fileId: file.id,
          transition: 'encoding→done',
          outcome: verdict,
          verdict,
          cause,
          // 26-01 (F3, S4): forensic — off vs central distinguishable post-incident.
          sidecarMode: settings.sidecarMode,
          bytesIn: updated?.bytes_in ?? sourceSize,
          bytesOut: updated?.bytes_out ?? outputSize,
          durationMs: updated?.duration_ms ?? encodeResult.durationMs,
        },
        verdict === 'done-not-worth'
          ? 'job transition: encoding→done (not worth; output discarded)'
          : 'job transition: encoding→done (larger; output discarded)',
      );
      if (verdict === 'done-not-worth') {
        deps.events.emit({
          type: 'job.completed',
          jobId: job.id,
          fileId: file.id,
          outcome: 'done-not-worth',
          sidecarMode: settings.sidecarMode,
          bytesIn: updated?.bytes_in ?? sourceSize,
          bytesOut: updated?.bytes_out ?? outputSize,
          durationMs: updated?.duration_ms ?? encodeResult.durationMs,
        });
      } else {
        deps.events.emit({
          type: 'job.completed',
          jobId: job.id,
          fileId: file.id,
          outcome: 'done-larger',
          sidecarMode: settings.sidecarMode,
          bytesIn: updated?.bytes_in ?? sourceSize,
          bytesOut: updated?.bytes_out ?? outputSize,
          durationMs: updated?.duration_ms ?? encodeResult.durationMs,
        });
      }
      emitQueueUpdated(deps);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'terminal_failed';
    deps.logger.error(
      {
        err: msg,
        stack: err instanceof Error ? err.stack : undefined,
        jobId: job.id,
        fileId: file.id,
      },
      'terminal step failed',
    );
    failJob(deps, { job, file, expectedFileVersion, workDir }, `terminal:${msg}`);
  }
}

interface RunEncodeStageCtx {
  activeEncoder: EncoderId;
  effectiveContainer: OutputContainer;
  crfForEncode: number;
  presetDispatch: string;
  det: DetectionResult;
  dropIncompatibleSubtitles: boolean;
  droppedSubtitleCount: number | undefined;
  droppedSubtitleCodecs: ReadonlyArray<string> | undefined;
  audioPerStreamTargets: ReadonlyArray<AudioAutoTranscodeTarget> | undefined;
  finalOutputPath: string;
}
type RunEncodeStageResult =
  | { kind: 'fail' }
  | { kind: 'cancelled' }
  | {
      kind: 'ok';
      workDir: string;
      stageOut: string;
      encodeResult: EncodeResult;
      commitNowIso: string;
      gitHash: string;
    };

// runEncodeStage — STAGE (createStageDir + symlink) + IMP-5 statfs probe + the
// runEncode call with abort/log-stream handling + the nonzero-exit gate. AbortError
// → {kind:'cancelled'}; any failJob path → {kind:'fail'}.
async function runEncodeStage(
  deps: EngineDeps,
  job: JobRow,
  file: FileRow,
  settings: ReturnType<typeof readSettings>,
  expectedFileVersion: number,
  ctx: RunEncodeStageCtx,
): Promise<RunEncodeStageResult> {
  const {
    activeEncoder,
    effectiveContainer,
    crfForEncode,
    presetDispatch,
    det,
    dropIncompatibleSubtitles,
    droppedSubtitleCount,
    droppedSubtitleCodecs,
    audioPerStreamTargets,
    finalOutputPath,
  } = ctx;

  // STAGE
  let workDir: string;
  try {
    workDir = deps.staging.createStageDir(settings.stageRoot, job.id);
    deps.staging.stageInputSymlink(file.path, workDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'stage_failed';
    failJob(deps, { job, file, expectedFileVersion, workDir: undefined }, `stage:${msg}`);
    return { kind: 'fail' };
  }

  // 05-15: stage output filename mirrors effective container so ffmpeg picks
  // the matching muxer (matroska / mp4) from the path extension.
  const stageOut = deps.staging.stageOutputPath(workDir, effectiveContainer);

  // 22-00 IMP-5: pre-flight statfs probe-log for B1b ENOENT evidence-trail.
  // Probe-only — ZERO behavior change.
  const preflightStageSource = path.join(workDir, 'input');
  const preflightPathsProbed = preflightStatfsProbe(
    [preflightStageSource, stageOut, finalOutputPath],
    deps.fs.statfsSync,
  );
  deps.logger.info(
    {
      jobId: job.id,
      fileId: file.id,
      encoder: activeEncoder,
      paths_probed: preflightPathsProbed,
    },
    'preflight_statfs_probe',
  );

  // ENCODE — crfForEncode resolved at dispatch (resolveEncodeParams) so the DB
  // row, runEncode invocation, and sidecar payload all agree on a single value.
  const controller = new AbortController();
  _activeControllers.set(job.id, controller);

  // 04-01 audit M3: single-now timestamp captured ONCE before encode dispatch.
  // Same instant flows to BOTH the ffmpeg `-metadata X265_BUTLER_PROCESSED_AT`
  // tag AND the sidecar `processedAt` field at commit step.
  const commitNowMs = Date.now();
  const commitNowIso = new Date(commitNowMs).toISOString();
  const gitHash = process.env.GIT_HASH ?? 'dev';

  // 04-01 audit-added: PROCESSED_BY tag block per Matroska spec UPPER_SNAKE_CASE.
  const encodeMetadata: ReadonlyArray<readonly [string, string]> = [
    ['PROCESSED_BY', 'x265-butler'],
    ['X265_BUTLER_VERSION', getVersionInfo().version],
    ['X265_BUTLER_HASH', file.content_hash],
    ['X265_BUTLER_PROCESSED_AT', commitNowIso],
  ];

  // 05-03 T1.F: per-job log capture. Open lazily — fire-and-forget Promise so
  // the orchestrator hot path is NEVER awaited on log-stream open.
  let jobLogStream: JobLogStream | null = null;
  const logStreamPromise = openJobLogStream(String(job.id), settings.stageRoot)
    .then((s) => {
      jobLogStream = s;
      return s;
    })
    .catch(() => null);

  let encodeResult: EncodeResult;
  try {
    encodeResult = await deps.runEncode({
      input: path.join(workDir, 'input'),
      output: stageOut,
      crf: crfForEncode,
      // 12-03: per-encoder preset override resolved at dispatch boundary.
      preset: presetDispatch,
      encoder: activeEncoder,
      vaapiDevice: det.vaapiDevice,
      metadata: encodeMetadata,
      signal: controller.signal,
      // 05-14 plumbing + 05-15 resolution: container + subtitle-drop opt-in +
      // warn metadata. effectiveContainer is the post-fallback narrowed value.
      outputContainer: effectiveContainer,
      dropIncompatibleSubtitles,
      jobId: job.id,
      droppedSubtitleCount,
      droppedSubtitleCodecs,
      // 10-02 E-D3: per-stream audio targets (undefined → byte-identical -c:a copy).
      audioPerStreamTargets,
      onLogChunk: (chunk) => {
        // Stream may not be open yet; resolved promise handles late writes.
        if (jobLogStream) jobLogStream.write(chunk);
      },
      onProgress: (ev) => {
        deps.logger.debug(
          { action: 'encode_progress', jobId: job.id, fileId: file.id, ev },
          'encode progress',
        );
        // 02-03 Task 2: forward to SSE subscribers — throttling lives in the
        // SSE Route Handler (per CONTEXT §3 + §5), NOT here.
        deps.events.emit({
          type: 'job.progress',
          jobId: job.id,
          fileId: file.id,
          frame: ev.frame,
          fps: ev.fps,
          outTimeMs: ev.outTimeMs,
          totalSize: ev.totalSize,
          progress: ev.progress,
        });
      },
    });
  } catch (err) {
    if (isAbortError(err)) {
      deps.jobRepo().markCancelled(job.id);
      deps.fileRepo().setStatus(file.id, 'interrupted', expectedFileVersion);
      deps.staging.cleanupStage(workDir);
      deps.logger.info(
        {
          action: 'job_transition',
          jobId: job.id,
          fileId: file.id,
          transition: 'encoding→cancelled',
        },
        'job transition: encoding→cancelled',
      );
      // 02-03 Task 2: SSE event for cancel
      deps.events.emit({ type: 'job.cancelled', jobId: job.id, fileId: file.id });
      emitQueueUpdated(deps);
      return { kind: 'cancelled' };
    }
    const msg = err instanceof Error ? err.message : 'encode_failed';
    failJob(deps, { job, file, expectedFileVersion, workDir }, `encode:${msg}`);
    return { kind: 'fail' };
  } finally {
    _activeControllers.delete(job.id);
    // 05-03 T1.F: await log-stream open + close so processOne resolves only after
    // logs are flushed. Ensures _inflight drain in __forTests_resetOrchestrator
    // includes the logs/ mkdir — prevents CI overlayfs ENOTEMPTY race on rmSync.
    const _ls = await logStreamPromise;
    if (_ls) {
      await _ls.close().catch(() => {
        /* close failure must not propagate */
      });
    }
  }

  if (encodeResult.exitCode !== 0) {
    failJob(
      deps,
      { job, file, expectedFileVersion, workDir },
      'encode_nonzero_exit',
      encodeResult.exitCode,
      encodeResult.logTail,
    );
    return { kind: 'fail' };
  }

  return { kind: 'ok', workDir, stageOut, encodeResult, commitNowIso, gitHash };
}

type VerifyOutputResult =
  | { kind: 'fail' }
  | { kind: 'cancelled' }
  | {
      kind: 'ok';
      probe: ProbeResult;
      outputSize: number;
      verdict: 'done-smaller' | 'done-not-worth' | 'done-larger';
    };

// verifyOutput — output ffprobe + size + 3-bucket verdict + the external-cancel
// post-encode check. External cancel → {kind:'cancelled'}; failJob → {kind:'fail'}.
async function verifyOutput(
  deps: EngineDeps,
  job: JobRow,
  file: FileRow,
  stageOut: string,
  sourceSize: number,
  settings: ReturnType<typeof readSettings>,
  expectedFileVersion: number,
  workDir: string,
): Promise<VerifyOutputResult> {
  // VERIFY (audit-added S3: stat wrapped in try/catch)
  let probe: ProbeResult | null;
  try {
    probe = await deps.ffprobe(stageOut);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'ffprobe_threw';
    failJob(deps, { job, file, expectedFileVersion, workDir }, `verify:${msg}`);
    return { kind: 'fail' };
  }
  if (!probe) {
    failJob(deps, { job, file, expectedFileVersion, workDir }, 'output_unplayable');
    return { kind: 'fail' };
  }

  let outputSize: number;
  try {
    outputSize = deps.fs.statSync(stageOut).size;
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code: unknown }).code)
        : 'unknown';
    failJob(
      deps,
      { job, file, expectedFileVersion, workDir },
      `verify_stat_failed:stageOutput:${code}`,
    );
    return { kind: 'fail' };
  }

  // 05-13: 3-bucket verdict — output_larger / done-not-worth (savings < min) /
  // done-smaller.
  const savingsRatio = sourceSize > 0 ? (sourceSize - outputSize) / sourceSize : 0;
  const savingsPercent = savingsRatio * 100;
  const minPct = settings.minSavingsPercent;
  const verdict: 'done-smaller' | 'done-not-worth' | 'done-larger' =
    outputSize > sourceSize
      ? 'done-larger'
      : savingsPercent < minPct
        ? 'done-not-worth'
        : 'done-smaller';

  // 2026-04-27 bug fix: external-cancel check BEFORE commit/trash side
  // effects. cancelJob's queued-path may have marked the job 'cancelled'
  // while we were mid-encode. ffmpeg may have completed anyway. Without this
  // check, commitOutput + trashOriginal would run and the operator's cancel
  // intent would be silently overridden + the original moved to trash.
  const freshJob = deps.jobRepo().findByFileId(file.id);
  if (freshJob && freshJob.id === job.id && freshJob.status === 'cancelled') {
    deps.staging.cleanupStage(workDir);
    const currentFile = deps.fileRepo().getById(file.id);
    if (currentFile && currentFile.status === 'encoding') {
      deps.fileRepo().setStatus(file.id, 'interrupted', expectedFileVersion);
    }
    deps.logger.info(
      {
        action: 'job_transition',
        jobId: job.id,
        fileId: file.id,
        transition: 'encoding→cancelled',
        cause: 'external_cancel_during_encode',
      },
      'job transition: encoding→cancelled (external cancel detected post-encode)',
    );
    deps.events.emit({ type: 'job.cancelled', jobId: job.id, fileId: file.id });
    emitQueueUpdated(deps);
    return { kind: 'cancelled' };
  }

  return { kind: 'ok', probe, outputSize, verdict };
}

// audit-added M4: recover BOTH job AND file state after orchestrator crash
function recoverStaleStateOnStartup(deps: EngineDeps): {
  recoveredJobs: number;
  recoveredFiles: number[];
  recoveredFileRows: number;
} {
  const now = deps.now();
  const recoveredCount = deps.jobRepo().recoverStaleEncoding(now, STALE_ENCODING_THRESHOLD_SECONDS);
  // 02-04 follow-up: file-rows can hold status='encoding' independently of any
  // live job (e.g. process killed between jobRepo.create and the file.status
  // bump, or after a setStatus failed silently in a previous boot's loop).
  // Single-process invariant: any 'encoding' file at boot is orphan, force a
  // bulk update so Library + Queue UI agree on the ground truth.
  const recoveredFileRows = deps.fileRepo().recoverStaleEncoding(now);
  if (recoveredCount === 0) {
    return { recoveredJobs: 0, recoveredFiles: [], recoveredFileRows };
  }
  // Pull recent jobs that were just touched (status='interrupted', finished_at=now).
  const recent = deps.jobRepo().listRecent(Math.max(recoveredCount * 2, 50));
  const justTouched = recent.filter((j) => j.status === 'interrupted' && j.finished_at === now);
  const recoveredFiles: number[] = [];
  for (const j of justTouched) {
    const file = deps.fileRepo().getById(j.file_id);
    if (!file) continue;
    const ok = deps.fileRepo().setStatus(file.id, 'interrupted', file.version);
    if (ok) {
      recoveredFiles.push(file.id);
    } else {
      deps.logger.warn(
        {
          action: 'recover_stale_encoding_race',
          jobId: j.id,
          fileId: file.id,
          currentStatus: file.status,
          currentVersion: file.version,
        },
        'file.status setStatus returned false during stale-encoding recovery — another writer raced',
      );
    }
  }
  return { recoveredJobs: recoveredCount, recoveredFiles, recoveredFileRows };
}

// 03-02 audit-added: tryDispatchOne — peek queued jobs, resolve encoder per
// candidate, claim first that fits available capacity.
//
// Audit M1 — reserve-then-confirm slot reservation:
//   1. peek candidates (no DB write)
//   2. resolve encoder for each
//   3. if hasCapacityFor(resolved): reserve slot SYNCHRONOUSLY before claim
//   4. attempt claimById; on race (returns undefined), roll back reservation + continue
//   5. on success: launch processOne in background, tracked in _inflight
//
// Audit S11 — emit queue.updated immediately after successful claim so the UI
// sees activeJobs increment without waiting for the next progress tick.
//
// Audit M5 + S1 — promise capture pattern: const p = ...; _inflight.add(p);
// the .catch + .finally chain references the same `p` variable via closure.
async function tryDispatchOne(): Promise<boolean> {
  const deps = _deps;
  const candidates = deps.jobRepo().peekQueued(100); // audit M4 — bumped 20 → 100
  if (candidates.length === 0) return false;

  const settingsAll = deps.settingRepo().getAll();
  const det = _detectionResult ?? (await deps.detectEncoders());

  for (const candidate of candidates) {
    const resolved = resolveEncoderFor(candidate, settingsAll, det, deps);
    if (!hasCapacityFor(resolved)) continue;

    // audit M1: reserve SYNCHRONOUSLY before claim attempt.
    reserveSlot(candidate.id, resolved);
    const claimed = deps.jobRepo().claimById(candidate.id);
    if (!claimed) {
      // Race lost — roll back reservation, try next candidate.
      releaseSlot(candidate.id);
      continue;
    }

    // audit S11: SSE event immediately on claim — UI sees activeJobs++ now.
    emitQueueUpdated(deps);

    // audit M5 + S1 — promise capture so .finally can self-delete from _inflight.
    const p: Promise<void> = processOne(claimed, resolved, det, settingsAll)
      .catch((err) => {
        deps.logger.error(
          {
            err: err instanceof Error ? err.stack : String(err),
            jobId: claimed.id,
          },
          'background processOne threw — bug',
        );
      })
      .finally(() => {
        releaseSlot(claimed.id);
        _inflight.delete(p);
        // Sub-second slot reuse — kick dispatch immediately.
        kickDispatchImmediate();
      });
    _inflight.add(p);
    return true;
  }
  return false;
}

// 03-02 audit-added: single-flight dispatch loop with M2 mutex + S2 per-iteration
// _stopping check. Without M2, scheduleNext invocations from .finally chains
// AND the IDLE_POLL_MS timer can run two concurrent dispatch loops → both
// observe stale capacity → exceed limits.
//
// 32-02: the loop is now gated by `_stopping` (process teardown) AND `_paused`
// (operator pause-after-current). While paused, the loop breaks before claiming
// any new job; in-flight encodes keep running. Skip / Cancel-All still work BY
// aborting in-flight controllers — orthogonal to pause (which never aborts).
async function dispatchUntilFull(): Promise<void> {
  if (_dispatching) return;
  _dispatching = true;
  try {
    while (!_stopping && !isQueuePaused()) {
      const dispatched = await tryDispatchOne();
      if (!dispatched) break;
    }
  } finally {
    _dispatching = false;
  }
}

// kickDispatchImmediate — fired from background processOne .finally for
// sub-second slot reuse. M2's _dispatching mutex makes this safe even if a
// scheduleNext-driven dispatchUntilFull is already running. 32-02: also no-ops
// while paused so a completing encode does not re-arm dispatch.
function kickDispatchImmediate(): void {
  if (_stopping || isQueuePaused()) return;
  void dispatchUntilFull();
}

// 32-02: in-memory pause-after-current control surface.
//
// isQueuePaused (the getter + raw flag) lives in './pause-state' and is re-exported
// here so the encode barrel still surfaces it. It is the SINGLE getter consumed
// cross-module by the watcher emit, GET /api/queue/status, and the queue SSR page —
// those three import it DIRECTLY from './pause-state' to stay off this graph (SR-3).
export { isQueuePaused };

// setQueuePaused(b) — idempotent flag setter driven by POST /api/queue/pause|resume
// (and reachable actor-less from internals). No-ops when unchanged to avoid a
// redundant emit. On resume it kicks dispatch immediately so a queued job starts
// without waiting for the IDLE_POLL_MS tick. Logs a DISTINCT
// `queue_pause_state_changed` breadcrumb — NOT `queue_paused`/`queue_resumed`,
// which the routes own as the single authoritative actor-attributed audit line
// (SR-2): the setter has no actor when called from teardown/reconcile internals.
export function setQueuePaused(paused: boolean): void {
  if (isQueuePaused() === paused) return;
  __setPausedFlag(paused);
  _deps.logger.info({ action: 'queue_pause_state_changed', paused }, 'queue pause state changed');
  emitQueueUpdated(_deps);
  if (!paused) kickDispatchImmediate();
}

async function scheduleNext(): Promise<void> {
  if (_stopping) return;
  // Idempotent: if a tick is already scheduled, don't double-schedule.
  if (_idleTimer) return;
  _idleTimer = setTimeout(() => {
    _idleTimer = null;
    if (_stopping) return;
    void trackDispatch(
      dispatchUntilFull()
        .catch((err) => {
          _deps.logger.error(
            { err: err instanceof Error ? err.message : String(err) },
            'dispatchUntilFull threw — restarting idle poll',
          );
        })
        .finally(() => {
          // Re-arm next idle poll regardless.
          void scheduleNext();
        }),
    );
  }, IDLE_POLL_MS);
}

export function startEncoderLoop(): void {
  if (_loopStarted) return;
  _loopStarted = true;
  _stopping = false;
  const deps = _deps;

  // 22-02 (audit-added SR8): unified failure-cause vocabulary across boot + dispatch.
  // Boot-time mkdir + writefile-probe uses the same helper as dispatch but emits
  // {phase:'boot'} to distinguish from {phase:'dispatch'} / {phase:'statfs-late'}.
  // Best-effort — boot continues even when the cache pool is unavailable; dispatch
  // path self-heals on late-mounting pools via the same helper.
  const bootSettings = readSettings(deps);
  try {
    deps.staging.assertCachePoolWritable(bootSettings.stageRoot);
  } catch (err) {
    if (err instanceof CachePoolUnavailableError) {
      const syscall =
        err.cause && typeof err.cause === 'object' && 'syscall' in err.cause
          ? String((err.cause as { syscall: unknown }).syscall)
          : null;
      deps.logger.warn(
        {
          action: 'cache_pool_unavailable',
          cachePath: bootSettings.stageRoot,
          code: err.code,
          syscall,
          phase: 'boot',
        },
        'cache_pool_path could not be ensured at boot — encodes will fail until setting points to a writable directory or the path becomes available',
      );
    } else {
      // shape-error path — preserve existing behavior; not actionable as cache_pool_unavailable
      deps.logger.warn(
        {
          cachePath: bootSettings.stageRoot,
          err: err instanceof Error ? err.message : String(err),
        },
        'cache_pool_path shape-error at boot — settings invalid',
      );
    }
  }

  const { recoveredJobs, recoveredFiles, recoveredFileRows } = recoverStaleStateOnStartup(deps);
  deps.logger.info(
    {
      action: 'encoder_loop_start',
      recoveredStaleEncoding: recoveredJobs,
      recoveredFiles,
      recoveredFileRows,
    },
    'encoder loop started',
  );

  // 03-02 audit-added S10: compute per-encoder capacity limits + emit a
  // diagnostic boot log (cpuCount + concurrencySetting + resolved limits) so
  // support tickets can reconstruct exactly why limits resolved as they did.
  recomputePerEncoderLimits();
  deps.logger.info(
    {
      action: 'encoder_loop_capacity',
      cpuCount: os.cpus().length,
      concurrencySetting: deps.settingRepo().get('concurrency') ?? 'auto',
      limits: _perEncoderLimits,
    },
    'encoder loop capacity computed',
  );

  // 03-01 audit S1: boot-time encoder detection (lifted out of per-job hot
  // path). Fire-and-forget so loop start is not blocked on probe latency;
  // processOne falls back to inline await if the cache is still empty by the
  // time the first job is claimed.
  void deps
    .detectEncoders()
    .then((det) => {
      _detectionResult = det;
    })
    .catch((err) => {
      deps.logger.warn(
        {
          action: 'encoder_detection_boot_failed',
          err: err instanceof Error ? err.message : String(err),
        },
        'boot-time detectEncoders rejected — orchestrator will inline-detect on first job',
      );
    });

  // 03-02: dispatch immediately at boot instead of waiting IDLE_POLL_MS for
  // the first scheduleNext tick. Operators expect queued jobs to start within
  // milliseconds of container restart, not after a 1-second idle.
  void trackDispatch(
    dispatchUntilFull().finally(() => {
      void scheduleNext();
    }),
  );
}

export async function stopEncoderLoop(): Promise<void> {
  _stopping = true;
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
  for (const ctrl of _activeControllers.values()) {
    try {
      ctrl.abort();
    } catch {
      // ignore
    }
  }
  // 03-02 audit-added: drain ALL background processOne promises (Set instead of
  // single Promise). Snapshot to array first to avoid mutation-during-iteration
  // when the .finally handlers fire and call _inflight.delete.
  if (_inflight.size > 0) {
    try {
      await Promise.allSettled([..._inflight]);
    } catch {
      // ignore — Promise.allSettled never rejects, but defensive.
    }
  }
  // Option D safety net: redundant cleanup pass for any 'encoding' row whose
  // processOne AbortError handler did NOT run (e.g. process killed mid-await
  // before the catch block fired). Idempotent — recoverStaleEncoding's SQL is
  // a no-op for terminal rows. Pairs with reconcile-on-boot (B): if D succeeds
  // the next boot has nothing to do; if D missed (SIGKILL bypass), B catches it.
  try {
    const recoveredJobs = _deps.jobRepo().recoverStaleEncoding(_deps.now(), 0);
    const recoveredFileRows = _deps.fileRepo().recoverStaleEncoding(_deps.now());
    if (recoveredJobs > 0 || recoveredFileRows > 0) {
      _deps.logger.info(
        { action: 'shutdown_recover', recoveredJobs, recoveredFileRows },
        'shutdown: marked in-flight encoding rows as interrupted',
      );
    }
  } catch (err) {
    _deps.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'shutdown_recover: db write failed (process is going down anyway)',
    );
  }
  _deps.logger.info({ action: 'encoder_loop_stop' }, 'encoder loop stopped');
  _loopStarted = false;
}

// Test-only escape hatches — never exported via the barrel.
export function __forTests_setDeps(partial: Partial<EngineDeps>): void {
  _deps = { ..._deps, ...partial };
}

// 10-01 bench-channel test helpers. Never exported via the barrel.
export function __forTests_markJobAsBenchSample(jobId: number): void {
  _benchSampleJobIds.add(jobId);
}

export function __forTests_clearBenchSampleJobs(): void {
  _benchSampleJobIds.clear();
}

// 05-08 B1 test-only: register an AbortController in the in-memory map so
// requestStopAll's Branch A (live encode) can be exercised without spinning up
// a full processOne pipeline. Production code path uses processOne to populate
// _activeControllers; tests need a synchronous shortcut.
export function __forTests_registerActiveController(
  jobId: number,
  controller: AbortController,
): void {
  _activeControllers.set(jobId, controller);
}

// 32-02 test-only: drive the real dispatch loop synchronously so the pause gate
// can be exercised without startEncoderLoop's idle-poll timer. While `_paused` is
// true the loop body never runs (the `!_paused` guard short-circuits the while),
// so tryDispatchOne — and thus jobRepo.peekQueued/claimById — is never reached.
export async function __forTests_dispatchUntilFull(): Promise<void> {
  await dispatchUntilFull();
}

export async function __forTests_resetOrchestrator(): Promise<void> {
  // Signal in-flight dispatch + scheduleNext callbacks to bail out fast.
  _stopping = true;
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
  // Drain fire-and-forget dispatches AND processOne promises before clearing
  // state; otherwise the test's fs.rmSync(stageRoot) races with whatever
  // dispatchUntilFull is mid-step (CI overlayfs surfaces this as ENOTEMPTY).
  if (_pendingDispatches.size > 0) {
    await Promise.allSettled([..._pendingDispatches]);
  }
  if (_inflight.size > 0) {
    await Promise.allSettled([..._inflight]);
  }
  _loopStarted = false;
  _stopping = false;
  // 32-02: each test starts UNPAUSED (parity with _stopping reset).
  __resetPausedFlag();
  _activeControllers.clear();
  // 03-02 audit-added: clear multi-slot state so each test starts at single-slot
  // defaults. Existing 02-02 + 03-01 tests assert single-slot semantics — this
  // restoration keeps them GREEN byte-identical.
  _activeJobEncoders.clear();
  _activeCountByEncoder.clear();
  _inflight.clear();
  _pendingDispatches.clear();
  _dispatching = false;
  _perEncoderLimits = { libx265: 1, nvenc: 1, qsv: 1, vaapi: 1 };
  _detectionResult = null;
  _benchSampleJobIds.clear();
  _deps = makeDefaultDeps();
}
