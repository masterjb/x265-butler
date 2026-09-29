// Phase 16-01: Auto-Scan watcher public API barrel.
//
// Wires server-init + Settings UI + /api/health to the watcher service.
// Implementation modules:
//   - mount-detect.ts  : AC-5 + AC-11 probes
//   - watcher.ts       : chokidar lifecycle + batch + rate-cap (AC-1..AC-5)
//   - reconcile.ts     : boot + 6h reconcile + orphan sweep (AC-6, AC-7, AC-16)

export type {
  WatcherStatus,
  WatcherStatusEnum,
  PollingMode,
  InotifyError,
  SingleFileIngestResult,
  WatcherDeps,
} from './types';

// service.ts (T4) wires startWatcherService / stopWatcherService /
// restartWatcherService / getAutoScanStatus on top of watcher.ts (T2) +
// reconcile.ts (T3). Re-export here to keep call-sites in server-init.ts +
// app/api/* + components/* stable.
export {
  startWatcherService,
  stopWatcherService,
  restartWatcherService,
  getAutoScanStatus,
  __forTests_resetWatcherService,
} from './service';
