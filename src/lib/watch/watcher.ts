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
import { resolvePollIntervalMs } from './poll-interval';
import { logger as defaultLogger } from '../logger';
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
  // 28-05 R2: monotonic teardown epoch. Bumped by stopWatcher(); a fresh
  // freshState() resets it to 0. flushBatch captures BOTH this object ref and
  // this value at entry and re-checks after each await to abort an in-flight
  // drain that outlived teardown (ghost-ingest guard).
  epoch: number;
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
    pollingShares: {},
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
    epoch: 0,
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

// 42-01: raw operator-explicit autoScan.pollInterval (NOT readSettingInt, whose
// default-fallback cannot distinguish "unset" from "operator typed 2000"). The
// resolver needs the raw absence so a stored old-default does NOT disable the
// size-scaling on every existing install (AC-8). Returns null when unset/malformed.
function explicitPollIntervalSetting(): number | null {
  const repo = depsRef?.settingRepo();
  if (!repo) return null;
  const raw = repo.get('autoScan.pollInterval');
  if (raw === undefined) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

// 42-01: cheap watched-file count for a forced-polling share. Proxy for the
// chokidar watched-path count — fileRepo holds the already-scanned rows; the
// resolver applies PATHS_PER_FILE to bridge files→paths (depth:99 stats dirs
// too). Counted ONCE at share-start (NOT per poll). Failure → 0 → base interval.
function countFilesForShare(share: ShareRow): number {
  try {
    return (
      depsRef?.fileRepo().countByQuery({
        page: 1,
        size: 1,
        sort: 'scanned',
        dir: 'desc',
        shareId: share.id,
      }) ?? 0
    );
  } catch {
    return 0;
  }
}

// 42-01: resolve the poll interval for ONE forced-polling share AND record its
// stat-rate diagnostics into the status snapshot (AC-4). Returns the resolved ms
// for buildChokidarOpts. Called once per share-start.
function resolvePollingForShare(share: ShareRow): number {
  const watchedFileCount = countFilesForShare(share);
  const res = resolvePollIntervalMs(
    { watchedFileCount, settingExplicitMs: explicitPollIntervalSetting() },
    depsRef?.log ?? defaultLogger,
  );
  state.status.pollingShares[share.name] = {
    watchedFileCount: res.watchedFileCount,
    realPaths: res.realPaths,
    pathMultiplier: res.pathMultiplier,
    effectiveIntervalMs: res.ms,
    intervalSource: res.source,
    computedStatsPerSec: res.computedStatsPerSec,
  };
  return res.ms;
}

function buildChokidarOpts(usePolling: boolean, intervalMs?: number): Record<string, unknown> {
  const stabilityThreshold = readSettingInt(
    'autoScan.stabilityThreshold',
    DEFAULTS.stabilityThresholdMs,
  );
  return {
    // eslint-disable-next-line no-useless-escape
    ignored: /(^|[\/\\])\../,
    persistent: true,
    ignoreInitial: true,
    atomic: true,
    // audit-added S1 (AC-9): awaitWriteFinish.pollInterval stays at the fixed ~1 s
    // DELIBERATELY. It polls ONLY files currently being written + stabilizing (a
    // bounded, transient set ≈ the handful of in-flight encode outputs), NOT the
    // whole tree — so it is a small residual stat-source, not the storm. The storm
    // is the main `interval` over ALL ~124 k watched paths, which 42-01 scales.
    // Scaling this 1 s poll too would only delay stability-detection of new files
    // for negligible pool relief. Documented as accepted residual (CLAUDE.md).
    awaitWriteFinish: { stabilityThreshold, pollInterval: DEFAULTS.awaitWritePollMs },
    depth: 99,
    usePolling,
    // 42-02 (strace-confirmed 2026-06-25): chokidar's polling path uses TWO
    // separate stat-intervals — `interval` for non-binary files and
    // `binaryInterval` (default 300 ms) for binary-extension paths
    // (.mkv/.mp4/.jpg/.png/...). 42-01 scaled ONLY `interval`, so a media share —
    // where ~every watched path is a binary extension — kept polling at the 300 ms
    // default regardless of WATCH_POLL_INTERVAL_MS. Reporter: env=60000 + diagnostics
    // `intervalSource=env` BUT strace still ~59 k statx/s on /media/*.jpg/.png/.mkv.
    // Pin BOTH to the resolved interval so the env/scaled cap actually governs the
    // whole tree (the diagnostics computedStatsPerSec already assumes one rate).
    ...(usePolling
      ? {
          interval: intervalMs ?? DEFAULTS.forcedPollingIntervalMs,
          binaryInterval: intervalMs ?? DEFAULTS.forcedPollingIntervalMs,
        }
      : {}),
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
  state.status.pollingShares = {};

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
    const intervalMs = resolvePollingForShare(share);
    const inst = factoryRef.watch(share.path, buildChokidarOpts(true, intervalMs));
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

// 28-06 P9: ingest-window concurrency cap. Read PER FLUSH (cheap — the flush
// runs at most every batchWindow ≈5s) so an operator can flip
// WATCH_INGEST_CONCURRENCY without a restart, AND in-suite tests can exercise
// different caps. audit-added SR-1: malformed values (NaN/0/neg/empty) are
// SILENTLY coerced to 4 — NO log.warn (unlike readSettingInt's
// auto_scan_setting_malformed). Deliberate: a per-flush read of a persistently-
// bad env var would spam the log every ~5s window; the silent-coerce contract is
// documented in CLAUDE.md (Task 3, 28-06).
function ingestConcurrency(): number {
  const n = Number(process.env.WATCH_INGEST_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4; // NaN/0/neg/empty → 4
}

async function flushBatch(shareId: number, deps: WatcherDeps): Promise<void> {
  const buf = state.batchBuffers.get(shareId);
  if (!buf) return;
  state.batchBuffers.delete(shareId);

  // 28-05 R2: capture the state-object reference AND its epoch at entry. After
  // each await we re-check both — the `state !== myState` arm catches
  // resetWatcherState() (a NEW freshState() object whose epoch is also 0, so a
  // value-only compare would miss it), and the `state.epoch !== myEpoch` arm
  // catches stopWatcher() (SAME object, bumped epoch). Either change aborts the
  // remaining drain so a flush that outlived teardown cannot keep ingesting /
  // mutating status post-stop (ghost-ingest).
  const myState = state;
  const myEpoch = state.epoch;

  // 28-06 P9 PHASE 1 — synchronous rate-cap admission pre-pass (NO await,
  // order-preserving over buf.keys()). Hoisting the 60/min decision out of the
  // await loop keeps it byte-identical to the pre-28-06 admission: the cap
  // decision is synchronous + deterministic regardless of window parallelism
  // (AC-3). The pre-pass clusters all admitted timestamps at flush-start; in the
  // pathological case of a single drain spanning >60s this enforces a hard
  // 60/flush rather than the old interleaved aging — a convergence toward the
  // intended 60/min, not a regression (audit SR-3, see plan boundaries).
  const admitted: Array<{ absPath: string; at: number }> = [];
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
    admitted.push({ absPath, at: now });
  }

  // 28-06 P9 PHASE 2+3 — windowed parallel ingest + serial epoch-guarded drain.
  // Each window overlaps the async stat/hash/ffprobe I/O of ≤cap files; the
  // synchronous better-sqlite3 writes inside ingestSingleFile serialize on the
  // JS thread regardless (same conclusion as 28-04 P2). The epoch-guard
  // PROTECTION is preserved — only the residual-in-flight granularity grows from
  // 1 (28-05) to ≤K — and is re-checked BEFORE dispatching a window (no new
  // window after teardown) AND after the window settles (no post-teardown
  // lastEventAt mutation).
  const cap = ingestConcurrency();
  for (let i = 0; i < admitted.length; i += cap) {
    if (state !== myState || state.epoch !== myEpoch) {
      deps.log.info(
        { action: 'auto_scan_flush_aborted_on_teardown', shareId },
        'flush aborted — watcher torn down mid-drain; remaining files deferred to next reconcile',
      );
      return;
    }
    const window = admitted.slice(i, i + cap);
    const results = await Promise.allSettled(
      window.map((w) => deps.ingestSingleFile(w.absPath, shareId)),
    );
    if (state !== myState || state.epoch !== myEpoch) {
      deps.log.info(
        { action: 'auto_scan_flush_aborted_on_teardown', shareId },
        'flush aborted — watcher torn down mid-drain; remaining files deferred to next reconcile',
      );
      return;
    }
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled') {
        if (r.value.enqueued) state.status.lastEventAt = new Date(window[j].at).toISOString();
      } else {
        deps.log.warn(
          {
            action: 'auto_scan_ingest_failed',
            absPath: window[j].absPath,
            err: r.reason instanceof Error ? r.reason.message : String(r.reason),
          },
          'ingestSingleFile threw — file dropped (next reconcile recovers it)',
        );
      }
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
  // 28-05 R2: invalidate any in-flight flush on THIS same state object. An
  // already-fired flushBatch whose ingest await is pending will see the bumped
  // epoch on resume and abort the rest of its drain (resetWatcherState() is
  // covered separately by the state-identity arm — it swaps the object).
  state.epoch += 1;
}

export function addShareToWatcher(share: ShareRow, deps: WatcherDeps): void {
  if (!state.shares.find((s) => s.id === share.id)) state.shares.push(share);
  const mode: PollingMode = detectMountMode(share.path);
  state.status.pollingModeByShare[share.name] = mode;
  if (mode === 'polling-forced') {
    const intervalMs = resolvePollingForShare(share);
    const inst = factoryRef.watch(share.path, buildChokidarOpts(true, intervalMs));
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
    delete state.status.pollingShares[target.name];
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
    pollingShares: { ...state.status.pollingShares },
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
