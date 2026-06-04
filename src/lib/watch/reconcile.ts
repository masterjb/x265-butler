// Phase 16-01 T3: boot + periodic reconcile.
//
// AC-6: full re-scan on watcher boot. AC-7: 6h periodic reconcile (default).
// AC-16 (audit-added M10): orphan-file sweep — re-enqueue any 'pending' file
// rows whose path is still on disk but never received an enqueue job (crash
// between upsertByPath and jobRepo.enqueue in T2 flushBatch).
//
// AC-15 (audit-added M4) re-enqueue path: dropped events from the 60 jobs/min
// rate-cap are recovered here via runScan re-discovery + skip-pipeline dedup.

import type pino from 'pino';
import type { ScanResult } from '../db/schema';
import type { ScanOptions } from '../scan/orchestrator';
import type { FileRepo } from '../db/repos/file';
import type { JobRepo } from '../db/repos/job';
import type { ShareRepo } from '../db/repos/share';
import type { SettingRepo } from '../db/repos/setting';

export interface ReconcileDeps {
  shareRepo: () => ShareRepo;
  fileRepo: () => FileRepo;
  jobRepo: () => JobRepo;
  settingRepo: () => SettingRepo;
  runScan: (opts: ScanOptions, repo: FileRepo, log?: pino.Logger) => Promise<ScanResult>;
  // audit-added M10: injectable SQL helper so tests don't need a real DB. In
  // production this is wired to `SELECT file.id FROM file LEFT JOIN job ON
  // file.id = job.file_id AND job.status IN ('queued','encoding') WHERE
  // file.status='pending' AND job.id IS NULL`.
  findOrphanFileIds: () => number[];
  encoderResolver: () => string;
  emitQueueUpdated: () => void;
  log: pino.Logger;
}

export interface ReconcileResult {
  reconcileCount: number;
  orphanReEnqueueCount: number;
}

export async function runBootReconcile(deps: ReconcileDeps): Promise<ReconcileResult> {
  const startedMs = Date.now();
  const shares = deps.shareRepo().listAll();
  if (shares.length === 0) {
    deps.log.info(
      { action: 'auto_scan_reconcile_skip_empty_shares' },
      'no shares — reconcile noop',
    );
    return { reconcileCount: 0, orphanReEnqueueCount: 0 };
  }

  // Multi-share dispatch lives inside runScan (orchestrator branches on
  // shareRepo().listAll().length > 0). We pass the first share as rootPath for
  // back-compat with the ScanOptions shape; the multi-share branch ignores it.
  let scanResult: ScanResult;
  try {
    scanResult = await deps.runScan(
      {
        rootPath: shares[0].path,
        extensions: shares[0].extensions_csv
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        minSizeMb: shares[0].min_size_mb,
        maxDepth: shares[0].max_depth ?? undefined,
      },
      deps.fileRepo(),
      deps.log,
    );
  } catch (err) {
    deps.log.error(
      {
        action: 'auto_scan_reconcile_run_scan_failed',
        err: err instanceof Error ? err.stack : String(err),
      },
      'reconcile runScan threw',
    );
    return { reconcileCount: 0, orphanReEnqueueCount: 0 };
  }

  const reconcileCount = (scanResult.filesAdded ?? 0) + (scanResult.filesUpdated ?? 0);

  // audit-added M10: orphan-file sweep. Files that survived runScan ingest but
  // never reached jobRepo.enqueue (crash mid-flushBatch). Token-bucket here is
  // implicit — POST is direct DB write via jobRepo.enqueue; the watcher's
  // 60/min rate cap is on chokidar events, not reconcile-driven recovery.
  let orphanReEnqueueCount = 0;
  let orphanIds: number[] = [];
  try {
    orphanIds = deps.findOrphanFileIds();
  } catch (err) {
    deps.log.warn(
      {
        action: 'auto_scan_reconcile_orphan_query_failed',
        err: err instanceof Error ? err.message : String(err),
      },
      'orphan-query threw — skipping orphan re-enqueue this tick',
    );
  }
  const encoder = deps.encoderResolver();
  for (const fileId of orphanIds) {
    const file = deps.fileRepo().getById(fileId);
    if (!file) continue;
    try {
      const job = deps.jobRepo().enqueue(file.id, encoder, file.version, null);
      if (job) orphanReEnqueueCount++;
    } catch (err) {
      deps.log.warn(
        {
          action: 'auto_scan_orphan_enqueue_failed',
          fileId,
          err: err instanceof Error ? err.message : String(err),
        },
        'orphan enqueue threw — skipping',
      );
    }
  }
  if (orphanReEnqueueCount > 0) deps.emitQueueUpdated();

  deps.log.info(
    {
      action: 'auto_scan_reconcile_complete',
      reconcileCount,
      orphanReEnqueueCount,
      durationMs: Date.now() - startedMs,
    },
    'auto-scan reconcile complete',
  );

  return { reconcileCount, orphanReEnqueueCount };
}

export interface PeriodicHandle {
  timer: NodeJS.Timeout;
}

export function startPeriodicReconcile(
  deps: ReconcileDeps,
  onResult: (r: ReconcileResult, atIso: string) => void,
): PeriodicHandle {
  const raw = deps.settingRepo().get('autoScan.reconcileIntervalH');
  const hours = raw ? parseFloat(raw) : 6;
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 6;
  const intervalMs = safeHours * 3600 * 1000;

  // 16-02 audit-added M2: mutex-guard so a slow reconcile body cannot overlap
  // with the next tick (relevant once reconcileIntervalH is lowered to 0.05).
  // Concurrent ticks observe in-flight=true and coalesce via skip.
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) {
      deps.log.debug(
        { action: 'auto_scan_periodic_reconcile_skipped_in_flight' },
        'periodic reconcile tick skipped — prior tick still running',
      );
      return;
    }
    inFlight = true;
    try {
      const result = await runBootReconcile(deps);
      onResult(result, new Date().toISOString());
    } catch (err) {
      deps.log.error(
        {
          action: 'auto_scan_periodic_reconcile_tick_failed',
          err: err instanceof Error ? err.stack : String(err),
        },
        'periodic reconcile tick threw — timer continues',
      );
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  return { timer };
}

export function stopPeriodicReconcile(handle: PeriodicHandle | null): void {
  if (handle) clearInterval(handle.timer);
}
