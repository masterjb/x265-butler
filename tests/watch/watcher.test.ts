import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ShareRow } from '@/src/lib/db/schema';

// Mock mount-detect so tests can override per-share mode.
vi.mock('@/src/lib/watch/mount-detect', () => ({
  detectMountMode: vi.fn(() => 'inotify' as const),
  readMaxUserWatches: vi.fn(() => 524288),
  countCurrentInotifyWatches: vi.fn(() => 42),
}));

import {
  startWatcher,
  stopWatcher,
  addShareToWatcher,
  removeShareFromWatcher,
  getWatcherSnapshot,
  resetWatcherState,
  __setWatcherFactoryForTests,
  __resetWatcherFactoryForTests,
  __forTests_getInternalState,
} from '@/src/lib/watch/watcher';
import { detectMountMode } from '@/src/lib/watch/mount-detect';
import { __forTests_resetPollIntervalEnv } from '@/src/lib/watch/poll-interval';
// 48-02: memoized env resolvers — reset so the kill-switch cases are honest.
import { __resetSystemPruneMemoForTests } from '@/src/lib/fs/system-paths';
import { __resetFollowSymlinksMemoForTests } from '@/src/lib/watch/watcher';
import {
  resetWatchErrorAggregator,
  WATCH_ERROR_WINDOW_MS,
  __forTests_getWatchErrorAggregatorState,
} from '@/src/lib/watch/watch-error-aggregator';

// ────────────────────────────────────────────────────────────────────────────
// Fake chokidar factory
// ────────────────────────────────────────────────────────────────────────────

class FakeFSWatcher extends EventEmitter {
  watched: Set<string> = new Set();
  closed = false;
  addCalls: string[][] = [];
  unwatchCalls: string[][] = [];
  opts: Record<string, unknown> = {};
  constructor(paths: string | readonly string[], opts: Record<string, unknown>) {
    super();
    this.opts = opts;
    const arr = Array.isArray(paths) ? paths : [paths as string];
    for (const p of arr) this.watched.add(p);
  }
  add(p: string | string[]): this {
    const arr = Array.isArray(p) ? p : [p];
    this.addCalls.push([...arr]);
    for (const x of arr) this.watched.add(x);
    return this;
  }
  unwatch(p: string | string[]): this {
    const arr = Array.isArray(p) ? p : [p];
    this.unwatchCalls.push([...arr]);
    for (const x of arr) this.watched.delete(x);
    return this;
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

const watchCalls: Array<{
  paths: string | readonly string[];
  opts: Record<string, unknown>;
  instance: FakeFSWatcher;
}> = [];

import type { WatcherFactory } from '@/src/lib/watch/watcher';

function makeFactory(): WatcherFactory {
  return {
    watch: (paths: string | readonly string[], opts: Record<string, unknown>) => {
      const inst = new FakeFSWatcher(paths, opts);
      watchCalls.push({ paths, opts, instance: inst });
      return inst as unknown as Parameters<WatcherFactory['watch']> extends [unknown, unknown]
        ? ReturnType<WatcherFactory['watch']>
        : never;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────────────────────

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

interface DepsStub {
  shareRepo: () => { listAll: () => ShareRow[] };
  settingRepo: () => { get: (k: string) => string | undefined };
  fileRepo: () => unknown;
  jobRepo: () => unknown;
  ingestSingleFile: ReturnType<typeof vi.fn>;
  runReconcile: ReturnType<typeof vi.fn>;
  emitQueueUpdated: ReturnType<typeof vi.fn>;
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
    child: () => unknown;
  };
}

function makeDeps(shares: ShareRow[], settings: Record<string, string> = {}): DepsStub {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  };
  return {
    shareRepo: () => ({ listAll: () => shares }),
    settingRepo: () => ({ get: (k: string) => settings[k] }),
    fileRepo: () => ({}),
    jobRepo: () => ({}),
    ingestSingleFile: vi.fn(async () => ({
      enqueued: true,
      skipped: false,
      fileId: 1,
      jobId: 100,
    })),
    runReconcile: vi.fn(async () => ({ filesAdded: 0, filesUpdated: 0 })),
    emitQueueUpdated: vi.fn(),
    log,
  };
}

beforeEach(() => {
  resetWatcherState();
  watchCalls.length = 0;
  __setWatcherFactoryForTests(makeFactory());
  vi.mocked(detectMountMode).mockReset();
  vi.mocked(detectMountMode).mockReturnValue('inotify');
  delete process.env.CHOKIDAR_USEPOLLING;
});

afterEach(() => {
  __resetWatcherFactoryForTests();
  resetWatcherState();
  // 28-06 P9: no WATCH_INGEST_CONCURRENCY bleed across tests.
  delete process.env.WATCH_INGEST_CONCURRENCY;
});

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('startWatcher / mount-mode dispatch', () => {
  it('1 inotify share → 1 mainInstance with that path', async () => {
    const shares = [makeShare(1, 'media', '/mnt/extra/media')];
    vi.mocked(detectMountMode).mockReturnValue('inotify');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(makeDeps(shares) as any);
    expect(watchCalls).toHaveLength(1);
    expect(watchCalls[0].paths).toEqual(['/mnt/extra/media']);
    expect(watchCalls[0].opts.usePolling).toBe(false);
    expect(getWatcherSnapshot().status).toBe('running');
    expect(getWatcherSnapshot().pollingModeByShare).toEqual({ media: 'inotify' });
  });

  // 42-01 AC-5: inotify opts MUST carry NO `interval` key (byte-identical to
  // pre-42 — the scaling lever is forced-polling-only).
  it('inotify share opts contain NO interval key (AC-5 regress)', async () => {
    const shares = [makeShare(1, 'media', '/mnt/extra/media')];
    vi.mocked(detectMountMode).mockReturnValue('inotify');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(makeDeps(shares) as any);
    expect('interval' in watchCalls[0].opts).toBe(false);
    // 42-02 AC-3: inotify carries NEITHER poll knob.
    expect('binaryInterval' in watchCalls[0].opts).toBe(false);
    expect(getWatcherSnapshot().pollingShares).toEqual({});
  });

  it('1 shfs share → 1 pollingInstance with usePolling=true', async () => {
    const shares = [makeShare(2, 'user-share', '/mnt/user/Media')];
    vi.mocked(detectMountMode).mockReturnValue('polling-forced');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(makeDeps(shares) as any);
    expect(watchCalls).toHaveLength(1);
    expect(watchCalls[0].opts.usePolling).toBe(true);
    // empty fileRepo mock → 0 files → resolver floors to base 2000 (AC-2 scaling
    // engages only with a real watched-file count; see poll-interval.test.ts).
    expect(watchCalls[0].opts.interval).toBe(2000);
    // 42-02 AC-1: binaryInterval pinned to the SAME resolved interval so binary-
    // extension paths (.mkv/.jpg/.png) don't keep polling at chokidar's 300 ms default.
    expect(watchCalls[0].opts.binaryInterval).toBe(2000);
    expect(watchCalls[0].opts.binaryInterval).toBe(watchCalls[0].opts.interval);
    expect(getWatcherSnapshot().pollingModeByShare).toEqual({ 'user-share': 'polling-forced' });
    // 42-01 AC-4: forced-polling share carries stat-rate diagnostics in snapshot.
    expect(getWatcherSnapshot().pollingShares['user-share']).toMatchObject({
      effectiveIntervalMs: 2000,
      pathMultiplier: 10,
    });
  });

  // 42-02 audit-S1 / AC-2: a NON-default resolved interval (env-override) must reach
  // BOTH chokidar knobs. The 42-01 failure was a non-2000 resolution arriving with the
  // two knobs split — env=60000 here locks resolvePollIntervalMs → buildChokidarOpts so
  // binaryInterval can never again diverge from interval at a scaled/env value.
  it('env-resolved non-default interval (60000) is carried to BOTH knobs', async () => {
    process.env.WATCH_POLL_INTERVAL_MS = '60000';
    __forTests_resetPollIntervalEnv();
    try {
      const shares = [makeShare(2, 'user-share', '/mnt/user/Media')];
      vi.mocked(detectMountMode).mockReturnValue('polling-forced');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await startWatcher(makeDeps(shares) as any);
      expect(watchCalls[0].opts.usePolling).toBe(true);
      expect(watchCalls[0].opts.interval).toBe(60000);
      expect(watchCalls[0].opts.binaryInterval).toBe(60000);
      expect(watchCalls[0].opts.binaryInterval).toBe(watchCalls[0].opts.interval);
    } finally {
      delete process.env.WATCH_POLL_INTERVAL_MS;
      __forTests_resetPollIntervalEnv();
    }
  });

  it('mixed: inotify + shfs → mainInstance(1) + pollingInstances(1)', async () => {
    const shares = [
      makeShare(1, 'fast', '/mnt/extra/fast'),
      makeShare(2, 'cache', '/mnt/user/cache'),
    ];
    vi.mocked(detectMountMode).mockImplementation((p: string) =>
      p.startsWith('/mnt/user') ? 'polling-forced' : 'inotify',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(makeDeps(shares) as any);
    expect(watchCalls).toHaveLength(2);
    expect(watchCalls.find((c) => c.opts.usePolling === false)).toBeDefined();
    expect(watchCalls.find((c) => c.opts.usePolling === true)).toBeDefined();
  });

  it('CHOKIDAR_USEPOLLING=1 emits warn-log at startup (audit S7)', async () => {
    process.env.CHOKIDAR_USEPOLLING = '1';
    const deps = makeDeps([makeShare(1, 'a', '/mnt/a')]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auto_scan_env_polling_override' }),
      expect.any(String),
    );
  });
});

describe('batch coalescing + flush', () => {
  it('5 add events on same path within window → 1 ingest call', async () => {
    vi.useFakeTimers();
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares, { 'autoScan.batchWindow': '5000' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const inst = watchCalls[0].instance;
    for (let i = 0; i < 5; i++) inst.emit('add', '/mnt/media/foo.mkv');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.ingestSingleFile).toHaveBeenCalledTimes(1);
    expect(deps.ingestSingleFile).toHaveBeenCalledWith('/mnt/media/foo.mkv', 1);
    vi.useRealTimers();
  });

  it('flush fires after batch window, then drains buffer', async () => {
    vi.useFakeTimers();
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const inst = watchCalls[0].instance;
    inst.emit('add', '/mnt/media/a.mkv');
    inst.emit('add', '/mnt/media/b.mkv');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.ingestSingleFile).toHaveBeenCalledTimes(2);
    expect(__forTests_getInternalState().batchBuffers.size).toBe(0);
    vi.useRealTimers();
  });

  it('awaitWriteFinish stabilityThreshold respects settings override', async () => {
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares, { 'autoScan.stabilityThreshold': '15000' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const opts = watchCalls[0].opts;
    expect((opts.awaitWriteFinish as { stabilityThreshold: number }).stabilityThreshold).toBe(
      15000,
    );
  });
});

describe('rate cap + dropped counter (audit M4)', () => {
  it('70 events in 60s → 60 enqueued + 10 dropped + droppedEventsLast24h=10 (order-preserving)', async () => {
    // 28-06 P9 (audit MH-1): now that admission is hoisted out of the await loop
    // into a synchronous pre-pass, order-preservation is the explicit invariant —
    // counts-only is insufficient. The FIRST 60 by buffer-insertion order
    // (file-0..file-59) must be ingested; the LAST 10 (file-60..file-69) dropped.
    vi.useFakeTimers();
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const inst = watchCalls[0].instance;
    for (let i = 0; i < 70; i++) inst.emit('add', `/mnt/media/file-${i}.mkv`);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.ingestSingleFile).toHaveBeenCalledTimes(60);
    expect(getWatcherSnapshot().droppedEventsLast24h).toBe(10);

    // the 60 ingested are the FIRST 60 by insertion order
    const ingestedPaths = deps.ingestSingleFile.mock.calls.map((c: unknown[]) => c[0]);
    expect(ingestedPaths).toEqual(Array.from({ length: 60 }, (_, i) => `/mnt/media/file-${i}.mkv`));

    // the 10 drop-warns carry the LAST 10
    const dropWarns = deps.log.warn.mock.calls.filter((c: unknown[]) => {
      const arg = c[0] as { action?: string };
      return arg.action === 'auto_scan_rate_cap_drop';
    });
    expect(dropWarns).toHaveLength(10);
    expect(dropWarns.map((c: unknown[]) => (c[0] as { absPath: string }).absPath)).toEqual(
      Array.from({ length: 10 }, (_, i) => `/mnt/media/file-${60 + i}.mkv`),
    );
    vi.useRealTimers();
  });
});

describe('ENOSPC handling + audit S1 backoff', () => {
  it('error event with code=ENOSPC → status=error + inotifyError set + retry scheduled', async () => {
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const inst = watchCalls[0].instance;
    const err = Object.assign(new Error('ENOSPC: System limit'), { code: 'ENOSPC' });
    inst.emit('error', err);
    const snap = getWatcherSnapshot();
    expect(snap.status).toBe('error');
    expect(snap.inotifyError).toEqual({ code: 'ENOSPC', message: 'ENOSPC: System limit' });
    expect(deps.log.error).toHaveBeenCalled();
  });

  it('audit S1: ENOSPC retry advances 10s → 60s on consecutive failures', async () => {
    vi.useFakeTimers();
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const inst = watchCalls[0].instance;
    const err = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    inst.emit('error', err);
    // first retry after 10s — startWatcher reruns; new instance now fails too
    await vi.advanceTimersByTimeAsync(10_000);
    // flush microtask queue
    await Promise.resolve();
    await Promise.resolve();
    // a new watch instance should have been created on retry attempt
    expect(watchCalls.length).toBeGreaterThanOrEqual(2);
    // emit ENOSPC again to drive backoff to next slot
    const inst2 = watchCalls[watchCalls.length - 1].instance;
    inst2.emit('error', err);
    // next retry slot = 60s
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(watchCalls.length).toBeGreaterThanOrEqual(3);
    vi.useRealTimers();
  });
});

describe('skip-pipeline veto', () => {
  it('ingestSingleFile returning skipped → no lastEventAt bump for this file', async () => {
    vi.useFakeTimers();
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares);
    deps.ingestSingleFile.mockResolvedValue({
      enqueued: false,
      skipped: true,
      reason: 'skipped-sidecar',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const inst = watchCalls[0].instance;
    inst.emit('add', '/mnt/media/foo.mkv');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.ingestSingleFile).toHaveBeenCalledTimes(1);
    expect(getWatcherSnapshot().lastEventAt).toBeNull();
    vi.useRealTimers();
  });
});

describe('share lifecycle', () => {
  it('addShareToWatcher invokes .add on main instance (live, no restart)', async () => {
    vi.mocked(detectMountMode).mockReturnValue('inotify');
    const shares = [makeShare(1, 'a', '/mnt/a')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const main = watchCalls[0].instance;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addShareToWatcher(makeShare(2, 'b', '/mnt/b'), deps as any);
    expect(main.addCalls).toEqual([['/mnt/b']]);
    expect(getWatcherSnapshot().pollingModeByShare).toEqual({ a: 'inotify', b: 'inotify' });
  });

  it('removeShareFromWatcher invokes .unwatch on main instance', async () => {
    vi.mocked(detectMountMode).mockReturnValue('inotify');
    const shares = [makeShare(1, 'a', '/mnt/a'), makeShare(2, 'b', '/mnt/b')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const main = watchCalls[0].instance;
    removeShareFromWatcher('/mnt/b');
    expect(main.unwatchCalls).toEqual([['/mnt/b']]);
    expect(getWatcherSnapshot().pollingModeByShare).toEqual({ a: 'inotify' });
  });

  it('audit S4: removeShareFromWatcher drains buffer + clears flushTimer before unwatch', async () => {
    vi.useFakeTimers();
    vi.mocked(detectMountMode).mockReturnValue('inotify');
    const shares = [makeShare(1, 'a', '/mnt/a'), makeShare(2, 'b', '/mnt/b')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const main = watchCalls[0].instance;
    main.emit('add', '/mnt/b/x1.mkv');
    main.emit('add', '/mnt/b/x2.mkv');
    main.emit('add', '/mnt/b/x3.mkv');
    expect(__forTests_getInternalState().batchBuffers.get(2)?.size).toBe(3);
    expect(__forTests_getInternalState().flushTimers.has(2)).toBe(true);

    removeShareFromWatcher('/mnt/b');
    expect(__forTests_getInternalState().batchBuffers.has(2)).toBe(false);
    expect(__forTests_getInternalState().flushTimers.has(2)).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.ingestSingleFile).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('prefix-match shareId resolution', () => {
  it('nested path resolves to deepest share prefix', async () => {
    vi.useFakeTimers();
    vi.mocked(detectMountMode).mockReturnValue('inotify');
    const shares = [makeShare(1, 'root', '/mnt'), makeShare(2, 'inner', '/mnt/user/share')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const inst = watchCalls[0].instance;
    inst.emit('add', '/mnt/user/share/sub/file.mkv');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.ingestSingleFile).toHaveBeenCalledWith('/mnt/user/share/sub/file.mkv', 2);
    vi.useRealTimers();
  });
});

describe('snapshot semantics', () => {
  it('getWatcherSnapshot returns deep clone (mutation does not leak)', async () => {
    const shares = [makeShare(1, 'a', '/mnt/a')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const snap = getWatcherSnapshot();
    snap.pollingModeByShare.injected = 'inotify';
    expect(getWatcherSnapshot().pollingModeByShare.injected).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 28-05 R2: epoch-guard — in-flight flush must abort on teardown (ghost-ingest)
// ────────────────────────────────────────────────────────────────────────────

async function flushMicrotasks(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe('28-05 R2: epoch-guard flushBatch teardown', () => {
  it('AC-1: stopWatcher mid-flush aborts the post-window mutation (no lastEventAt bump, info-log)', async () => {
    // 28-06 P9: window-granular — with cap=4 both files share window-1 so BOTH
    // ingest calls dispatch (times 2, was 1 pre-28-06). The guard aborts the
    // post-window status mutation after the window settles, not a mid-window
    // dispatch; lastEventAt must stay null + the abort-info-log must fire.
    vi.useFakeTimers();
    process.env.WATCH_INGEST_CONCURRENCY = '4';
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares);

    let resolveFirst!: () => void;
    const firstDeferred = new Promise<void>((r) => {
      resolveFirst = r;
    });
    deps.ingestSingleFile.mockImplementation(async () => {
      // first call blocks on the deferred so the window's allSettled suspends
      if (deps.ingestSingleFile.mock.calls.length === 1) await firstDeferred;
      return { enqueued: true, skipped: false, fileId: 1, jobId: 100 };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const inst = watchCalls[0].instance;
    inst.emit('add', '/mnt/media/a.mkv');
    inst.emit('add', '/mnt/media/b.mkv');

    // fire the flush timer — flushBatch enters, window-1 dispatches both calls,
    // allSettled awaits the deferred-blocked first call
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.ingestSingleFile).toHaveBeenCalledTimes(2);

    // teardown while the window is still settling (bumps epoch)
    await stopWatcher();
    resolveFirst();
    await flushMicrotasks();

    // guard fired AFTER settle: no lastEventAt mutation, no new window
    expect(deps.ingestSingleFile).toHaveBeenCalledTimes(2);
    expect(getWatcherSnapshot().lastEventAt).toBeNull();
    expect(deps.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auto_scan_flush_aborted_on_teardown', shareId: 1 }),
      expect.any(String),
    );
    delete process.env.WATCH_INGEST_CONCURRENCY;
    vi.useRealTimers();
  });

  it('AC-1b: resetWatcherState mid-flush aborts via state-IDENTITY even at epoch 0', async () => {
    // Anti-tautology gate for M1: epoch is NEVER bumped here (no stopWatcher),
    // so both captured myEpoch and freshState().epoch are 0. An epoch-VALUE-only
    // guard (`state.epoch !== myEpoch`) is 0 !== 0 → false → would NOT abort and
    // would mutate the freshly-reset state's lastEventAt. Only the
    // `state !== myState` identity arm makes this spec pass.
    // 28-06 P9: window-granular — both files share window-1 (cap=4) so times 2.
    vi.useFakeTimers();
    process.env.WATCH_INGEST_CONCURRENCY = '4';
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares);

    let resolveFirst!: () => void;
    const firstDeferred = new Promise<void>((r) => {
      resolveFirst = r;
    });
    deps.ingestSingleFile.mockImplementation(async () => {
      if (deps.ingestSingleFile.mock.calls.length === 1) await firstDeferred;
      return { enqueued: true, skipped: false, fileId: 1, jobId: 100 };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const inst = watchCalls[0].instance;
    inst.emit('add', '/mnt/media/a.mkv');
    inst.emit('add', '/mnt/media/b.mkv');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.ingestSingleFile).toHaveBeenCalledTimes(2);
    expect(__forTests_getInternalState().epoch).toBe(0); // never stopped → still 0

    // reset (NOT stop) while the window is still settling — swaps state object
    resetWatcherState();
    resolveFirst();
    await flushMicrotasks();

    expect(deps.ingestSingleFile).toHaveBeenCalledTimes(2);
    // the freshly-reset state's lastEventAt was NOT mutated by the ghost loop
    expect(getWatcherSnapshot().lastEventAt).toBeNull();
    delete process.env.WATCH_INGEST_CONCURRENCY;
    vi.useRealTimers();
  });

  it('AC-2: no-teardown flush drains all N + epoch is a number + snapshot shape unchanged', async () => {
    vi.useFakeTimers();
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const inst = watchCalls[0].instance;
    inst.emit('add', '/mnt/media/a.mkv');
    inst.emit('add', '/mnt/media/b.mkv');
    inst.emit('add', '/mnt/media/c.mkv');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(deps.ingestSingleFile).toHaveBeenCalledTimes(3);
    expect(__forTests_getInternalState().batchBuffers.size).toBe(0);
    expect(deps.log.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auto_scan_flush_aborted_on_teardown' }),
      expect.any(String),
    );
    expect(typeof __forTests_getInternalState().epoch).toBe('number');
    // epoch is a private internal — it must NOT leak into the public snapshot.
    expect(Object.keys(getWatcherSnapshot())).not.toContain('epoch');
    vi.useRealTimers();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 28-06 P9: capped parallel ingest window (WATCH_INGEST_CONCURRENCY)
// ────────────────────────────────────────────────────────────────────────────

describe('28-06 P9: capped parallel ingest window', () => {
  it('AC-1: cap=4 with 5 files → maxInFlight >1 AND <=4, each ingested exactly once', async () => {
    vi.useFakeTimers();
    process.env.WATCH_INGEST_CONCURRENCY = '4';
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares);

    let inFlight = 0;
    let maxInFlight = 0;
    deps.ingestSingleFile.mockImplementation(async () => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
      return { enqueued: true, skipped: false, fileId: 1, jobId: 100 };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const inst = watchCalls[0].instance;
    for (let i = 0; i < 5; i++) inst.emit('add', `/mnt/media/f-${i}.mkv`);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(deps.ingestSingleFile).toHaveBeenCalledTimes(5);
    expect(__forTests_getInternalState().batchBuffers.size).toBe(0);
    vi.useRealTimers();
  });

  it('AC-2: serial-collapse RED — WATCH_INGEST_CONCURRENCY=1 → maxInFlight exactly 1', async () => {
    // Anti-tautology gate: cap=1 is byte-identical to the pre-28-06 serial path.
    // If the window logic is wrong (e.g. unbounded Promise.all), maxInFlight > 1
    // and this RED-gate fails.
    vi.useFakeTimers();
    process.env.WATCH_INGEST_CONCURRENCY = '1';
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares);

    let inFlight = 0;
    let maxInFlight = 0;
    deps.ingestSingleFile.mockImplementation(async () => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
      return { enqueued: true, skipped: false, fileId: 1, jobId: 100 };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const inst = watchCalls[0].instance;
    for (let i = 0; i < 5; i++) inst.emit('add', `/mnt/media/f-${i}.mkv`);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(maxInFlight).toBe(1);
    expect(deps.ingestSingleFile).toHaveBeenCalledTimes(5);
    vi.useRealTimers();
  });

  it('AC-4: stopWatcher mid-window aborts before window-2 dispatches', async () => {
    vi.useFakeTimers();
    process.env.WATCH_INGEST_CONCURRENCY = '4';
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares);

    let releaseWindow!: () => void;
    const gate = new Promise<void>((r) => {
      releaseWindow = r;
    });
    deps.ingestSingleFile.mockImplementation(async () => {
      await gate;
      return { enqueued: true, skipped: false, fileId: 1, jobId: 100 };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const inst = watchCalls[0].instance;
    for (let i = 0; i < 6; i++) inst.emit('add', `/mnt/media/f-${i}.mkv`);

    // window-1 (4 files) dispatched; allSettled suspends on the gate
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.ingestSingleFile).toHaveBeenCalledTimes(4);

    // teardown bumps epoch while window-1 settles
    await stopWatcher();
    releaseWindow();
    await flushMicrotasks();

    // window-2 (files 4,5) NEVER dispatched
    expect(deps.ingestSingleFile).toHaveBeenCalledTimes(4);
    expect(getWatcherSnapshot().lastEventAt).toBeNull();
    expect(deps.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auto_scan_flush_aborted_on_teardown', shareId: 1 }),
      expect.any(String),
    );
    vi.useRealTimers();
  });

  it('AC-4b: resetWatcherState mid-window aborts via state-IDENTITY at epoch 0 (anti-tautology RED)', async () => {
    // audit MH-2: the NEW before-dispatch / after-settle guard must include the
    // `state !== myState` identity arm. epoch is NEVER bumped (resetWatcherState,
    // not stopWatcher) → an epoch-VALUE-only guard is 0!==0 → false → would leak
    // window-2 onto the freshly-reset state. Exact 28-05 M1 failure mode re-
    // applied to the window boundary.
    vi.useFakeTimers();
    process.env.WATCH_INGEST_CONCURRENCY = '4';
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares);

    let releaseWindow!: () => void;
    const gate = new Promise<void>((r) => {
      releaseWindow = r;
    });
    deps.ingestSingleFile.mockImplementation(async () => {
      await gate;
      return { enqueued: true, skipped: false, fileId: 1, jobId: 100 };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const inst = watchCalls[0].instance;
    for (let i = 0; i < 6; i++) inst.emit('add', `/mnt/media/f-${i}.mkv`);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(deps.ingestSingleFile).toHaveBeenCalledTimes(4);
    expect(__forTests_getInternalState().epoch).toBe(0); // never stopped → still 0

    // reset (swaps state object) while window-1 settles — epoch stays 0
    resetWatcherState();
    releaseWindow();
    await flushMicrotasks();

    expect(deps.ingestSingleFile).toHaveBeenCalledTimes(4); // window-2 never ran
    expect(getWatcherSnapshot().lastEventAt).toBeNull();
    vi.useRealTimers();
  });

  it('AC-7: ingest-throw failure-isolation within a window (others survive, one warn, no abort)', async () => {
    vi.useFakeTimers();
    process.env.WATCH_INGEST_CONCURRENCY = '4';
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares);

    deps.ingestSingleFile.mockImplementation(async (absPath: string) => {
      if (absPath === '/mnt/media/b.mkv') throw new Error('ingest boom');
      return { enqueued: true, skipped: false, fileId: 1, jobId: 100 };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const inst = watchCalls[0].instance;
    inst.emit('add', '/mnt/media/a.mkv');
    inst.emit('add', '/mnt/media/b.mkv');
    inst.emit('add', '/mnt/media/c.mkv');
    await vi.advanceTimersByTimeAsync(5_000);

    // all 3 dispatched in one window; the rejection did not abort the flush
    expect(deps.ingestSingleFile).toHaveBeenCalledTimes(3);
    expect(getWatcherSnapshot().lastEventAt).not.toBeNull();

    const ingestFailedWarns = deps.log.warn.mock.calls.filter((c: unknown[]) => {
      const arg = c[0] as { action?: string };
      return arg.action === 'auto_scan_ingest_failed';
    });
    expect(ingestFailedWarns).toHaveLength(1);
    expect((ingestFailedWarns[0][0] as { absPath: string }).absPath).toBe('/mnt/media/b.mkv');

    expect(deps.log.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auto_scan_flush_aborted_on_teardown' }),
      expect.any(String),
    );
    vi.useRealTimers();
  });
});

describe('graceful stop', () => {
  it('stopWatcher clears timers, closes instances, status=stopped', async () => {
    vi.useFakeTimers();
    vi.mocked(detectMountMode).mockReturnValue('inotify');
    const shares = [makeShare(1, 'a', '/mnt/a')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const main = watchCalls[0].instance;
    main.emit('add', '/mnt/a/x.mkv');
    expect(__forTests_getInternalState().flushTimers.size).toBe(1);
    await stopWatcher();
    expect(main.closed).toBe(true);
    expect(__forTests_getInternalState().flushTimers.size).toBe(0);
    expect(getWatcherSnapshot().status).toBe('stopped');
    vi.useRealTimers();
  });
});

// ── 48-02 (Bundle B on the watch path) ──────────────────────────────────────
describe('48-02 chokidar system-prefix prune (AC-7 / AC-7b)', () => {
  beforeEach(() => {
    delete process.env.SCAN_PRUNE_SYSTEM_PATHS;
    delete process.env.WATCH_FOLLOW_SYMLINKS;
    __resetSystemPruneMemoForTests();
    __resetFollowSymlinksMemoForTests();
  });

  afterEach(() => {
    delete process.env.SCAN_PRUNE_SYSTEM_PATHS;
    delete process.env.WATCH_FOLLOW_SYMLINKS;
    __resetSystemPruneMemoForTests();
    __resetFollowSymlinksMemoForTests();
  });

  function matchers(callIdx = 0): { dotfile: RegExp; system: (p: string) => boolean } {
    const ignored = watchCalls[callIdx].opts.ignored as Array<RegExp | ((p: string) => boolean)>;
    expect(Array.isArray(ignored)).toBe(true);
    // 50-03: SIDECAR_IGNORE_RE joined the list at index 1 (UNCONDITIONALLY —
    // it is not governed by any kill-switch). The 48-02 matchers are unchanged;
    // only their arity and the system matcher's index moved.
    expect(ignored).toHaveLength(3);
    return {
      dotfile: ignored[0] as RegExp,
      // AC-7: a FUNCTION matcher, never an omitted-or-present snapshot.
      system: ignored[2] as (p: string) => boolean,
    };
  }

  it('ignored is [dotfile RegExp, system FUNCTION] and still rejects dotfiles', async () => {
    const shares = [makeShare(1, 'media', '/mnt/extra/media')];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(makeDeps(shares) as any);
    const { dotfile, system } = matchers();
    expect(typeof system).toBe('function');
    expect(dotfile.test('/mnt/extra/media/.hidden')).toBe(true);
    expect(system('/sys/kernel')).toBe(true);
    expect(system('/proc/1')).toBe(true);
    expect(system('/dev/shm')).toBe(true);
    expect(system('/run/x')).toBe(true);
    expect(system('/mnt/extra/media/movie.mkv')).toBe(false);
  });

  // AC-7b — THE release gate. An ANY-root aggregate exemption would disarm the
  // prune for the co-watched '/' share and re-open the crash.
  it('a /run/media/usb1 share does NOT disarm the prune for a co-watched / share', async () => {
    const shares = [makeShare(1, 'everything', '/'), makeShare(2, 'usb1', '/run/media/usb1')];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(makeDeps(shares) as any);
    const { system } = matchers();
    expect(system('/sys/kernel')).toBe(true); // still ignored
    expect(system('/run/media/usb1/Movies/a.mkv')).toBe(false); // still watched
    expect(system('/run/media/usb1')).toBe(false);
    expect(system('/run/other/x')).toBe(true); // ignored
  });

  it("a '/'-rooted share is never itself an exempt root", async () => {
    const shares = [makeShare(1, 'everything', '/')];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(makeDeps(shares) as any);
    const { system } = matchers();
    expect(system('/proc/1')).toBe(true);
    expect(system('/sys')).toBe(true);
  });

  // AC-7b, second clause — `ignored` is frozen at construction, but
  // addShareToWatcher() calls mainInstance.add() on the ALREADY-BUILT instance
  // and cannot rebuild it. A snapshot matcher could never see the new share.
  it('a share added AFTER startWatcher is exempted without a restart', async () => {
    const shares = [makeShare(1, 'everything', '/')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const { system } = matchers();
    expect(system('/run/media/usb2/a.mkv')).toBe(true); // not yet a share

    vi.mocked(detectMountMode).mockReturnValue('inotify');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addShareToWatcher(makeShare(2, 'usb2', '/run/media/usb2'), deps as any);
    // SAME matcher object — no new instance was built for this branch.
    expect(watchCalls).toHaveLength(1);
    expect(system('/run/media/usb2/a.mkv')).toBe(false);
    expect(system('/sys/kernel')).toBe(true); // and the prune still holds
  });

  // AC-8 on the watch side.
  // 50-03: the system matcher still collapses away, but the sidecar matcher does
  // NOT — SCAN_PRUNE_SYSTEM_PATHS governs the system prune only (one lever per
  // behaviour), and the sidecar ignore has no lever at all by design (E2b).
  it('kill-switch =0 drops the system matcher (dotfile + sidecar remain)', async () => {
    process.env.SCAN_PRUNE_SYSTEM_PATHS = '0';
    __resetSystemPruneMemoForTests();
    const shares = [makeShare(1, 'everything', '/')];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(makeDeps(shares) as any);
    const ignored = watchCalls[0].opts.ignored as unknown[];
    expect(Array.isArray(ignored)).toBe(true);
    expect(ignored).toHaveLength(2);
    expect(ignored[0]).toBeInstanceOf(RegExp);
    expect(ignored.every((m) => m instanceof RegExp)).toBe(true);
  });
});

describe('48-02 followSymlinks kill-switch (AC-16)', () => {
  beforeEach(() => {
    delete process.env.WATCH_FOLLOW_SYMLINKS;
    __resetFollowSymlinksMemoForTests();
  });

  afterEach(() => {
    delete process.env.WATCH_FOLLOW_SYMLINKS;
    __resetFollowSymlinksMemoForTests();
  });

  it('unset → followSymlinks false + exactly one resolved info line per start', async () => {
    const shares = [makeShare(1, 'media', '/mnt/extra/media')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    expect(watchCalls[0].opts.followSymlinks).toBe(false);
    const lines = deps.log.info.mock.calls
      .map((c) => c[0] as { action?: string; followSymlinks?: boolean; source?: string })
      .filter((p) => p?.action === 'watch_follow_symlinks_resolved');
    expect(lines).toHaveLength(1);
    expect(lines[0].followSymlinks).toBe(false);
    expect(lines[0].source).toBe('default');
  });

  it('=1 → followSymlinks true (pre-48-02 chokidar default restored)', async () => {
    process.env.WATCH_FOLLOW_SYMLINKS = '1';
    __resetFollowSymlinksMemoForTests();
    const shares = [makeShare(1, 'media', '/mnt/extra/media')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    expect(watchCalls[0].opts.followSymlinks).toBe(true);
    const line = deps.log.info.mock.calls
      .map((c) => c[0] as { action?: string; source?: string })
      .find((p) => p?.action === 'watch_follow_symlinks_resolved');
    expect(line?.source).toBe('env');
  });

  it('is NOT governed by SCAN_PRUNE_SYSTEM_PATHS (one lever per behaviour)', async () => {
    process.env.SCAN_PRUNE_SYSTEM_PATHS = '0';
    __resetSystemPruneMemoForTests();
    const shares = [makeShare(1, 'media', '/mnt/extra/media')];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(makeDeps(shares) as any);
    expect(watchCalls[0].opts.followSymlinks).toBe(false);
    delete process.env.SCAN_PRUNE_SYSTEM_PATHS;
    __resetSystemPruneMemoForTests();
  });
});

describe('48-02 stored-forbidden share WARN (AC-17)', () => {
  beforeEach(() => {
    __resetSystemPruneMemoForTests();
    __resetFollowSymlinksMemoForTests();
  });

  it('warns ONCE per start for each stored share whose path is forbidden', async () => {
    // Guard A blocks NEW writes only — this is the only channel that tells an
    // ALREADY-broken operator why their library is half-watched.
    const shares = [
      makeShare(1, 'everything', '/'),
      makeShare(2, 'sysdump', '/sys'),
      makeShare(3, 'media', '/mnt/extra/media'),
    ];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const warns = deps.log.warn.mock.calls
      .map((c) => c[0] as { action?: string; share?: string; path?: string })
      .filter((p) => p?.action === 'share_path_forbidden_prefix_stored');
    expect(warns).toHaveLength(2);
    expect(warns.map((w) => w.share).sort()).toEqual(['everything', 'sysdump']);
    expect(warns.map((w) => w.path).sort()).toEqual(['/', '/sys']);
  });

  it('a legitimate share produces no such line', async () => {
    const shares = [makeShare(1, 'media', '/mnt/extra/media')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    expect(
      deps.log.warn.mock.calls.filter(
        (c) => (c[0] as { action?: string })?.action === 'share_path_forbidden_prefix_stored',
      ),
    ).toHaveLength(0);
  });

  it('a share rooted UNDER a prune prefix gets the exempt WARN once', async () => {
    const shares = [makeShare(1, 'usb1', '/run/media/usb1')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const warns = deps.log.warn.mock.calls
      .map((c) => c[0] as { action?: string; surface?: string; rootPath?: string })
      .filter((p) => p?.action === 'scan_root_under_system_prefix');
    expect(warns).toHaveLength(1);
    expect(warns[0].surface).toBe('watcher');
    expect(warns[0].rootPath).toBe('/run/media/usb1');
  });
});

// ── 48-02 (Bundle C): the aggregator wired into onWatcherError ───────────────
describe('48-02 watch-error aggregation wiring (AC-10 / AC-11 / AC-12)', () => {
  beforeEach(() => {
    resetWatchErrorAggregator();
  });

  afterEach(() => {
    resetWatchErrorAggregator();
    vi.useRealTimers();
  });

  function watchErrorLines(deps: ReturnType<typeof makeDeps>) {
    return deps.log.warn.mock.calls
      .map((c) => c[0] as { action?: string })
      .filter((p) => p?.action === 'auto_scan_watch_error');
  }

  function summaryLines(deps: ReturnType<typeof makeDeps>) {
    return deps.log.warn.mock.calls
      .map((c) => c[0] as { action?: string; count?: number; byCode?: Record<string, number> })
      .filter((p) => p?.action === 'auto_scan_watch_error_summary');
  }

  it('500 non-ENOSPC errors → exactly ONE immediate WARN + ONE summary', async () => {
    vi.useFakeTimers();
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const inst = watchCalls[0].instance;
    for (let i = 0; i < 500; i++) {
      inst.emit('error', Object.assign(new Error(`EACCES /sys/${i}`), { code: 'EACCES' }));
    }
    // The immediate line keeps its PRE-48-02 shape so existing greps survive.
    expect(watchErrorLines(deps)).toHaveLength(1);
    expect(summaryLines(deps)).toHaveLength(0);

    vi.advanceTimersByTime(WATCH_ERROR_WINDOW_MS);
    const s = summaryLines(deps);
    expect(s).toHaveLength(1);
    expect(s[0].count).toBe(500);
    expect(s[0].byCode).toEqual({ EACCES: 500 });
  });

  it('a single isolated error is still logged IMMEDIATELY (no 60s delay)', async () => {
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    watchCalls[0].instance.emit('error', Object.assign(new Error('EPERM x'), { code: 'EPERM' }));
    expect(watchErrorLines(deps)).toHaveLength(1);
  });

  // AC-11 — ENOSPC must never enter a window.
  it('ENOSPC bypasses the aggregator entirely', async () => {
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const inst = watchCalls[0].instance;
    for (let i = 0; i < 5; i++) {
      inst.emit('error', Object.assign(new Error('ENOSPC: System limit'), { code: 'ENOSPC' }));
    }
    expect(getWatcherSnapshot().status).toBe('error');
    expect(deps.log.error).toHaveBeenCalled();
    // No window was opened, so nothing was suppressed and no summary exists.
    expect(__forTests_getWatchErrorAggregatorState().windowOpen).toBe(false);
    expect(watchErrorLines(deps)).toHaveLength(0);
    expect(summaryLines(deps)).toHaveLength(0);
    await stopWatcher();
  });

  // AC-12 — the window must not outlive the watcher.
  it('stopWatcher clears the pending window timer', async () => {
    vi.useFakeTimers();
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    watchCalls[0].instance.emit('error', Object.assign(new Error('EACCES a'), { code: 'EACCES' }));
    watchCalls[0].instance.emit('error', Object.assign(new Error('EACCES b'), { code: 'EACCES' }));
    expect(__forTests_getWatchErrorAggregatorState().windowOpen).toBe(true);

    await stopWatcher();
    expect(__forTests_getWatchErrorAggregatorState().windowOpen).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(WATCH_ERROR_WINDOW_MS * 5);
    expect(summaryLines(deps)).toHaveLength(0);
  });

  it('resetWatcherState clears the pending window timer and the escalation state', async () => {
    vi.useFakeTimers();
    const shares = [makeShare(1, 'media', '/mnt/media')];
    const deps = makeDeps(shares);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(deps as any);
    const inst = watchCalls[0].instance;
    inst.emit('error', Object.assign(new Error('EACCES a'), { code: 'EACCES' }));
    inst.emit('error', Object.assign(new Error('EACCES b'), { code: 'EACCES' }));
    vi.advanceTimersByTime(WATCH_ERROR_WINDOW_MS); // escalate to 120s + re-arm
    expect(__forTests_getWatchErrorAggregatorState().currentWindowMs).toBe(120_000);

    resetWatcherState();
    expect(vi.getTimerCount()).toBe(0);
    expect(__forTests_getWatchErrorAggregatorState()).toEqual({
      windowOpen: false,
      count: 0,
      currentWindowMs: WATCH_ERROR_WINDOW_MS,
    });
  });
});
