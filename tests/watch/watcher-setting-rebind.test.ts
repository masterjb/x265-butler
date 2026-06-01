// Phase 16-02 T2 — watcher rebind to operator settings.
//
// Asserts that the operator-tunable autoScan.* keys flow through to the
// chokidar-watcher / batch-flusher / periodic-reconcile consumers when
// startWatcher / startPeriodicReconcile run (or re-run after restart).
//
// Coverage: AC-3 (stability rebind), AC-4 (batchWindow live-read),
// AC-5 (reconcileIntervalH rebind), default-fallback when unset.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ShareRow } from '@/src/lib/db/schema';

vi.mock('@/src/lib/watch/mount-detect', () => ({
  detectMountMode: vi.fn(() => 'inotify' as const),
  readMaxUserWatches: vi.fn(() => 524288),
  countCurrentInotifyWatches: vi.fn(() => 0),
}));

import {
  startWatcher,
  stopWatcher,
  resetWatcherState,
  __setWatcherFactoryForTests,
  __resetWatcherFactoryForTests,
  type WatcherFactory,
} from '@/src/lib/watch/watcher';
import {
  startPeriodicReconcile,
  stopPeriodicReconcile,
  type ReconcileDeps,
} from '@/src/lib/watch/reconcile';

class FakeFSWatcher extends EventEmitter {
  watched = new Set<string>();
  opts: Record<string, unknown> = {};
  closed = false;
  constructor(paths: string | readonly string[], opts: Record<string, unknown>) {
    super();
    this.opts = opts;
    const arr = Array.isArray(paths) ? paths : [paths as string];
    for (const p of arr) this.watched.add(p);
  }
  add() {
    return this;
  }
  unwatch() {
    return this;
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

let watchCalls: Array<{ opts: Record<string, unknown>; instance: FakeFSWatcher }> = [];
function makeFactory(): WatcherFactory {
  return {
    watch: (paths, opts) => {
      const inst = new FakeFSWatcher(paths, opts);
      watchCalls.push({ opts, instance: inst });
      return inst as never;
    },
  };
}

function makeShare(id: number, name: string, p: string): ShareRow {
  return {
    id,
    name,
    path: p,
    min_size_mb: 0,
    extensions_csv: 'mkv',
    max_depth: null,
    created_at: 0,
    updated_at: 0,
  } as ShareRow;
}

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
  watchCalls = [];
  __setWatcherFactoryForTests(makeFactory());
});

afterEach(async () => {
  await stopWatcher();
  resetWatcherState();
  __resetWatcherFactoryForTests();
});

describe('watcher rebind to operator settings (16-02 T2)', () => {
  it('autoScan.stabilityThreshold=15000 → awaitWriteFinish.stabilityThreshold=15000', async () => {
    const log = makeLog();
    const deps = {
      shareRepo: () => ({ listAll: () => [makeShare(1, 'a', '/mnt/a')] }),
      settingRepo: () => ({
        get: (k: string) => (k === 'autoScan.stabilityThreshold' ? '15000' : undefined),
      }),
      fileRepo: () => ({}),
      jobRepo: () => ({}),
      ingestSingleFile: vi.fn(),
      runReconcile: vi.fn(),
      emitQueueUpdated: vi.fn(),
      log: log as never,
    };
    await startWatcher(deps as never);
    const awf = watchCalls[0].opts.awaitWriteFinish as { stabilityThreshold: number };
    expect(awf.stabilityThreshold).toBe(15_000);
  });

  it('autoScan.batchWindow=8000 read live on flushBatch scheduling', async () => {
    vi.useFakeTimers();
    const log = makeLog();
    const deps = {
      shareRepo: () => ({ listAll: () => [makeShare(1, 'a', '/mnt/a')] }),
      settingRepo: () => ({
        get: (k: string) => (k === 'autoScan.batchWindow' ? '8000' : undefined),
      }),
      fileRepo: () => ({}),
      jobRepo: () => ({}),
      ingestSingleFile: vi.fn(async () => ({
        enqueued: true,
        skipped: false,
        fileId: 1,
        jobId: 100,
      })),
      runReconcile: vi.fn(),
      emitQueueUpdated: vi.fn(),
      log: log as never,
    };
    await startWatcher(deps as never);
    const inst = watchCalls[0].instance;
    inst.emit('add', '/mnt/a/x.mkv');

    // After 5_000 ms (old baseline) no ingest yet because window is 8000.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.ingestSingleFile).not.toHaveBeenCalled();

    // After +3_000 ms (total 8s) ingest fires.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(deps.ingestSingleFile).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('autoScan.reconcileIntervalH=12 → setInterval scheduled at 43_200_000 ms', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const log = makeLog();
    const deps: ReconcileDeps = {
      shareRepo: () => ({ listAll: () => [] }) as never,
      fileRepo: () => ({}) as never,
      jobRepo: () => ({}) as never,
      settingRepo: () =>
        ({ get: (k: string) => (k === 'autoScan.reconcileIntervalH' ? '12' : undefined) }) as never,
      runScan: vi.fn(),
      findOrphanFileIds: () => [],
      encoderResolver: () => 'libx265',
      emitQueueUpdated: vi.fn(),
      log: log as never,
    };
    const handle = startPeriodicReconcile(deps, vi.fn());
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 12 * 3600 * 1000);
    stopPeriodicReconcile(handle);
    setIntervalSpy.mockRestore();
  });

  it('autoScan.reconcileIntervalH absent → defaults to 6h (21_600_000 ms)', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const log = makeLog();
    const deps: ReconcileDeps = {
      shareRepo: () => ({ listAll: () => [] }) as never,
      fileRepo: () => ({}) as never,
      jobRepo: () => ({}) as never,
      settingRepo: () => ({ get: () => undefined }) as never,
      runScan: vi.fn(),
      findOrphanFileIds: () => [],
      encoderResolver: () => 'libx265',
      emitQueueUpdated: vi.fn(),
      log: log as never,
    };
    const handle = startPeriodicReconcile(deps, vi.fn());
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 6 * 3600 * 1000);
    stopPeriodicReconcile(handle);
    setIntervalSpy.mockRestore();
  });
});
