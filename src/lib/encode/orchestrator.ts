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
const DEFAULT_CACHE_POOL_PATH = '/mnt/cache/x265-butler';

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
// 05-09 Decision §2: `paused` field stays in the wire format permanently
// `false` so any unmigrated SSE consumer keeps deserializing without code
// changes. Pause/Stop concept is retired entirely — see Skip + Cancel-All-Queued
// for the replacement model.
function emitQueueUpdated(deps: EngineDeps): void {
  const activeJobs = deps.jobRepo().listActive().length;
  const pendingJobs = deps.jobRepo().countByStatus('queued');
  deps.events.emit({ type: 'queue.updated', activeJobs, pendingJobs, paused: false });
}

let _deps: EngineDeps = makeDefaultDeps();
let _loopStarted = false;
let _stopping = false;
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
} {
  const settings = deps.settingRepo();
  const rawContainer = settings.get('output_container');
  return {
    stageRoot: settings.get('cache_pool_path') ?? DEFAULT_CACHE_POOL_PATH,
    crf: parseInt(settings.get('default_crf') ?? '23', 10),
    minSavingsPercent: parseInt(settings.get('min_savings_percent') ?? '5', 10),
    retentionDays: parseInt(settings.get('trash_retention_days') ?? '30', 10),
    deleteOriginalAfterEncode: settings.get('delete_original_after_encode') === 'true',
    outputSuffix: settings.get('output_suffix') ?? '-x265',
    outputContainer: isOutputContainerSetting(rawContainer) ? rawContainer : 'mkv',
    // Default 'true': absent setting → auto-transcode enabled (migration 0017 seeds 'true').
    audioAutoTranscode: settings.get('audio_auto_transcode_mp4') !== 'false',
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

  const file = deps.fileRepo().getById(job.file_id);
  if (!file) {
    failJob(deps, { job }, 'file_not_found');
    return;
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
    return;
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

  const expectedFileVersion = fileVersionBeforeEncoding + 1;
  const settings = readSettings(deps);

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
  // Structured log `dispatch_preset_resolved` (info) is the per-job
  // audit-trail surface — answers post-incident "what preset did job N
  // actually use?" WITHOUT requiring a snapshot of the setting table at
  // dispatch-timestamp. Trade-off: log-only audit-trail preserves the
  // "exactly 1 migration" gate (no `job.preset_used` column needed).
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
  // Operator can now read job.preset_used directly in the Library detail panel
  // without depending on log aggregation (audit M4 trade-off reversed).
  deps.jobRepo().setPresetUsed(job.id, presetDispatch);

  // 22-02 A (audit-revised 2026-05-24): lazy ensure cache_pool_path exists + is writable.
  // assertCachePoolWritable performs: assertValidStageRoot (shape) →
  // mkdirSync recursive (idempotent) → writefile-probe (FUSE-safe per audit SR6).
  // Idempotent no-op when the dir already exists and is writable.
  try {
    deps.staging.assertCachePoolWritable(settings.stageRoot);
  } catch (err) {
    if (err instanceof CachePoolUnavailableError) {
      // audit-added M5: structured-log enrichment with cachePath + syscall BEFORE failJob.
      // Operator forensics require WHAT+WHERE; cause-string stays short for UI render.
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
      return;
    }
    const msg = err instanceof Error ? err.message : 'invalid_cache_pool_path';
    failJob(deps, { job, file, expectedFileVersion }, msg);
    return;
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
    return;
  }

  // 10-02 C5: cache-pool free-space pre-flight via staging helper.
  // Factor: 2× (raised from 1.5× per C5). CachePoolPreFlightError → file
  // re-queued as 'pending' (not failed) + 5-min cooldown prevents re-statfs.
  // CachePoolConfigError (missing path) → fail the job (operator config error).
  // statfsSync errors (mount gone) → fail the job (fatal FS error).
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
      return;
    }
    if (err instanceof CachePoolConfigError) {
      failJob(deps, { job, file, expectedFileVersion }, `cache_pool_config:${err.message}`);
      return;
    }
    // 22-02 A (audit-revised 2026-05-24): remap downstream statfs catch to
    // cache_pool_unavailable for operator-actionable consistency with the
    // dispatch-boundary check above. Triggers when the mount disappears between
    // assertCachePoolWritable (line ~966) and assertCachePoolFreeSpace's internal statfsSync.
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
    return;
  }

  // 10-03 E-D5: forceContainer from retry API overrides all other settings.
  // job.force_container is persisted to DB at retry time; survives restarts.
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
  // the dispatch boundary BEFORE pre-flight. Source-extension drives the
  // initial choice; explicit mkv/mp4 pass through unchanged. The resolution
  // may flip mid-pre-flight under the match-source path on audio / subtitle /
  // ffprobe-null incompat — `effectiveContainer` is the final, post-fallback
  // value threaded into runEncode + suffix derivation downstream.
  // 10-02 E-D1: per-file container_override (NULL = inherit global setting).
  // Validate DB value defensively — an operator-edited DB cell could contain
  // an unexpected string; fall back to global setting on unknown value.
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
  // file at the dispatch boundary to detect:
  //   - audio codecs ffmpeg's mp4 muxer cannot accept under `-c:a copy`
  //     (TrueHD / DTS / FLAC / Opus / raw PCM / MLP) → fail-fast BEFORE spawn
  //     with operator-actionable error_reason
  //   - subtitle codecs ffmpeg's mp4 muxer cannot accept (SRT / ASS / PGS / …)
  //     → set dropIncompatibleSubtitles + populate dropped-meta for the
  //     ffmpeg.ts pino warn audit-trail event
  //
  // 05-15 (AC-5/6/12): under `match-source`, every MP4-incompat surface auto-
  // falls back to MKV instead of failing the job. The fallback emits a single
  // `mp4_fallback_to_mkv` pino warn (replaces the explicit-mp4 fail-fast warn)
  // for SOC-2 audit-trail consistency. Explicit `mp4` retains 05-14 contract
  // byte-identical.
  //
  // No source ffprobe runs when the resolved container is MKV — MKV accepts
  // virtually all codecs natively; the cost (50-200ms per dispatch) is
  // reserved for the MP4 path where the failure surface is real.
  let dropIncompatibleSubtitles = false;
  let droppedSubtitleCount: number | undefined;
  let droppedSubtitleCodecs: ReadonlyArray<string> | undefined;
  // 10-02 E-D3: per-stream audio transcode targets (auto_transcode outcome only).
  let audioPerStreamTargets: ReadonlyArray<AudioAutoTranscodeTarget> | undefined;
  // 10-03 E-D5: containerFallback record — set at each mp4→mkv fallback site,
  // included in sidecar V3 payload so the FileDetailPanel can show the cause.
  let containerFallbackRecord: ContainerFallbackRecord | undefined;
  // 10-02 E-D3: hoisted so sidecar emission can build V3 with source metadata
  // when audio auto-transcode is active (preflightSourceProbe comes from the
  // MP4 dispatch ffprobe run; null when container is MKV or ffprobe failed).
  let preflightSourceProbe: ProbeResult | null = null;
  if (effectiveContainer === 'mp4') {
    preflightSourceProbe = await deps.ffprobe(file.path);
    const sourceProbe = preflightSourceProbe;
    if (sourceProbe) {
      // 10-02 E-D3: audio branch with discriminated union outcome. autoTranscode
      // reads from migration-seeded setting (default 'true'); isMatchSource
      // passed so analyzeAudioStreams can emit fallback_to_mkv directly.
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
        return;
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
      // Subtitle branch — inspected whenever effectiveContainer is still 'mp4'
      // (i.e., audio did not flip to mkv). Applies to 'compatible' + 'auto_transcode' outcomes.
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
      // is a defensive fallback to MKV (no failed job, no optimistic mp4
      // attempt). Replaces 05-14 `mp4_preflight_ffprobe_unavailable` warn —
      // single audit-trail event for SOC-2 reconstruction.
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
      // ffprobe returned null on explicit-mp4 — not a hard failure; mp4 mux
      // may still succeed if the file has no exotic streams. Encoder-side
      // ffmpeg will surface any real incompat as a non-zero exit. Log the
      // soft-degrade for forensics. 05-14 contract preserved byte-identical.
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

  // 05-14 + 05-15 (audit M2 RE-ORDER): legacy `output_suffix` precedence vs
  // container-derived suffix. MUST run AFTER pre-flight because under
  // match-source the effectiveContainer can flip mid-pre-flight (audio /
  // subtitle / ffprobe-null fallback) — deriving the suffix upstream would
  // lock-in the pre-fallback container and leave finalOutputPath +
  // output_path_exists checking the wrong path.
  const resolvedSuffix = resolveOutputSuffix(settings.outputSuffix, effectiveContainer);

  // audit-added S1: pre-encode output-path collision check (before any spawn).
  // outputPathFor honors the resolved suffix (legacy override OR
  // post-fallback container-derived).
  const finalOutputPath = deps.staging.outputPathFor(file.path, resolvedSuffix);
  if (deps.fs.existsSync(finalOutputPath)) {
    deps.logger.warn(
      { action: 'output_path_exists', jobId: job.id, fileId: file.id, finalOutputPath },
      'output path exists — refusing to encode',
    );
    failJob(deps, { job, file, expectedFileVersion }, 'output_path_exists');
    return;
  }

  // STAGE
  let workDir: string;
  try {
    workDir = deps.staging.createStageDir(settings.stageRoot, job.id);
    deps.staging.stageInputSymlink(file.path, workDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'stage_failed';
    failJob(deps, { job, file, expectedFileVersion, workDir: undefined }, `stage:${msg}`);
    return;
  }

  // 05-15: stage output filename mirrors effective container so ffmpeg picks
  // the matching muxer (matroska / mp4) from the path extension.
  const stageOut = deps.staging.stageOutputPath(workDir, effectiveContainer);

  // 22-00 IMP-5: pre-flight statfs probe-log for B1b ENOENT evidence-trail.
  // Probe-only — ZERO behavior change. Downstream statfs_failed (cache-pool
  // check ~line 1013) is unrelated; root-cause fix lives in Plan 22-02.
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

  // ENCODE
  // 03-01 audit M4 (per-encoder CRF): settings.crf reads `default_crf` for
  // back-compat; if the per-encoder `crf_<encoder>` setting is present
  // (migration 0005), prefer that. CRF semantics differ slightly per encoder
  // (NVENC QP / QSV global_quality / VAAPI QP / libx265 CRF) so per-encoder
  // defaults from Discovery let the operator tune each independently.
  // 05-08 B4: same value already resolved + persisted at dispatch above
  // (crfDispatch). Reuse it so the DB row, runEncode invocation, and sidecar
  // payload all agree on a single resolved value.
  const crfForEncode = crfDispatch;
  const controller = new AbortController();
  _activeControllers.set(job.id, controller);

  // 04-01 audit M3: single-now timestamp captured ONCE before encode dispatch.
  // Same instant flows to BOTH the ffmpeg `-metadata X265_BUTLER_PROCESSED_AT`
  // tag AND the sidecar `processedAt` field at commit step — eliminates clock
  // drift between tag/sidecar/log audit-trail rows for the same encode event.
  // Mirrors audit M1 from 03-04 stats route.
  const commitNowMs = Date.now();
  const commitNowIso = new Date(commitNowMs).toISOString();
  const gitHash = process.env.GIT_HASH ?? 'dev';

  // 04-01 audit-added: PROCESSED_BY tag block per Matroska spec UPPER_SNAKE_CASE
  // (research §3 + IETF cellar-tags). Inserted after `-map_metadata 0` so our
  // keys override input metadata (last-write-wins). Source contentHash carries
  // the skip-pipeline identity signal for re-scan after MKV-tag-stripping
  // operations (HandBrake / Plex transcode).
  const encodeMetadata: ReadonlyArray<readonly [string, string]> = [
    ['PROCESSED_BY', 'x265-butler'],
    ['X265_BUTLER_VERSION', getVersionInfo().version],
    ['X265_BUTLER_HASH', file.content_hash],
    ['X265_BUTLER_PROCESSED_AT', commitNowIso],
  ];

  // 05-03 T1.F: per-job log capture. Open lazily — fire-and-forget Promise so
  // the orchestrator hot path is NEVER awaited on log-stream open. The stream
  // resolves asynchronously; chunks before resolution are buffered into a
  // pre-open queue inside the helper. close() drains and closes regardless.
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
      // 12-03: per-encoder preset override (resolved at dispatch boundary
      // ~line 866 via settings.preset_<activeEncoder> read + Catalog-validator
      // fallback to DEFAULT_PRESET_BY_ENCODER). Threaded into runEncode →
      // buildArgs → PROFILE_BUILDERS for the active encoder.
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
      return;
    }
    const msg = err instanceof Error ? err.message : 'encode_failed';
    failJob(deps, { job, file, expectedFileVersion, workDir }, `encode:${msg}`);
    return;
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
    return;
  }

  // VERIFY (audit-added S3: stat wrapped in try/catch)
  let probe: ProbeResult | null;
  try {
    probe = await deps.ffprobe(stageOut);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'ffprobe_threw';
    failJob(deps, { job, file, expectedFileVersion, workDir }, `verify:${msg}`);
    return;
  }
  if (!probe) {
    failJob(deps, { job, file, expectedFileVersion, workDir }, 'output_unplayable');
    return;
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
    return;
  }

  // 05-13: 3-bucket verdict — output_larger / done-not-worth (savings < min) /
  // done-smaller. Replaces the pre-05-13 boolean `isSmaller` split that lumped
  // marginal-savings files with literal output-larger cases.
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
  // while we were mid-encode (pre-stage race or any window where
  // _activeControllers didn't have our entry). ffmpeg may have completed
  // anyway. Without this check, commitOutput + trashOriginal would run
  // and the operator's cancel intent would be silently overridden + the
  // original file unintentionally moved to trash.
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
    return;
  }

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
      // 05-13 KEEP path — output committed, sidecar at OUTPUT-path.
      deps.staging.commitOutput(stageOut, finalOutputPath);
      // 05-bonus: branch on operator's delete_original_after_encode setting.
      // Default false → trash + retention (existing 02-02 behavior).
      // True → hard-delete the original via fs.unlink. NO trash row created;
      // FK CASCADE remains intact since we only delete the disk file, not
      // the file row itself (status flips to done-smaller below).
      if (settings.deleteOriginalAfterEncode) {
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

      // 05-13 audit M1 ORDER: writeSidecar FIRST (best-effort try/catch — non-EACCES
      // errors like ENOSPC/EIO log warn + do NOT propagate). DB content_hash
      // remains authoritative.
      if (sidecarPayload) {
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
      if (sourceWritable && sidecarPayload) {
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
// 05-09: pause concept retired — only _stopping gates the loop now (process
// teardown). Skip / Cancel-All work BY aborting in-flight controllers; they do
// not pause dispatch.
async function dispatchUntilFull(): Promise<void> {
  if (_dispatching) return;
  _dispatching = true;
  try {
    while (!_stopping) {
      const dispatched = await tryDispatchOne();
      if (!dispatched) break;
    }
  } finally {
    _dispatching = false;
  }
}

// kickDispatchImmediate — fired from background processOne .finally for
// sub-second slot reuse. M2's _dispatching mutex makes this safe even if a
// scheduleNext-driven dispatchUntilFull is already running.
function kickDispatchImmediate(): void {
  if (_stopping) return;
  void dispatchUntilFull();
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
