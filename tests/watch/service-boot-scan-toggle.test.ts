// Phase 16-02 T1 — boot-toggle gate verification (AC-1 / AC-2).
//
// Asserts that startWatcherService honors `autoScan.bootScanOnStart` gate:
//   - undefined (fresh install) → default-seeded to 'true' → boot-scan runs
//   - 'true' → boot-scan runs
//   - 'false' → boot-scan SKIPPED + log.info auto_scan_boot_reconcile_skipped
//   - 'autoScan.enabled'='false' (any bootScanOnStart) → no startWatcher at all
//   - periodic-reconcile still scheduled even when boot-scan skipped
//
// vi.mock replaces watcher + reconcile modules so we can spy on the boot path
// without touching real chokidar / orchestrator.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted: required because vi.mock factories are hoisted above imports;
// any const referenced inside a factory must also live in hoisted scope.
const {
  settingStore,
  startWatcherSpy,
  stopWatcherSpy,
  runBootReconcileSpy,
  startPeriodicReconcileSpy,
  stopPeriodicReconcileSpy,
} = vi.hoisted(() => ({
  settingStore: new Map<string, string>(),
  startWatcherSpy: vi.fn(async () => {}),
  stopWatcherSpy: vi.fn(async () => {}),
  runBootReconcileSpy: vi.fn(async () => ({ reconcileCount: 0, orphanReEnqueueCount: 0 })),
  startPeriodicReconcileSpy: vi.fn(() => ({ timer: setInterval(() => {}, 1_000_000) })),
  stopPeriodicReconcileSpy: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({
    get: (k: string) => settingStore.get(k),
    set: (k: string, v: string) => settingStore.set(k, v),
    getAll: () => Object.fromEntries(settingStore),
  }),
  shareRepo: () => ({ listAll: () => [] }),
  fileRepo: () => ({}),
  jobRepo: () => ({ listActive: () => [], countByStatus: () => 0 }),
  blocklistRepo: () => ({}),
  getDb: () => ({
    prepare: () => ({ all: () => [] }),
  }),
}));

vi.mock('@/src/lib/scan/orchestrator', () => ({
  runScan: vi.fn(async () => ({
    rootPath: '/',
    filesScanned: 0,
    filesAdded: 0,
    filesUpdated: 0,
    filesUnchanged: 0,
    filesFailed: 0,
    filesVanished: 0,
    durationMs: 0,
    startedAt: 0,
    finishedAt: 0,
  })),
}));

vi.mock('@/src/lib/encode/events', () => ({
  engineEvents: { emit: vi.fn() },
}));

vi.mock('@/src/lib/watch/mount-detect', () => ({
  readMaxUserWatches: () => 524288,
  countCurrentInotifyWatches: () => 0,
  detectMountMode: () => 'inotify' as const,
}));

vi.mock('@/src/lib/watch/watcher', () => ({
  startWatcher: startWatcherSpy,
  stopWatcher: stopWatcherSpy,
  getWatcherSnapshot: () => ({
    status: 'running',
    lastEventAt: null,
    lastReconcileAt: null,
    bootReconcileCount: 0,
    orphanReEnqueueCountAtBoot: 0,
    droppedEventsLast24h: 0,
    inotifyError: null,
    currentInotifyWatches: null,
    maxUserWatches: null,
    pollingModeByShare: {},
  }),
  resetWatcherState: vi.fn(),
  setReconcileResult: vi.fn(),
  setWatcherStatusEnum: vi.fn(),
}));

vi.mock('@/src/lib/watch/reconcile', () => ({
  runBootReconcile: runBootReconcileSpy,
  startPeriodicReconcile: startPeriodicReconcileSpy,
  stopPeriodicReconcile: stopPeriodicReconcileSpy,
}));

vi.mock('@/src/lib/watch/ingest', () => ({
  ingestSingleFile: vi.fn(),
}));

import { startWatcherService, __forTests_resetWatcherService } from '@/src/lib/watch/service';

function makeLog() {
  const logFns = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return Object.assign(logFns, { child: () => logFns });
}

beforeEach(() => {
  settingStore.clear();
  startWatcherSpy.mockClear();
  stopWatcherSpy.mockClear();
  runBootReconcileSpy.mockClear();
  startPeriodicReconcileSpy.mockClear();
  stopPeriodicReconcileSpy.mockClear();
  __forTests_resetWatcherService();
});

afterEach(() => {
  __forTests_resetWatcherService();
});

describe('startWatcherService — boot-scan toggle gate (16-02 AC-1 / AC-2)', () => {
  it('autoScan.enabled=true + bootScanOnStart unset → seed-default + runBootReconcile called once', async () => {
    settingStore.set('autoScan.enabled', 'true');
    const log = makeLog();

    await startWatcherService(log as never);
    // microtask flush for fire-and-forget runBootReconcile
    await Promise.resolve();
    await Promise.resolve();

    expect(settingStore.get('autoScan.bootScanOnStart')).toBe('true');
    expect(startWatcherSpy).toHaveBeenCalledTimes(1);
    expect(runBootReconcileSpy).toHaveBeenCalledTimes(1);
  });

  it('autoScan.enabled=true + bootScanOnStart=true → runBootReconcile called', async () => {
    settingStore.set('autoScan.enabled', 'true');
    settingStore.set('autoScan.bootScanOnStart', 'true');
    const log = makeLog();

    await startWatcherService(log as never);
    await Promise.resolve();
    await Promise.resolve();

    expect(runBootReconcileSpy).toHaveBeenCalledTimes(1);
  });

  it('autoScan.enabled=true + bootScanOnStart=false → runBootReconcile NOT called + skipped-log emitted', async () => {
    settingStore.set('autoScan.enabled', 'true');
    settingStore.set('autoScan.bootScanOnStart', 'false');
    const log = makeLog();

    await startWatcherService(log as never);
    await Promise.resolve();

    expect(runBootReconcileSpy).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auto_scan_boot_reconcile_skipped' }),
      expect.any(String),
    );
  });

  it('autoScan.enabled=false (any bootScanOnStart) → startWatcher AND runBootReconcile NOT called', async () => {
    settingStore.set('autoScan.enabled', 'false');
    settingStore.set('autoScan.bootScanOnStart', 'true');
    const log = makeLog();

    await startWatcherService(log as never);
    await Promise.resolve();

    expect(startWatcherSpy).not.toHaveBeenCalled();
    expect(runBootReconcileSpy).not.toHaveBeenCalled();
  });

  it('subsequent restart with bootScanOnStart=false → still does NOT runBootReconcile', async () => {
    settingStore.set('autoScan.enabled', 'true');
    settingStore.set('autoScan.bootScanOnStart', 'false');
    const log = makeLog();

    await startWatcherService(log as never);
    await Promise.resolve();
    __forTests_resetWatcherService();
    runBootReconcileSpy.mockClear();

    await startWatcherService(log as never);
    await Promise.resolve();

    expect(runBootReconcileSpy).not.toHaveBeenCalled();
  });

  it('periodic-reconcile still scheduled even when bootScanOnStart=false', async () => {
    settingStore.set('autoScan.enabled', 'true');
    settingStore.set('autoScan.bootScanOnStart', 'false');
    const log = makeLog();

    await startWatcherService(log as never);
    await Promise.resolve();

    expect(startPeriodicReconcileSpy).toHaveBeenCalledTimes(1);
  });
});
