// 42-03: focused tests for the chokidar getWatched()-measured poll-rate diag.
// Drives the real watcher seam (__setWatcherFactoryForTests) with a fake FSWatcher
// whose getWatched() returns a known Record<dir, string[]> and whose 'ready' event
// is fired manually after startWatcher. Asserts countWatchedPaths dedup + the
// actualStatsPerSec / actualPathMultiplier math, plus the audit-S1 invariant that
// the unmeasured (no-getWatched / threw) path emits exactly ONE warn — never silent.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ShareRow } from '@/src/lib/db/schema';

vi.mock('@/src/lib/watch/mount-detect', () => ({
  detectMountMode: vi.fn(() => 'polling-forced' as const),
  readMaxUserWatches: vi.fn(() => 524288),
  countCurrentInotifyWatches: vi.fn(() => 42),
}));

import {
  startWatcher,
  getWatcherSnapshot,
  resetWatcherState,
  __setWatcherFactoryForTests,
  __resetWatcherFactoryForTests,
  type WatcherFactory,
} from '@/src/lib/watch/watcher';
import { detectMountMode } from '@/src/lib/watch/mount-detect';
import { __forTests_resetPollIntervalEnv } from '@/src/lib/watch/poll-interval';

// ────────────────────────────────────────────────────────────────────────────
// Fake chokidar factory with configurable getWatched()
// ────────────────────────────────────────────────────────────────────────────

type GetWatchedSpec =
  | { kind: 'record'; value: Record<string, string[]> }
  | { kind: 'throws' }
  | { kind: 'absent' };

class FakeFSWatcher extends EventEmitter {
  closed = false;
  constructor(private spec: GetWatchedSpec) {
    super();
    if (spec.kind !== 'absent') {
      (this as unknown as { getWatched: () => Record<string, string[]> }).getWatched = () => {
        if (spec.kind === 'throws') throw new Error('getWatched boom');
        return spec.value;
      };
    }
  }
  add(): this {
    return this;
  }
  unwatch(): this {
    return this;
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  fireReady(): void {
    this.emit('ready');
  }
}

let lastInstance: FakeFSWatcher | null = null;

function makeFactory(spec: GetWatchedSpec): WatcherFactory {
  return {
    watch: () => {
      const inst = new FakeFSWatcher(spec);
      lastInstance = inst;
      return inst as unknown as ReturnType<WatcherFactory['watch']>;
    },
  };
}

function makeShare(id: number, name: string, p: string): ShareRow {
  return {
    id,
    name,
    path: p,
    min_size_mb: 100,
    extensions_csv: 'mkv,mp4',
    max_depth: null,
    created_at: 0,
    updated_at: 0,
  } as ShareRow;
}

function makeDeps(watchedFileCount: number) {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  };
  return {
    deps: {
      shareRepo: () => ({ listAll: () => [makeShare(2, 'media', '/mnt/user/Media')] }),
      settingRepo: () => ({ get: () => undefined }),
      fileRepo: () => ({ countByQuery: () => watchedFileCount }),
      jobRepo: () => ({}),
      ingestSingleFile: vi.fn(),
      runReconcile: vi.fn(),
      emitQueueUpdated: vi.fn(),
      log,
    },
    log,
  };
}

beforeEach(() => {
  resetWatcherState();
  lastInstance = null;
  vi.mocked(detectMountMode).mockReset();
  vi.mocked(detectMountMode).mockReturnValue('polling-forced');
  delete process.env.WATCH_POLL_INTERVAL_MS;
  __forTests_resetPollIntervalEnv();
});

afterEach(() => {
  __resetWatcherFactoryForTests();
  resetWatcherState();
  delete process.env.WATCH_POLL_INTERVAL_MS;
  __forTests_resetPollIntervalEnv();
});

describe('42-03 measured poll-rate diag', () => {
  // Case 1: subdirs appear both as their own key AND as a parent's child basename;
  // countWatchedPaths must dedup → #dirs + #files, no double-count.
  it('counts #dirs + #files with no subdir double-count (3 dirs, 7 files → 10)', async () => {
    const watched: Record<string, string[]> = {
      '/a': ['b', 'c', 'f1', 'f2'], // b, c are subdirs (own keys); f1,f2 files
      '/a/b': ['f3', 'f4'],
      '/a/c': ['f5', 'f6', 'f7'],
    };
    __setWatcherFactoryForTests(makeFactory({ kind: 'record', value: watched }));
    const { deps } = makeDeps(1000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    lastInstance!.fireReady();

    const entry = getWatcherSnapshot().pollingShares['media'];
    expect(entry.actualWatchedPaths).toBe(10); // 3 dirs + 7 files
  });

  // Case 2: actualStatsPerSec + actualPathMultiplier math against the resolved
  // interval (env=60000) and a known watchedFileCount.
  it('computes actualStatsPerSec + actualPathMultiplier from the measured count', async () => {
    process.env.WATCH_POLL_INTERVAL_MS = '60000';
    __forTests_resetPollIntervalEnv();
    // 5 dirs × 200 files = 1000 files + 5 dir keys = 1005 watched paths.
    const watched: Record<string, string[]> = {};
    const dirs = ['/m/d0', '/m/d1', '/m/d2', '/m/d3', '/m/d4'];
    for (const d of dirs) {
      watched[d] = Array.from({ length: 200 }, (_, i) => `f${i}.mkv`);
    }
    __setWatcherFactoryForTests(makeFactory({ kind: 'record', value: watched }));
    const { deps } = makeDeps(1000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    lastInstance!.fireReady();

    const entry = getWatcherSnapshot().pollingShares['media'];
    expect(entry.effectiveIntervalMs).toBe(60000);
    expect(entry.actualWatchedPaths).toBe(1005); // 5 dirs + 1000 files
    expect(entry.actualStatsPerSec).toBe(Math.round((1005 / 60000) * 1000)); // = 17
    expect(entry.actualPathMultiplier).toBe(Math.round((1005 / 1000) * 10) / 10); // = 1.0
  });

  // AC-2 + audit-S1: no getWatched → actual* stay null AND a single
  // watch_poll_actual_paths_unmeasured warn (the null path is NOT silent).
  it('no getWatched → actual* null + one unmeasured warn (not silent)', async () => {
    __setWatcherFactoryForTests(makeFactory({ kind: 'absent' }));
    const { deps, log } = makeDeps(1000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    lastInstance!.fireReady();

    const entry = getWatcherSnapshot().pollingShares['media'];
    expect(entry.actualWatchedPaths).toBeNull();
    expect(entry.actualPathMultiplier).toBeNull();
    expect(entry.actualStatsPerSec).toBeNull();
    const warns = log.warn.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as { action?: string }).action === 'watch_poll_actual_paths_unmeasured',
    );
    expect(warns).toHaveLength(1);
    expect((warns[0][0] as { reason: string }).reason).toBe('no-getWatched');
  });

  // audit-S1: getWatched throws → actual* null + one 'threw' warn; watcher does NOT throw.
  it('getWatched throws → actual* null + one threw warn, watcher survives', async () => {
    __setWatcherFactoryForTests(makeFactory({ kind: 'throws' }));
    const { deps, log } = makeDeps(1000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    expect(() => lastInstance!.fireReady()).not.toThrow();

    const entry = getWatcherSnapshot().pollingShares['media'];
    expect(entry.actualWatchedPaths).toBeNull();
    const warns = log.warn.mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as { action?: string }).action === 'watch_poll_actual_paths_unmeasured',
    );
    expect(warns).toHaveLength(1);
    expect((warns[0][0] as { reason: string }).reason).toBe('threw');
  });
});
