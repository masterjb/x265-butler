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

  it('1 shfs share → 1 pollingInstance with usePolling=true', async () => {
    const shares = [makeShare(2, 'user-share', '/mnt/user/Media')];
    vi.mocked(detectMountMode).mockReturnValue('polling-forced');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(makeDeps(shares) as any);
    expect(watchCalls).toHaveLength(1);
    expect(watchCalls[0].opts.usePolling).toBe(true);
    expect(watchCalls[0].opts.interval).toBe(2000);
    expect(getWatcherSnapshot().pollingModeByShare).toEqual({ 'user-share': 'polling-forced' });
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
  it('70 events in 60s → 60 enqueued + 10 dropped + droppedEventsLast24h=10', async () => {
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
    expect(
      deps.log.warn.mock.calls.filter((c: unknown[]) => {
        const arg = c[0] as { action?: string };
        return arg.action === 'auto_scan_rate_cap_drop';
      }),
    ).toHaveLength(10);
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
