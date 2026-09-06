// Phase 16-01 T4: watcher-service composition.
//
// Wires the low-level primitives (watcher.ts + reconcile.ts + ingest.ts) on
// top of the project singletons (shareRepo / settingRepo / fileRepo / jobRepo /
// blocklistRepo + scan/orchestrator.runScan + encode/events.engineEvents) and
// exposes a stable surface to server-init, the /api/health route, and the
// Settings UI:
//
//   startWatcherService()    — boot path (autoScan.enabled gate + default seed)
//   stopWatcherService()     — graceful teardown
//   restartWatcherService()  — debounced + coalesced (audit S3)
//   getAutoScanStatus()      — health-route snapshot

import type { AppLogger } from '@/src/lib/logger';
import {
  fileRepo as defaultFileRepo,
  jobRepo as defaultJobRepo,
  shareRepo as defaultShareRepo,
  settingRepo as defaultSettingRepo,
  blocklistRepo as defaultBlocklistRepo,
  getDb,
} from '../db';
import { logger as defaultLogger } from '../logger';
import { runScan } from '../scan/orchestrator';
import { engineEvents } from '../encode/events';
// 32-02: single cross-module getter for the in-memory pause flag. Imported from the
// dependency-free pause-state module (NOT the encode barrel — that would drag the
// orchestrator's makeDefaultDeps db reads into the watcher graph, audit SR-3). Lets
// the watcher's queue.updated emit carry the REAL paused state instead of false.
import { isQueuePaused } from '../encode/pause-state';
import { queueCountsSnapshot } from '../queue/counts';
import {
  startWatcher,
  stopWatcher,
  getWatcherSnapshot,
  resetWatcherState,
  setReconcileResult,
  setWatcherStatusEnum,
} from './watcher';
import {
  runBootReconcile,
  startPeriodicReconcile,
  stopPeriodicReconcile,
  type PeriodicHandle,
  type ReconcileDeps,
} from './reconcile';
import { ingestSingleFile } from './ingest';
// 50-03: the ONE media-eligibility predicate. See src/lib/scan/media-eligibility.ts
// for WHY this gates on the file EXTENSION and never on probe metadata — both
// reasons are MEASURED, and the naive alternative loses real media silently.
import {
  DEFAULT_MEDIA_EXTENSIONS,
  hasAllowedExtension,
  ingestFilterEnabled,
  normalizeExtensions,
  resolveAllowedExtensions,
} from '../scan/media-eligibility';
import { readMaxUserWatches } from './mount-detect';
import type { WatcherDeps, WatcherStatus } from './types';

interface ServiceState {
  started: boolean;
  periodicHandle: PeriodicHandle | null;
  // audit-added S3: debounced restart coalescing.
  pendingRestart: Promise<void> | null;
  pendingRestartDebounceTimer: NodeJS.Timeout | null;
}

const STATE: ServiceState = {
  started: false,
  periodicHandle: null,
  pendingRestart: null,
  pendingRestartDebounceTimer: null,
};

const RESTART_DEBOUNCE_MS = 500;
const MIN_RECOMMENDED_USER_WATCHES = 524_288;

// audit-added M10: orphan-file SQL helper. Selects files in 'pending' that
// have no active job (queued / encoding). Run AFTER runScan inside reconcile
// so newly-ingested rows are visible. Single SELECT, no writes.
//
// 50-03: `path` and `share_id` joined the projection so the media gate below can
// run. WHERE and LEFT JOIN are UNCHANGED — the gate is a JS filter, not a SQL
// predicate, because the allowlist differs per share and would only be
// expressible in SQL as string acrobatics.
//
// E13, an accepted cost stated openly: this query has no LIMIT (E7 / 28-06 R10),
// so a row now costs ~200 bytes instead of ~8. RECONCILE_ORPHAN_CAP bounds the
// ENQUEUE LOOP, not this SELECT. At 100 000 orphan rows that is ~20 MB transient
// instead of ~0.8 MB. Do NOT "fix" this with a LIMIT — that would push the gate
// behind the cap and change what it means.
const ORPHAN_QUERY = `
  SELECT file.id AS id,
         file.path AS path,
         file.share_id AS share_id
    FROM file
    LEFT JOIN job
      ON file.id = job.file_id
     AND job.status IN ('queued', 'encoding')
   WHERE file.status = 'pending'
     AND job.id IS NULL
`;

interface OrphanRow {
  id: number;
  path: string;
  share_id: number | null;
}

// E8: a gate that permanently removes rows from recovery has to be VISIBLE.
// At most 5 path samples on one info line per tick; nothing at all when it
// suppressed nothing.
const ORPHAN_GATE_SAMPLE_CAP = 5;

// Signature stays `(): number[]` towards ReconcileDeps (E7) — the logger is
// bound at the call site in buildReconcileDeps, so reconcile.ts and its tests
// are untouched.
function findOrphanFileIds(log: AppLogger): number[] {
  const db = getDb();
  const rows = db.prepare<[], OrphanRow>(ORPHAN_QUERY).all();

  // AC-11: with the kill-switch set this behaves EXACTLY as before 50-03 —
  // every id, no log line.
  if (!ingestFilterEnabled()) return rows.map((r) => r.id);

  // E12: ONE listAll() per tick, lifted into a map — never one read per row.
  const allowedByShare = new Map<number, Set<string>>();
  for (const share of defaultShareRepo().listAll()) {
    // The fallback wrapper, not the raw parse: a share with an empty
    // extensions_csv must not lose its orphans permanently (E10 / AC-19).
    allowedByShare.set(share.id, resolveAllowedExtensions(share.extensions_csv).set);
  }
  // share_id can be NULL — pre-0026 legacy rows, or a share deleted via
  // ON DELETE SET NULL (schema.ts:60-63). Those fall back to the default list.
  const fallback = normalizeExtensions(DEFAULT_MEDIA_EXTENSIONS);

  const kept: number[] = [];
  const samples: string[] = [];
  let suppressed = 0;
  for (const row of rows) {
    const allowed =
      (row.share_id !== null ? allowedByShare.get(row.share_id) : undefined) ?? fallback;
    // No separate isSidecarPath branch here on purpose: `.json` is in no
    // allowlist, so an explicit arm would be dead code feigning safety.
    if (hasAllowedExtension(row.path, allowed)) {
      kept.push(row.id);
      continue;
    }
    suppressed++;
    if (samples.length < ORPHAN_GATE_SAMPLE_CAP) samples.push(row.path);
  }

  if (suppressed > 0) {
    log.info(
      {
        action: 'auto_scan_orphan_media_gate_suppressed',
        suppressed,
        total: rows.length,
        samples,
      },
      'reconcile: orphan rows held back by the media-eligibility gate — this repeats every tick while the rows exist (there is deliberately no backfill; remove them via Library delete)',
    );
  }
  return kept;
}

function encoderFromSettings(): string {
  const raw = defaultSettingRepo().get('encoder');
  if (!raw || raw === 'auto') return 'libx265';
  return raw;
}

function emitQueueUpdated(): void {
  try {
    // 48-03: one listActive() pass yields all three numbers (queue/counts).
    const counts = queueCountsSnapshot(defaultJobRepo());
    engineEvents.emit({
      type: 'queue.updated',
      activeJobs: counts.activeJobs,
      pendingJobs: counts.pendingJobs,
      encodingJobs: counts.encodingJobs,
      // 32-02: real pause state (was hardcoded false) — shared with orchestrator emit.
      paused: isQueuePaused(),
    });
  } catch {
    // non-fatal
  }
}

function buildReconcileDeps(log: AppLogger): ReconcileDeps {
  return {
    shareRepo: defaultShareRepo,
    fileRepo: defaultFileRepo,
    jobRepo: defaultJobRepo,
    settingRepo: defaultSettingRepo,
    runScan,
    findOrphanFileIds: () => findOrphanFileIds(log),
    encoderResolver: encoderFromSettings,
    emitQueueUpdated,
    log,
  };
}

function buildWatcherDeps(log: AppLogger): WatcherDeps {
  return {
    shareRepo: defaultShareRepo,
    settingRepo: defaultSettingRepo,
    fileRepo: defaultFileRepo,
    jobRepo: defaultJobRepo,
    ingestSingleFile: (absPath, shareId) => {
      // 50-03 (E12/M5): resolve THIS file's share with getById — never listAll().
      // This runs once per watch event, so a full-table read here would be a
      // table scan per ingested file. A missing share (share_id NULL, or the row
      // deleted via ON DELETE SET NULL) behaves like the no-share case: the leaf
      // falls back to DEFAULT_MEDIA_EXTENSIONS and there is no size gate at all
      // (there is no min_size_mb without a share, and inventing one would be
      // worse than having none).
      //
      // Deliberately NO `watch_share_extensions_empty` warn here — this path runs
      // per FILE and would multiply the line. That warn belongs to onAddEvent,
      // once per share and watcher start (AC-19).
      const share = shareId === null ? undefined : defaultShareRepo().getById(shareId);
      return ingestSingleFile(absPath, shareId, {
        fileRepo: defaultFileRepo,
        jobRepo: defaultJobRepo,
        blocklistRepo: defaultBlocklistRepo,
        // 33-01 (audit-MH-1): the watch-path IngestDeps is built HERE, not in
        // watcher.ts. Without settingRepo, central mode never reaches the pipeline
        // from the watcher → Chris' re-queue bug stays UNFIXED on the primary unRAID trigger.
        settingRepo: defaultSettingRepo,
        log,
        encoderResolver: encoderFromSettings,
        ...(share
          ? {
              allowedExtensions: resolveAllowedExtensions(share.extensions_csv).set,
              minSizeBytes: share.min_size_mb * 1024 * 1024,
            }
          : {}),
      });
    },
    runReconcile: async () => {
      const result = await runBootReconcile(buildReconcileDeps(log));
      return { filesAdded: result.reconcileCount, filesUpdated: 0 };
    },
    emitQueueUpdated,
    log,
  };
}

export async function startWatcherService(log: AppLogger = defaultLogger): Promise<void> {
  if (STATE.started) return;

  // AC-9 default-ON seed.
  const settingRepo = defaultSettingRepo();
  if (settingRepo.get('autoScan.enabled') === undefined) {
    settingRepo.set('autoScan.enabled', 'true');
  }
  if (settingRepo.get('autoScan.enabled') !== 'true') {
    setWatcherStatusEnum('stopped');
    STATE.started = true;
    log.info({ action: 'auto_scan_disabled' }, 'auto-scan disabled — service idle');
    return;
  }

  // 16-02 AC-2: default-ON seed for boot-toggle. Backwards-compat — 16-01
  // installs continue to boot-scan because seed-value === 'true'.
  if (settingRepo.get('autoScan.bootScanOnStart') === undefined) {
    settingRepo.set('autoScan.bootScanOnStart', 'true');
  }

  // AC-11 preflight log when max_user_watches below recommended.
  const max = readMaxUserWatches();
  if (max !== null && max < MIN_RECOMMENDED_USER_WATCHES) {
    log.warn(
      {
        action: 'auto_scan_max_user_watches_low',
        currentValue: max,
        recommended: MIN_RECOMMENDED_USER_WATCHES,
      },
      'inotify max_user_watches below recommended — unRAID: append "echo 524288 > /proc/sys/fs/inotify/max_user_watches" to /boot/config/go',
    );
  }

  STATE.started = true;
  const watcherDeps = buildWatcherDeps(log);
  const reconcileDeps = buildReconcileDeps(log);

  try {
    await startWatcher(watcherDeps);
  } catch (err) {
    log.error(
      { action: 'auto_scan_start_failed', err: err instanceof Error ? err.stack : String(err) },
      'startWatcher threw — service stays stopped',
    );
    setWatcherStatusEnum('error');
    STATE.started = false;
    return;
  }

  // 16-02 AC-1: boot-scan gated by operator-tunable toggle. Periodic
  // reconcile schedule below is NOT gated — periodic-tick still runs even
  // when bootScanOnStart='false' (orphan-latency safety net).
  if (settingRepo.get('autoScan.bootScanOnStart') === 'true') {
    // Boot reconcile fire-and-forget so a slow disk-walk does NOT block route
    // boot. Result is recorded into module-state on completion.
    void runBootReconcile(reconcileDeps)
      .then((result) => {
        setReconcileResult(
          result.reconcileCount,
          result.orphanReEnqueueCount,
          new Date().toISOString(),
        );
      })
      // 28-05 R5: the fire-and-forget chain had NO .catch — a rejection from
      // runBootReconcile (or its .then) became an unhandled promise rejection
      // (crash vector). Catch + log .stack (mirrors auto_scan_start_failed /
      // auto_scan_periodic_reconcile_tick_failed). Startup itself is unaffected
      // — boot reconcile stays fire-and-forget; the periodic tick still runs.
      .catch((err) => {
        log.error(
          {
            action: 'auto_scan_boot_reconcile_unhandled',
            err: err instanceof Error ? err.stack : String(err),
          },
          'boot reconcile fire-and-forget rejected — recovered (periodic-tick still scheduled)',
        );
      });
  } else {
    log.info(
      { action: 'auto_scan_boot_reconcile_skipped' },
      'boot-scan-on-start disabled — skipping initial reconcile (periodic-tick still scheduled)',
    );
  }

  STATE.periodicHandle = startPeriodicReconcile(reconcileDeps, (result, atIso) => {
    setReconcileResult(result.reconcileCount, result.orphanReEnqueueCount, atIso);
  });
}

export async function stopWatcherService(): Promise<void> {
  if (!STATE.started) return;
  stopPeriodicReconcile(STATE.periodicHandle);
  STATE.periodicHandle = null;
  await stopWatcher();
  STATE.started = false;
}

// audit-added S3: debounced restart with in-flight coalesce. Multiple rapid
// flips (off → on → off → on) within 500 ms collapse to ONE restart. If a
// restart is already in-flight, callers await the pending promise instead of
// spawning a new chain.
export async function restartWatcherService(log: AppLogger = defaultLogger): Promise<void> {
  if (STATE.pendingRestart) {
    return STATE.pendingRestart;
  }
  if (STATE.pendingRestartDebounceTimer) {
    clearTimeout(STATE.pendingRestartDebounceTimer);
  }

  const promise = new Promise<void>((resolve, reject) => {
    STATE.pendingRestartDebounceTimer = setTimeout(() => {
      STATE.pendingRestartDebounceTimer = null;
      (async () => {
        try {
          await stopWatcherService();
          await startWatcherService(log);
          resolve();
        } catch (err) {
          reject(err);
        } finally {
          STATE.pendingRestart = null;
        }
      })();
    }, RESTART_DEBOUNCE_MS);
  });
  STATE.pendingRestart = promise;
  return promise;
}

export function getAutoScanStatus(): WatcherStatus {
  return getWatcherSnapshot();
}

export function __forTests_resetWatcherService(): void {
  STATE.started = false;
  if (STATE.pendingRestartDebounceTimer) {
    clearTimeout(STATE.pendingRestartDebounceTimer);
    STATE.pendingRestartDebounceTimer = null;
  }
  STATE.pendingRestart = null;
  if (STATE.periodicHandle) {
    stopPeriodicReconcile(STATE.periodicHandle);
    STATE.periodicHandle = null;
  }
  resetWatcherState();
}
