// Phase 16-02 audit-added M2 — restart-coalesce + periodic-reconcile mutex.
//
// Two invariants under test:
//   1. restartWatcherService 500ms trailing-debounce — multiple rapid calls
//      collapse to ONE actual restart (carry-forward 16-01 S3).
//   2. startPeriodicReconcile tick mutex — concurrent ticks observe
//      in-flight=true and skip (no overlapping reconcile-bodies).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted: must live in hoisted scope because vi.mock factories reference
// these symbols and run BEFORE module-top consts initialize.
const { settingStore, startWatcherSpy, stopWatcherSpy } = vi.hoisted(() => ({
  settingStore: new Map<string, string>(),
  startWatcherSpy: vi.fn(async () => {}),
  stopWatcherSpy: vi.fn(async () => {}),
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
  getDb: () => ({ prepare: () => ({ all: () => [] }) }),
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

vi.mock('@/src/lib/encode/events', () => ({ engineEvents: { emit: vi.fn() } }));

vi.mock('@/src/lib/watch/mount-detect', () => ({
  readMaxUserWatches: () => 524288,
  countCurrentInotifyWatches: () => 0,
  detectMountMode: () => 'inotify' as const,
}));

vi.mock('@/src/lib/watch/watcher', () => ({
  startWatcher: startWatcherSpy,
  stopWatcher: stopWatcherSpy,
  getWatcherSnapshot: () => ({ status: 'running' }) as never,
  resetWatcherState: vi.fn(),
  setReconcileResult: vi.fn(),
  setWatcherStatusEnum: vi.fn(),
}));

vi.mock('@/src/lib/watch/ingest', () => ({ ingestSingleFile: vi.fn() }));

// Mock reconcile to avoid real setInterval (6h handle) tripping the
// fake-timer loop-detector. The debounce-tests don't exercise the periodic
// path; the periodic-mutex tests below import startPeriodicReconcile from
// the real module via a second describe-block? No — both use this same
// module mock; the mutex tests use vi.importActual to grab the real impl.
vi.mock('@/src/lib/watch/reconcile', async () => {
  const actual = await vi.importActual<typeof import('@/src/lib/watch/reconcile')>(
    '@/src/lib/watch/reconcile',
  );
  return {
    ...actual,
    runBootReconcile: vi.fn(async () => ({ reconcileCount: 0, orphanReEnqueueCount: 0 })),
    // keep real startPeriodicReconcile (mutex test exercises it) but suppress
    // its setInterval handle in the service-restart path by reading 6h default
    // — fake timers never advance that far in restart tests.
  };
});

import { restartWatcherService, __forTests_resetWatcherService } from '@/src/lib/watch/service';
import { startPeriodicReconcile, stopPeriodicReconcile } from '@/src/lib/watch/reconcile';
import type { ReconcileDeps } from '@/src/lib/watch/reconcile';

function makeLog() {
  const fns = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return Object.assign(fns, { child: () => fns });
}

beforeEach(() => {
  vi.useFakeTimers();
  settingStore.clear();
  settingStore.set('autoScan.enabled', 'true');
  settingStore.set('autoScan.bootScanOnStart', 'false'); // skip boot-scan to keep tests fast
  startWatcherSpy.mockClear();
  stopWatcherSpy.mockClear();
  __forTests_resetWatcherService();
});

afterEach(() => {
  vi.useRealTimers();
  __forTests_resetWatcherService();
});

describe('restartWatcherService — 500ms trailing-debounce (16-02 audit M2 / AC-11)', () => {
  it('5 sequential restartWatcherService calls within 200ms → 1 actual restart after 500ms', async () => {
    const log = makeLog();

    const promises: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      promises.push(restartWatcherService(log as never));
      await vi.advanceTimersByTimeAsync(40); // 5 × 40ms = 200ms < 500ms debounce
    }

    // before debounce expires — no restart yet (startWatcher proxies restart-body)
    expect(startWatcherSpy).not.toHaveBeenCalled();

    // advance past trailing debounce + flush microtasks for restart-body
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all(promises);

    // EXACTLY one restart-body executed despite 5 rapid calls
    expect(startWatcherSpy).toHaveBeenCalledTimes(1);
  });

  it('second restart after first completes → spawns new debounce cycle', async () => {
    const log = makeLog();

    // first restart
    const p1 = restartWatcherService(log as never);
    await vi.advanceTimersByTimeAsync(500);
    await p1;
    expect(startWatcherSpy).toHaveBeenCalledTimes(1);

    startWatcherSpy.mockClear();

    // second restart fires a NEW debounce cycle (in-flight cleared)
    const p2 = restartWatcherService(log as never);
    await vi.advanceTimersByTimeAsync(500);
    await p2;
    expect(startWatcherSpy).toHaveBeenCalledTimes(1);
  });
});

describe('startPeriodicReconcile — tick mutex (16-02 audit M2 / AC-11)', () => {
  function makeDeps(reconcileIntervalH: string, scanDelay: number): ReconcileDeps {
    const log = makeLog();
    return {
      shareRepo: () =>
        ({
          listAll: () => [
            {
              id: 1,
              name: 'a',
              path: '/mnt/a',
              min_size_mb: 100,
              extensions_csv: 'mkv',
              max_depth: null,
              created_at: 0,
              updated_at: 0,
            },
          ],
        }) as never,
      fileRepo: () => ({ getById: () => null }) as never,
      jobRepo: () => ({ enqueue: () => null }) as never,
      settingRepo: () =>
        ({
          get: (k: string) =>
            k === 'autoScan.reconcileIntervalH' ? reconcileIntervalH : undefined,
        }) as never,
      runScan: vi.fn(async () => {
        await new Promise<void>((r) => setTimeout(r, scanDelay));
        return {
          rootPath: '/mnt/a',
          filesScanned: 0,
          filesAdded: 0,
          filesUpdated: 0,
          filesUnchanged: 0,
          filesFailed: 0,
          filesVanished: 0,
          durationMs: 0,
          startedAt: 0,
          finishedAt: 0,
        };
      }),
      findOrphanFileIds: () => [],
      encoderResolver: () => 'libx265',
      emitQueueUpdated: vi.fn(),
      log: log as never,
    };
  }

  it('reconcileIntervalH=0.05 + slow scan (3min) → second tick observes in-flight and skips', async () => {
    // intervalMs = 0.05 * 3600 * 1000 = 180_000 (3 min)
    // scanDelay = 200_000 (>3 min) so first tick still running when second fires
    const deps = makeDeps('0.05', 200_000);
    const onResult = vi.fn();
    const handle = startPeriodicReconcile(deps, onResult);

    // Advance to fire first tick (180s)
    await vi.advanceTimersByTimeAsync(180_000);
    // Advance again to fire second tick — first still in-flight
    await vi.advanceTimersByTimeAsync(180_000);

    // Only ONE runScan invocation should be in-flight; second tick skipped
    const scanMock = deps.runScan as ReturnType<typeof vi.fn>;
    expect(scanMock).toHaveBeenCalledTimes(1);

    // Settle the first scan
    await vi.advanceTimersByTimeAsync(200_000);

    stopPeriodicReconcile(handle);
  });

  it('after first tick settles, next tick runs (mutex resets)', async () => {
    const deps = makeDeps('0.05', 1_000); // scan completes within 1s
    const onResult = vi.fn();
    const handle = startPeriodicReconcile(deps, onResult);

    await vi.advanceTimersByTimeAsync(180_000); // first tick
    await vi.advanceTimersByTimeAsync(2_000); // scan settles
    await vi.advanceTimersByTimeAsync(180_000); // second tick
    await vi.advanceTimersByTimeAsync(2_000); // settles

    const scanMock = deps.runScan as ReturnType<typeof vi.fn>;
    expect(scanMock).toHaveBeenCalledTimes(2);

    stopPeriodicReconcile(handle);
  });
});
