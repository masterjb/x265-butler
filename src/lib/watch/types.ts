// Phase 16-01: Auto-Scan watcher type contracts.

import type pino from 'pino';
import type { ShareRepo } from '../db/repos/share';
import type { SettingRepo } from '../db/repos/setting';
import type { FileRepo } from '../db/repos/file';
import type { JobRepo } from '../db/repos/job';

export type PollingMode = 'inotify' | 'polling-auto' | 'polling-forced';

export type WatcherStatusEnum = 'running' | 'error' | 'stopped';

export interface InotifyError {
  code: string;
  message: string;
}

// 42-01: per-forced-polling-share stat-rate diagnostics. Captured ONCE at
// share-start when the poll interval is resolved (resolvePollIntervalMs).
// Surfaced to /api/diagnostics so the FUSE stat-storm is diagnosable without
// shell access (AC-4). realPaths = watchedFileCount × pathMultiplier (depth:99
// stats dirs too); computedStatsPerSec is derived from realPaths (AC-10).
// 42-03: the realPaths/computedStatsPerSec fields above are the PATHS_PER_FILE=10
// ESTIMATE; the actual* pair below is chokidar's getWatched()-measured ground
// truth (null until 'ready'). Estimate kept for direct heuristic-vs-measured
// comparison — the heuristic under-reported ~3× on the operator's tree.
export interface PollingShareDiag {
  watchedFileCount: number;
  realPaths: number;
  pathMultiplier: number;
  effectiveIntervalMs: number;
  intervalSource: 'env' | 'setting' | 'scaled' | 'default';
  computedStatsPerSec: number;
  // 42-03: chokidar getWatched()-measured ground truth, captured at the 'ready'
  // event. null until ready (or when the watch factory has no getWatched, e.g.
  // tests). Exposes the real stat-rate so the estimate above is auditable — the
  // PATHS_PER_FILE=10 heuristic under-reported ~3× on the operator's tree (the
  // estimate fields are kept for direct heuristic-vs-measured comparison).
  actualWatchedPaths: number | null;
  actualPathMultiplier: number | null; // actualWatchedPaths / watchedFileCount, 1 decimal
  actualStatsPerSec: number | null;
}

export interface WatcherStatus {
  status: WatcherStatusEnum;
  lastEventAt: string | null;
  lastReconcileAt: string | null;
  bootReconcileCount: number;
  orphanReEnqueueCountAtBoot: number;
  droppedEventsLast24h: number;
  inotifyError: InotifyError | null;
  currentInotifyWatches: number | null;
  maxUserWatches: number | null;
  pollingModeByShare: Record<string, PollingMode>;
  // 42-01: keyed by share.name; populated only for forced-polling shares.
  pollingShares: Record<string, PollingShareDiag>;
}

// 16-01 T2: single-file ingest signature consumed by flushBatch. Watcher
// composes existing primitives (hashFile + ffprobe + fileRepo.upsertByPath +
// runSkipPipeline + jobRepo.enqueue) instead of re-walking the whole share
// via runScan — boundary preserved (scan/orchestrator.ts signature untouched).
export interface SingleFileIngestResult {
  enqueued: boolean;
  skipped: boolean;
  reason?: string;
  fileId?: number;
  jobId?: number;
}

export interface WatcherDeps {
  shareRepo: () => ShareRepo;
  settingRepo: () => SettingRepo;
  fileRepo: () => FileRepo;
  jobRepo: () => JobRepo;
  ingestSingleFile: (absPath: string, shareId: number | null) => Promise<SingleFileIngestResult>;
  runReconcile: () => Promise<{ filesAdded: number; filesUpdated: number }>;
  emitQueueUpdated: () => void;
  log: pino.Logger;
}
