// Auto-Scan watcher public API barrel.
//
// Wires server-init + Settings UI + /api/health to the watcher service.
// Implementation modules:
//   - mount-detect.ts  : mount-mode + inotify-budget probes
//   - watcher.ts       : chokidar lifecycle + batch + rate-cap
//   - reconcile.ts     : boot + 6h reconcile + orphan sweep

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
  triggerAutoEncodeSweep,
  getAutoScanStatus,
  __forTests_resetWatcherService,
} from './service';
