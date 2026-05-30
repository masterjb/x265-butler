// Phase 16-01 T2: chokidar watcher core.
//
// Module-state holds the active chokidar instance(s), per-share batch buffers
// + flushTimers, ENOSPC backoff state, and the public WatcherStatus snapshot.
// Tests inject a fake chokidar factory via __setWatcherFactoryForTests.
//
// Boundary: scan/orchestrator.ts signature is NOT touched. flushBatch composes
// single-file ingest via deps.ingestSingleFile (see watch/ingest.ts).

import { watch as defaultChokidarWatch, type FSWatcher } from 'chokidar';
import { detectMountMode, readMaxUserWatches, countCurrentInotifyWatches } from './mount-detect';
import type { WatcherStatus, WatcherStatusEnum, WatcherDeps, PollingMode } from './types';
import type { ShareRow } from '../db/schema';

const DEFAULTS = {
  stabilityThresholdMs: 10_000,
  awaitWritePollMs: 1_000,
  batchWindowMs: 5_000,
  forcedPollingIntervalMs: 2_000,
  rateLimitPerMinute: 60,
} as const;

// audit-added S1: exponential backoff for inotify ENOSPC recovery.
const ENOSPC_BACKOFF_MS: readonly number[] = [10_000, 60_000, 5 * 60_000, 30 * 60_000, 60 * 60_000];

export interface WatcherFactory {
  watch: (paths: string | readonly string[], opts: Record<string, unknown>) => FSWatcher;
}

interface WatcherState {
  mainInstance: FSWatcher | null;
  pollingInstances: Map<string, FSWatcher>;
  batchBuffers: Map<number, Map<string, number>>;
  flushTimers: Map<number, NodeJS.Timeout>;
  rateLimitTimestamps: number[];
  droppedTimestamps: number[];
  enospcRetryIndex: number;
  enospcRetryTimer: NodeJS.Timeout | null;
  shares: ShareRow[];
  status: WatcherStatus;
}

function freshStatus(): WatcherStatus {
  return {
    status: 'stopped',
    lastEventAt: null,
    lastReconcileAt: null,
    bootReconcileCount: 0,
    orphanReEnqueueCountAtBoot: 0,
    droppedEventsLast24h: 0,
    inotifyError: null,
    currentInotifyWatches: null,
    maxUserWatches: null,
    pollingModeByShare: {},
  };
}

function freshState(): WatcherState {
  return {
    mainInstance: null,
    pollingInstances: new Map(),
    batchBuffers: new Map(),
    flushTimers: new Map(),
    rateLimitTimestamps: [],
    droppedTimestamps: [],
    enospcRetryIndex: 0,
    enospcRetryTimer: null,
    shares: [],
    status: freshStatus(),
  };
}

let state: WatcherState = freshState();
let depsRef: WatcherDeps | null = null;
let factoryRef: WatcherFactory = { watch: defaultChokidarWatch as WatcherFactory['watch'] };

export function __setWatcherFactoryForTests(f: WatcherFactory): void {
  factoryRef = f;
}

export function __resetWatcherFactoryForTests(): void {
  factoryRef = { watch: defaultChokidarWatch as WatcherFactory['watch'] };
}

export function resetWatcherState(): void {
  for (const t of state.flushTimers.values()) clearTimeout(t);
  if (state.enospcRetryTimer) clearTimeout(state.enospcRetryTimer);
  state = freshState();
  depsRef = null;
}

function readSettingInt(key: string, def: number): number {
  const repo = depsRef?.settingRepo();
  if (!repo) return def;
  const raw = repo.get(key);
  if (raw === undefined) return def;
  // 16-02 audit-added M8: defensive parse. parseInt('  12000  ', 10) === 12000
  // (native whitespace-strip — leading/trailing OK, no warn). Empty-string and
  // non-numeric values fall back to default + emit log.warn for forensics.
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    depsRef?.log?.warn(
      { action: 'auto_scan_setting_malformed', key, rawValue: raw, fallback: def },
      'auto-scan setting value is malformed — falling back to default',
    );
    return def;
  }
  return n;
}

function findShareForPath(absPath: string): ShareRow | undefined {
  let best: ShareRow | undefined;
  for (const s of state.shares) {
    const prefix = s.path === '/' ? '/' : s.path + '/';
    if (absPath === s.path || absPath.startsWith(prefix)) {
      if (!best || s.path.length > best.path.length) best = s;
    }
  }
  return best;
}

function buildChokidarOpts(usePolling: boolean): Record<string, unknown> {
  const stabilityThreshold = readSettingInt(
    'autoScan.stabilityThreshold',
    DEFAULTS.stabilityThresholdMs,
  );
  const pollInterval = readSettingInt('autoScan.pollInterval', DEFAULTS.forcedPollingIntervalMs);
  return {
    // eslint-disable-next-line no-useless-escape
    ignored: /(^|[\/\\])\../,
    persistent: true,
    ignoreInitial: true,
    atomic: true,
    awaitWriteFinish: { stabilityThreshold, pollInterval: DEFAULTS.awaitWritePollMs },
    depth: 99,
    usePolling,
    ...(usePolling ? { interval: pollInterval } : {}),
  };
}

export async function startWatcher(deps: WatcherDeps): Promise<void> {
  if (state.mainInstance || state.pollingInstances.size > 0) return;

  depsRef = deps;

  // audit-added S7: warn when env-override forces polling for all watchers.
  if (process.env.CHOKIDAR_USEPOLLING === '1') {
    deps.log.warn(
      { action: 'auto_scan_env_polling_override' },
      'CHOKIDAR_USEPOLLING=1 set — overrides auto-detect for all shares; unset for production',
    );
  }

  state.shares = deps.shareRepo().listAll();
  state.status.pollingModeByShare = {};

  const inotifyPaths: string[] = [];
  const forcedPollingShares: ShareRow[] = [];
  for (const share of state.shares) {
    const mode: PollingMode = detectMountMode(share.path);
    state.status.pollingModeByShare[share.name] = mode;
    if (mode === 'polling-forced') forcedPollingShares.push(share);
    else inotifyPaths.push(share.path);
  }

  if (inotifyPaths.length > 0) {
    const inst = factoryRef.watch(inotifyPaths, buildChokidarOpts(false));
    wireInstanceHandlers(inst, deps);
    state.mainInstance = inst;
  }

  for (const share of forcedPollingShares) {
    const inst = factoryRef.watch(share.path, buildChokidarOpts(true));
    wireInstanceHandlers(inst, deps);
    state.pollingInstances.set(share.path, inst);
  }

  state.status.status = 'running';
  state.status.inotifyError = null;
  state.status.maxUserWatches = readMaxUserWatches();
  state.status.currentInotifyWatches = countCurrentInotifyWatches();
}

function wireInstanceHandlers(inst: FSWatcher, deps: WatcherDeps): void {
  inst.on('add', (filePath: string) => {
    onAddEvent(filePath, deps);
  });
  inst.on('error', (err: unknown) => {
    onWatcherError(err as Error, deps);
  });
}

function onAddEvent(absPath: string, deps: WatcherDeps): void {
  const share = findShareForPath(absPath);
  if (!share) return;
  let buf = state.batchBuffers.get(share.id);
  if (!buf) {
    buf = new Map();
    state.batchBuffers.set(share.id, buf);
  }
  buf.set(absPath, Date.now());

  if (!state.flushTimers.has(share.id)) {
    const window = readSettingInt('autoScan.batchWindow', DEFAULTS.batchWindowMs);
    const timer = setTimeout(() => {
      state.flushTimers.delete(share.id);
      void flushBatch(share.id, deps);
    }, window);
    state.flushTimers.set(share.id, timer);
  }
}

async function flushBatch(shareId: number, deps: WatcherDeps): Promise<void> {
  const buf = state.batchBuffers.get(shareId);
  if (!buf) return;
  state.batchBuffers.delete(shareId);

  for (const absPath of buf.keys()) {
    const now = Date.now();
    state.rateLimitTimestamps = state.rateLimitTimestamps.filter((t) => now - t < 60_000);
    if (state.rateLimitTimestamps.length >= DEFAULTS.rateLimitPerMinute) {
      recordDropped(now);
      deps.log.warn(
        {
          action: 'auto_scan_rate_cap_drop',
          absPath,
          rateLast60s: state.rateLimitTimestamps.length,
        },
        'auto-scan rate cap exceeded — file dropped (next reconcile recovers it)',
      );
      continue;
    }
    state.rateLimitTimestamps.push(now);

    try {
      const result = await deps.ingestSingleFile(absPath, shareId);
      if (result.enqueued) {
        state.status.lastEventAt = new Date(now).toISOString();
      }
    } catch (err) {
      deps.log.warn(
        {
          action: 'auto_scan_ingest_failed',
          absPath,
          err: err instanceof Error ? err.message : String(err),
        },
        'ingestSingleFile threw — file dropped (next reconcile recovers it)',
      );
    }
  }
}

function recordDropped(nowMs: number): void {
  state.droppedTimestamps.push(nowMs);
  const cutoff = nowMs - 24 * 3600 * 1000;
  state.droppedTimestamps = state.droppedTimestamps.filter((t) => t >= cutoff);
  state.status.droppedEventsLast24h = state.droppedTimestamps.length;
}

interface MaybeCoded {
  code?: string;
}

function onWatcherError(err: Error, deps: WatcherDeps): void {
  const code = (err as Error & MaybeCoded).code;
  if (code === 'ENOSPC') {
    state.status.status = 'error';
    state.status.inotifyError = { code, message: err.message };
    deps.log.error(
      { err: err.message, action: 'auto_scan_enospc' },
      'inotify ENOSPC — raise /proc/sys/fs/inotify/max_user_watches (unRAID: append to /boot/config/go → "echo 524288 > /proc/sys/fs/inotify/max_user_watches")',
    );
    scheduleEnospcRetry(deps);
    return;
  }
  deps.log.warn(
    { err: err.message, code, action: 'auto_scan_watch_error' },
    'watcher emitted error',
  );
}

function scheduleEnospcRetry(deps: WatcherDeps): void {
  if (state.enospcRetryTimer) return;
  const idx = Math.min(state.enospcRetryIndex, ENOSPC_BACKOFF_MS.length - 1);
  const delay = ENOSPC_BACKOFF_MS[idx];
  state.enospcRetryIndex = Math.min(state.enospcRetryIndex + 1, ENOSPC_BACKOFF_MS.length - 1);

  state.enospcRetryTimer = setTimeout(() => {
    state.enospcRetryTimer = null;
    void (async () => {
      try {
        await stopWatcher();
        await startWatcher(deps);
        if (state.status.status === 'running') {
          state.enospcRetryIndex = 0;
          deps.log.info(
            { action: 'auto_scan_enospc_recovered' },
            'auto-scan ENOSPC recovered — watcher running again',
          );
        } else {
          scheduleEnospcRetry(deps);
        }
      } catch {
        scheduleEnospcRetry(deps);
      }
    })();
  }, delay);
}

export async function stopWatcher(): Promise<void> {
  for (const t of state.flushTimers.values()) clearTimeout(t);
  state.flushTimers.clear();
  state.batchBuffers.clear();
  if (state.enospcRetryTimer) {
    clearTimeout(state.enospcRetryTimer);
    state.enospcRetryTimer = null;
  }

  const closes: Promise<void>[] = [];
  if (state.mainInstance) closes.push(state.mainInstance.close());
  for (const inst of state.pollingInstances.values()) closes.push(inst.close());
  await Promise.allSettled(closes);

  state.mainInstance = null;
  state.pollingInstances.clear();
  state.status.status = 'stopped';
}

export function addShareToWatcher(share: ShareRow, deps: WatcherDeps): void {
  if (!state.shares.find((s) => s.id === share.id)) state.shares.push(share);
  const mode: PollingMode = detectMountMode(share.path);
  state.status.pollingModeByShare[share.name] = mode;
  if (mode === 'polling-forced') {
    const inst = factoryRef.watch(share.path, buildChokidarOpts(true));
    wireInstanceHandlers(inst, deps);
    state.pollingInstances.set(share.path, inst);
    return;
  }
  if (state.mainInstance) {
    state.mainInstance.add(share.path);
  } else {
    const inst = factoryRef.watch(share.path, buildChokidarOpts(false));
    wireInstanceHandlers(inst, deps);
    state.mainInstance = inst;
  }
}

export function removeShareFromWatcher(sharePath: string): void {
  const target = state.shares.find((s) => s.path === sharePath);
  if (target) {
    // audit-added S4: drain buffer + clear flushTimer BEFORE unwatch to drop
    // any pending events for the removed share. Next reconcile-tick re-discovers
    // surviving files; in-flight events for the removed share are silently
    // dropped (the share is gone — re-detecting them as orphans would be wrong).
    state.batchBuffers.delete(target.id);
    const timer = state.flushTimers.get(target.id);
    if (timer) {
      clearTimeout(timer);
      state.flushTimers.delete(target.id);
    }
    delete state.status.pollingModeByShare[target.name];
    state.shares = state.shares.filter((s) => s.id !== target.id);
  }
  const polling = state.pollingInstances.get(sharePath);
  if (polling) {
    void polling.close();
    state.pollingInstances.delete(sharePath);
    return;
  }
  if (state.mainInstance) {
    state.mainInstance.unwatch(sharePath);
  }
}

export function getWatcherSnapshot(): WatcherStatus {
  const live = countCurrentInotifyWatches();
  return {
    status: state.status.status,
    lastEventAt: state.status.lastEventAt,
    lastReconcileAt: state.status.lastReconcileAt,
    bootReconcileCount: state.status.bootReconcileCount,
    orphanReEnqueueCountAtBoot: state.status.orphanReEnqueueCountAtBoot,
    droppedEventsLast24h: state.status.droppedEventsLast24h,
    inotifyError: state.status.inotifyError ? { ...state.status.inotifyError } : null,
    currentInotifyWatches: live ?? state.status.currentInotifyWatches,
    maxUserWatches: state.status.maxUserWatches,
    pollingModeByShare: { ...state.status.pollingModeByShare },
  };
}

export function setWatcherStatusEnum(s: WatcherStatusEnum): void {
  state.status.status = s;
}

export function setReconcileResult(
  reconcileCount: number,
  orphanReEnqueueCount: number,
  atIso: string,
): void {
  state.status.bootReconcileCount = reconcileCount;
  state.status.orphanReEnqueueCountAtBoot = orphanReEnqueueCount;
  state.status.lastReconcileAt = atIso;
}

export function __forTests_getInternalState(): WatcherState {
  return state;
}
