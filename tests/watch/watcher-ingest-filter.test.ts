// 50-03 Task 2 — the watch-path media-eligibility filter.
//
// NEW file on purpose: `tests/watch/watcher.test.ts` and `tests/watch/ingest.test.ts`
// stay untouched (AC-18), which is also the proof that the new IngestDeps fields
// are genuinely optional.
//
// The add-event tests drive the REAL `ingestSingleFile` through the watcher's
// deps — not a spy — so "not hashed, not probed, no row" is asserted where it
// matters (AC-1) instead of one layer above it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ShareRow } from '@/src/lib/db/schema';

const { mockHashFile, mockFfprobe, mockRunSkipPipeline, mockStat, mockEmit } = vi.hoisted(() => ({
  mockHashFile: vi.fn(),
  mockFfprobe: vi.fn(),
  mockRunSkipPipeline: vi.fn(),
  mockStat: vi.fn(),
  mockEmit: vi.fn(),
}));

vi.mock('@/src/lib/watch/mount-detect', () => ({
  detectMountMode: vi.fn(() => 'inotify' as const),
  readMaxUserWatches: vi.fn(() => 524288),
  countCurrentInotifyWatches: vi.fn(() => 42),
}));
vi.mock('@/src/lib/scan/hash', () => ({
  hashFile: mockHashFile,
  default: { hashFile: mockHashFile },
}));
vi.mock('@/src/lib/scan/ffprobe', () => ({
  ffprobe: mockFfprobe,
  default: { ffprobe: mockFfprobe },
}));
vi.mock('@/src/lib/skip', () => ({ runSkipPipeline: mockRunSkipPipeline }));
vi.mock('@/src/lib/encode/events', () => ({ engineEvents: { emit: mockEmit } }));
vi.mock('node:fs', () => ({
  default: { promises: { stat: mockStat } },
  promises: { stat: mockStat },
}));

import {
  startWatcher,
  stopWatcher,
  resetWatcherState,
  __setWatcherFactoryForTests,
  __resetWatcherFactoryForTests,
  __resetFollowSymlinksMemoForTests,
  __forTests_getInternalState,
  type WatcherFactory,
} from '@/src/lib/watch/watcher';
import { ingestSingleFile } from '@/src/lib/watch/ingest';
import {
  SIDECAR_IGNORE_RE,
  resolveAllowedExtensions,
  __resetIngestFilterMemoForTests,
} from '@/src/lib/scan/media-eligibility';
import { sidecarPathForSource, SIDECAR_TMP_SUFFIX } from '@/src/lib/encode/sidecar';
import { __resetSystemPruneMemoForTests } from '@/src/lib/fs/system-paths';

// ────────────────────────────────────────────────────────────────────────────
// Fake chokidar
// ────────────────────────────────────────────────────────────────────────────

class FakeFSWatcher extends EventEmitter {
  watched = new Set<string>();
  closed = false;
  opts: Record<string, unknown> = {};
  constructor(paths: string | readonly string[], opts: Record<string, unknown>) {
    super();
    this.opts = opts;
    for (const p of Array.isArray(paths) ? paths : [paths as string]) this.watched.add(p);
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
}

const watchCalls: Array<{ opts: Record<string, unknown>; instance: FakeFSWatcher }> = [];

function makeFactory(): WatcherFactory {
  return {
    watch: ((paths: string | readonly string[], opts: Record<string, unknown>) => {
      const inst = new FakeFSWatcher(paths, opts);
      watchCalls.push({ opts, instance: inst });
      return inst;
    }) as unknown as WatcherFactory['watch'],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const SHARE_PATH = '/mnt/media';

function makeShare(overrides: Partial<ShareRow> = {}): ShareRow {
  return {
    id: 1,
    name: 'media',
    path: SHARE_PATH,
    min_size_mb: 0,
    extensions_csv: 'mkv,mp4',
    max_depth: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as ShareRow;
}

function makeLog() {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    telemetry: vi.fn(),
    child: () => log,
  };
  return log;
}

interface Harness {
  log: ReturnType<typeof makeLog>;
  deps: unknown;
  calls: string[];
  upsertByPath: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  ingestPaths: string[];
}

// Mirrors the production wiring in `service.ts:buildWatcherDeps` — the share is
// resolved per file and the two optional IngestDeps fields come from its row —
// so the double gate (onAddEvent + ingestSingleFile) is exercised as it ships.
function makeHarness(
  shares: ShareRow[],
  settings: Record<string, string> = { 'autoScan.batchWindow': '5000' },
): Harness {
  const log = makeLog();
  const calls: string[] = [];
  const upsertByPath = vi.fn((input: { path: string }) => {
    calls.push('upsertByPath');
    void input;
    return { id: 7, status: 'pending', version: 1 };
  });
  const enqueue = vi.fn(() => {
    calls.push('enqueue');
    return { id: 100 };
  });
  const setStatus = vi.fn(() => {
    calls.push('setStatus');
  });
  const ingestPaths: string[] = [];

  const deps = {
    shareRepo: () => ({
      listAll: () => shares,
      getById: (id: number) => shares.find((s) => s.id === id),
    }),
    settingRepo: () => ({ get: (k: string) => settings[k] }),
    fileRepo: () => ({ upsertByPath, setStatus, countByQuery: () => 0 }),
    jobRepo: () => ({ enqueue, listActive: () => [], countByStatus: () => 0 }),
    ingestSingleFile: (absPath: string, shareId: number | null) => {
      ingestPaths.push(absPath);
      const share = shareId === null ? undefined : shares.find((s) => s.id === shareId);
      return ingestSingleFile(absPath, shareId, {
        fileRepo: () => ({ upsertByPath, setStatus }) as never,
        jobRepo: () => ({ enqueue, listActive: () => [], countByStatus: () => 0 }) as never,
        blocklistRepo: () => ({}) as never,
        settingRepo: () => ({ get: (k: string) => settings[k] }) as never,
        log: log as never,
        encoderResolver: () => 'libx265',
        ...(share
          ? {
              allowedExtensions: resolveAllowedExtensions(share.extensions_csv).set,
              minSizeBytes: share.min_size_mb * 1024 * 1024,
            }
          : {}),
      });
    },
    runReconcile: vi.fn(async () => ({ filesAdded: 0, filesUpdated: 0 })),
    emitQueueUpdated: vi.fn(),
    log,
  };

  return { log, deps, calls, upsertByPath, enqueue, setStatus, ingestPaths };
}

function statOf(sizeBytes: number) {
  return { isFile: () => true, size: sizeBytes, mtimeMs: 1_000_000 };
}

const MB = 1024 * 1024;

function logCalls(log: ReturnType<typeof makeLog>, level: 'info' | 'warn', action: string) {
  return log[level].mock.calls.filter(
    (c) => (c[0] as { action?: string } | undefined)?.action === action,
  );
}

beforeEach(() => {
  resetWatcherState();
  watchCalls.length = 0;
  __setWatcherFactoryForTests(makeFactory());
  __resetIngestFilterMemoForTests();
  __resetFollowSymlinksMemoForTests();
  __resetSystemPruneMemoForTests();
  delete process.env.WATCH_INGEST_FILTER_DISABLED;
  mockHashFile.mockReset().mockResolvedValue('deadbeef');
  mockFfprobe.mockReset().mockResolvedValue({ codec: 'h264', container: 'matroska' });
  mockRunSkipPipeline.mockReset().mockResolvedValue({ skip: false });
  mockStat.mockReset().mockResolvedValue(statOf(2000 * MB));
  mockEmit.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  __resetWatcherFactoryForTests();
  resetWatcherState();
  __resetIngestFilterMemoForTests();
  delete process.env.WATCH_INGEST_FILTER_DISABLED;
});

// ────────────────────────────────────────────────────────────────────────────
// AC-2 — the sidecar pattern is in chokidar's `ignored`, both suffixes
// ────────────────────────────────────────────────────────────────────────────

describe('AC-2 — chokidar ignored carries the sidecar matcher', () => {
  type Matcher = RegExp | ((p: string) => boolean);

  function ignoredOf(): Matcher[] {
    return watchCalls[0].opts.ignored as Matcher[];
  }
  function isIgnored(p: string): boolean {
    return ignoredOf().some((m) => (m instanceof RegExp ? m.test(p) : m(p)));
  }

  beforeEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(makeHarness([makeShare()]).deps as any);
  });

  it('ignores both sidecar suffixes', () => {
    expect(isIgnored(sidecarPathForSource(`${SHARE_PATH}/film.mkv`))).toBe(true);
    expect(isIgnored(`${SHARE_PATH}/film.mkv${SIDECAR_TMP_SUFFIX}`)).toBe(true);
  });

  it('does not ignore a merely similar name, nor a real medium', () => {
    expect(isIgnored(`${SHARE_PATH}/film.mkv.x265-butler.jsonx`)).toBe(false);
    expect(isIgnored(`${SHARE_PATH}/film.mkv`)).toBe(false);
  });

  it('is the EXPORTED RegExp, not a re-typed literal', () => {
    expect(ignoredOf()).toContain(SIDECAR_IGNORE_RE);
  });

  it('keeps the pre-50-03 matchers intact (dotfile + system prefix)', () => {
    expect(ignoredOf()).toHaveLength(3); // DOTFILE_RE + SIDECAR_IGNORE_RE + systemMatcher
    expect(isIgnored(`${SHARE_PATH}/.hidden`)).toBe(true);
    expect(isIgnored('/proc/self/status')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC-1 / AC-3 — a non-medium is neither hashed nor probed nor written
// ────────────────────────────────────────────────────────────────────────────

describe('AC-1 / AC-3 — non-media add-events produce nothing', () => {
  async function emitAndFlush(h: Harness, paths: string[]): Promise<void> {
    vi.useFakeTimers();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    for (const p of paths) watchCalls[0].instance.emit('add', p);
    await vi.advanceTimersByTimeAsync(5_000);
  }

  it('AC-1: a sidecar JSON is not buffered, hashed, probed, upserted or enqueued', async () => {
    const h = makeHarness([makeShare()]);
    await emitAndFlush(h, [sidecarPathForSource(`${SHARE_PATH}/film.mkv`)]);

    expect(h.ingestPaths).toEqual([]);
    expect(mockHashFile).not.toHaveBeenCalled();
    expect(mockFfprobe).not.toHaveBeenCalled();
    expect(h.upsertByPath).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    // AC-14, watch-event leg: an ALREADY-STORED row for this path is not
    // touched either — the filter drops the event, it does not rewrite history.
    expect(h.setStatus).not.toHaveBeenCalled();
  });

  it('AC-1: the .tmp form of an aborted atomic write is discarded too', async () => {
    const h = makeHarness([makeShare()]);
    await emitAndFlush(h, [`${SHARE_PATH}/film.mkv${SIDECAR_TMP_SUFFIX}`]);
    expect(mockHashFile).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('AC-3: a poster JPEG produces no job — although ffprobe would call it a video', async () => {
    // M-A measured: `ffprobe cover.jpg` exits 0 with codec_type=video /
    // codec_name=mjpeg. Pin that here so the test states WHY the extension gate
    // exists: the filter has to bite BEFORE the probe, because the probe agrees.
    mockFfprobe.mockResolvedValue({ codec: 'mjpeg', container: 'image2' });
    const h = makeHarness([makeShare({ extensions_csv: 'mkv,mp4' })]);
    await emitAndFlush(h, [`${SHARE_PATH}/poster.jpg`]);

    expect(mockFfprobe).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('AC-3: .nfo and .srt are discarded as well', async () => {
    const h = makeHarness([makeShare()]);
    await emitAndFlush(h, [`${SHARE_PATH}/movie.nfo`, `${SHARE_PATH}/subs.srt`]);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC-4 — the check runs BEFORE the buffer and before the 60/min admission
// ────────────────────────────────────────────────────────────────────────────

describe('AC-4 — non-media never reach the buffer or the rate cap', () => {
  it('100 rejected + 1 accepted → buffer holds only the .mkv, cap consumed once', async () => {
    vi.useFakeTimers();
    const h = makeHarness([makeShare()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    const inst = watchCalls[0].instance;

    for (let i = 0; i < 100; i++) inst.emit('add', `${SHARE_PATH}/junk-${i}.jpg`);
    inst.emit('add', `${SHARE_PATH}/film.mkv`);

    // BEFORE the flush: the buffer is the thing the rate cap later admits from.
    const buf = __forTests_getInternalState().batchBuffers.get(1);
    expect(buf?.size).toBe(1);
    expect([...(buf?.keys() ?? [])]).toEqual([`${SHARE_PATH}/film.mkv`]);

    await vi.advanceTimersByTimeAsync(5_000);

    // Pre-50-03 the 101 events would have consumed 60 slots and dropped 41 —
    // among them, on a bigger burst, the .mkv itself.
    expect(__forTests_getInternalState().rateLimitTimestamps).toHaveLength(1);
    expect(logCalls(h.log, 'warn', 'auto_scan_rate_cap_drop')).toHaveLength(0);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it('a 200-event junk burst does not drop a following .mkv (the displacement case)', async () => {
    vi.useFakeTimers();
    const h = makeHarness([makeShare()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    const inst = watchCalls[0].instance;

    for (let i = 0; i < 200; i++) inst.emit('add', `${SHARE_PATH}/junk-${i}.nfo`);
    inst.emit('add', `${SHARE_PATH}/film.mkv`);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(h.ingestPaths).toEqual([`${SHARE_PATH}/film.mkv`]);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC-5 — the size gate stays in the ingest and uses the share's min_size_mb
// ────────────────────────────────────────────────────────────────────────────

describe('AC-5 — min_size_mb gate, before hashFile', () => {
  it('a 1 MB .mkv in a min_size_mb=50 share is dropped without being hashed', async () => {
    vi.useFakeTimers();
    mockStat.mockResolvedValue(statOf(1 * MB));
    const h = makeHarness([makeShare({ min_size_mb: 50 })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    watchCalls[0].instance.emit('add', `${SHARE_PATH}/small.mkv`);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockHashFile).not.toHaveBeenCalled();
    expect(mockFfprobe).not.toHaveBeenCalled();
    expect(h.upsertByPath).not.toHaveBeenCalled();

    const warns = logCalls(h.log, 'warn', 'auto_scan_ingest_filtered');
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({ reason: 'below_min_size' });
  });

  it('a file at exactly min_size_mb passes', async () => {
    vi.useFakeTimers();
    mockStat.mockResolvedValue(statOf(50 * MB));
    const h = makeHarness([makeShare({ min_size_mb: 50 })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    watchCalls[0].instance.emit('add', `${SHARE_PATH}/exact.mkv`);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockHashFile).toHaveBeenCalledTimes(1);
  });

  it('the defensive extension gate fires even when the caller passes no set', async () => {
    // E4: ingestSingleFile is public through WatcherDeps. Called directly with
    // neither optional field, it still refuses a non-medium — via the DEFAULT list.
    const log = makeLog();
    const upsertByPath = vi.fn();
    const res = await ingestSingleFile(`${SHARE_PATH}/poster.jpg`, null, {
      fileRepo: () => ({ upsertByPath, setStatus: vi.fn() }) as never,
      jobRepo: () => ({ enqueue: vi.fn() }) as never,
      blocklistRepo: () => ({}) as never,
      settingRepo: () => ({ get: () => undefined }) as never,
      log: log as never,
      encoderResolver: () => 'libx265',
    });

    expect(res).toEqual({ enqueued: false, skipped: false });
    expect(mockHashFile).not.toHaveBeenCalled();
    expect(upsertByPath).not.toHaveBeenCalled();
    expect(logCalls(log, 'warn', 'auto_scan_ingest_filtered')[0][0]).toMatchObject({
      reason: 'extension_not_allowed',
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC-6 — an allowed file runs through EXACTLY as before
// ────────────────────────────────────────────────────────────────────────────

describe('AC-6 — the happy path is unchanged', () => {
  it('call sequence is stat → hash → ffprobe → upsert → skip → enqueue → queue.updated', async () => {
    vi.useFakeTimers();
    const h = makeHarness([makeShare({ min_size_mb: 1 })]);
    mockStat.mockImplementation(async () => {
      h.calls.push('stat');
      return statOf(2000 * MB);
    });
    mockHashFile.mockImplementation(async () => {
      h.calls.push('hashFile');
      return 'deadbeef';
    });
    mockFfprobe.mockImplementation(async () => {
      h.calls.push('ffprobe');
      return { codec: 'h264', container: 'matroska' };
    });
    mockRunSkipPipeline.mockImplementation(async () => {
      h.calls.push('runSkipPipeline');
      return { skip: false };
    });
    mockEmit.mockImplementation((e: { type: string }) => {
      h.calls.push(e.type);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    watchCalls[0].instance.emit('add', `${SHARE_PATH}/film.mkv`);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(h.calls).toEqual([
      'stat',
      'hashFile',
      'ffprobe',
      'upsertByPath',
      'runSkipPipeline',
      'enqueue',
      'queue.updated',
    ]);
  });

  it('emits NO new warn and NO new info on the allowed path', async () => {
    vi.useFakeTimers();
    const h = makeHarness([makeShare()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    // the start-up lines (followSymlinks / ingest-filter) are not "on this path"
    h.log.info.mockClear();
    h.log.warn.mockClear();

    watchCalls[0].instance.emit('add', `${SHARE_PATH}/film.mkv`);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(h.log.warn).not.toHaveBeenCalled();
    expect(h.log.info).not.toHaveBeenCalled();
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC-11 — the kill-switch restores v2.46.x, EXCEPT for the sidecar ignore
// ────────────────────────────────────────────────────────────────────────────

describe('AC-11 — WATCH_INGEST_FILTER_DISABLED=1', () => {
  beforeEach(() => {
    process.env.WATCH_INGEST_FILTER_DISABLED = '1';
    __resetIngestFilterMemoForTests();
  });

  it('a .jpg is ingested again (extension gate off)', async () => {
    vi.useFakeTimers();
    const h = makeHarness([makeShare()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    watchCalls[0].instance.emit('add', `${SHARE_PATH}/poster.jpg`);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(h.ingestPaths).toEqual([`${SHARE_PATH}/poster.jpg`]);
    expect(mockHashFile).toHaveBeenCalledTimes(1);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it('the size gate is off too', async () => {
    vi.useFakeTimers();
    mockStat.mockResolvedValue(statOf(1 * MB));
    const h = makeHarness([makeShare({ min_size_mb: 50 })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    watchCalls[0].instance.emit('add', `${SHARE_PATH}/small.mkv`);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockHashFile).toHaveBeenCalledTimes(1);
  });

  it('but the sidecar STAYS excluded — E2b: the lever must not restore self-feeding', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(makeHarness([makeShare()]).deps as any);
    const ignored = watchCalls[0].opts.ignored as Array<RegExp | ((p: string) => boolean)>;
    expect(ignored).toContain(SIDECAR_IGNORE_RE);
    expect(SIDECAR_IGNORE_RE.test(sidecarPathForSource(`${SHARE_PATH}/film.mkv`))).toBe(true);
  });

  it('the resolved line reports enabled:false, source:env', async () => {
    const h = makeHarness([makeShare()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    expect(logCalls(h.log, 'info', 'watch_ingest_filter_resolved')[0][0]).toMatchObject({
      enabled: false,
      source: 'env',
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC-12b — exactly ONE resolved line per watcher START, none per event
// ────────────────────────────────────────────────────────────────────────────

describe('AC-12b — watch_ingest_filter_resolved', () => {
  it('exactly one line per startWatcher, with enabled + source', async () => {
    const h = makeHarness([makeShare()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    const lines = logCalls(h.log, 'info', 'watch_ingest_filter_resolved');
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toMatchObject({ enabled: true, source: 'default' });
  });

  it('sits next to the existing followSymlinks line', async () => {
    const h = makeHarness([makeShare()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    const actions = h.log.info.mock.calls.map((c) => (c[0] as { action?: string })?.action);
    expect(actions.indexOf('watch_ingest_filter_resolved')).toBe(
      actions.indexOf('watch_follow_symlinks_resolved') + 1,
    );
  });

  it('NO line is emitted on the event path', async () => {
    vi.useFakeTimers();
    const h = makeHarness([makeShare()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    h.log.info.mockClear();
    for (let i = 0; i < 5; i++) watchCalls[0].instance.emit('add', `${SHARE_PATH}/f${i}.mkv`);
    watchCalls[0].instance.emit('add', `${SHARE_PATH}/x.jpg`);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(logCalls(h.log, 'info', 'watch_ingest_filter_resolved')).toHaveLength(0);
  });

  it('a restart emits it again (per START, not per process)', async () => {
    const h = makeHarness([makeShare()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    await stopWatcher();
    resetWatcherState();
    __setWatcherFactoryForTests(makeFactory());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    expect(logCalls(h.log, 'info', 'watch_ingest_filter_resolved')).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC-19 — an empty extensions_csv never silently kills a share's watch ingest
// ────────────────────────────────────────────────────────────────────────────

describe('AC-19 — empty extensions_csv falls back and says so', () => {
  it('a .mkv still gets ingested', async () => {
    vi.useFakeTimers();
    const h = makeHarness([makeShare({ extensions_csv: '' })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    watchCalls[0].instance.emit('add', `${SHARE_PATH}/film.mkv`);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it('exactly ONE warn per share and watcher start — even after 10 events', async () => {
    vi.useFakeTimers();
    const h = makeHarness([makeShare({ extensions_csv: '   ' })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    for (let i = 0; i < 10; i++) watchCalls[0].instance.emit('add', `${SHARE_PATH}/f${i}.mkv`);
    for (let i = 0; i < 10; i++) watchCalls[0].instance.emit('add', `${SHARE_PATH}/f${i}.jpg`);
    await vi.advanceTimersByTimeAsync(5_000);

    const warns = logCalls(h.log, 'warn', 'watch_share_extensions_empty');
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({ shareId: 1 });
  });

  it('a non-medium is STILL rejected in such a share (the fallback is a list, not an amnesty)', async () => {
    vi.useFakeTimers();
    const h = makeHarness([makeShare({ extensions_csv: '' })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    watchCalls[0].instance.emit('add', `${SHARE_PATH}/poster.jpg`);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('a share with a real csv produces NO such warn', async () => {
    vi.useFakeTimers();
    const h = makeHarness([makeShare({ extensions_csv: 'mkv' })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    watchCalls[0].instance.emit('add', `${SHARE_PATH}/film.mkv`);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(logCalls(h.log, 'warn', 'watch_share_extensions_empty')).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC-20 — filtered events leave evidence: counter uncapped, lines capped at 20
// ────────────────────────────────────────────────────────────────────────────

describe('AC-20 — auto_scan_ingest_filtered_batch', () => {
  it('one line per window, with the count and at most 5 samples', async () => {
    vi.useFakeTimers();
    const h = makeHarness([makeShare()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    for (let i = 0; i < 100; i++) watchCalls[0].instance.emit('add', `${SHARE_PATH}/j${i}.jpg`);
    watchCalls[0].instance.emit('add', `${SHARE_PATH}/film.mkv`);
    await vi.advanceTimersByTimeAsync(5_000);

    const lines = logCalls(h.log, 'info', 'auto_scan_ingest_filtered_batch');
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toMatchObject({ shareId: 1, filtered: 100 });
    expect((lines[0][0] as { samples: string[] }).samples).toHaveLength(5);
  });

  it('a window holding ONLY filtered events still produces the line', async () => {
    // The interesting case: no buffer is allocated at all, so the flush timer
    // has to be armed by the DISCARD path or this line would never appear.
    vi.useFakeTimers();
    const h = makeHarness([makeShare()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    watchCalls[0].instance.emit('add', `${SHARE_PATH}/only.jpg`);
    expect(__forTests_getInternalState().batchBuffers.size).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(logCalls(h.log, 'info', 'auto_scan_ingest_filtered_batch')).toHaveLength(1);
  });

  it('N === 0 logs nothing (AC-6 stays clean)', async () => {
    vi.useFakeTimers();
    const h = makeHarness([makeShare()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    watchCalls[0].instance.emit('add', `${SHARE_PATH}/film.mkv`);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(logCalls(h.log, 'info', 'auto_scan_ingest_filtered_batch')).toHaveLength(0);
  });

  it('after 20 lines it keeps COUNTING but stops LOGGING (48-01 cap shape)', async () => {
    vi.useFakeTimers();
    const h = makeHarness([makeShare()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    for (let round = 0; round < 25; round++) {
      watchCalls[0].instance.emit('add', `${SHARE_PATH}/round-${round}.jpg`);
      await vi.advanceTimersByTimeAsync(5_000);
    }

    expect(logCalls(h.log, 'info', 'auto_scan_ingest_filtered_batch')).toHaveLength(20);
    expect(__forTests_getInternalState().ingestFilteredTotal).toBe(25);
  });

  it('the per-window tally is drained, not accumulated across windows', async () => {
    vi.useFakeTimers();
    const h = makeHarness([makeShare()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    watchCalls[0].instance.emit('add', `${SHARE_PATH}/a.jpg`);
    watchCalls[0].instance.emit('add', `${SHARE_PATH}/b.jpg`);
    await vi.advanceTimersByTimeAsync(5_000);
    watchCalls[0].instance.emit('add', `${SHARE_PATH}/c.jpg`);
    await vi.advanceTimersByTimeAsync(5_000);

    const lines = logCalls(h.log, 'info', 'auto_scan_ingest_filtered_batch');
    expect(lines.map((c) => (c[0] as { filtered: number }).filtered)).toEqual([2, 1]);
    expect(__forTests_getInternalState().ingestFilteredByShare.size).toBe(0);
  });

  it('emits nothing at all when the kill-switch is set', async () => {
    process.env.WATCH_INGEST_FILTER_DISABLED = '1';
    __resetIngestFilterMemoForTests();
    vi.useFakeTimers();
    const h = makeHarness([makeShare()]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startWatcher(h.deps as any);
    watchCalls[0].instance.emit('add', `${SHARE_PATH}/poster.jpg`);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(logCalls(h.log, 'info', 'auto_scan_ingest_filtered_batch')).toHaveLength(0);
    expect(__forTests_getInternalState().ingestFilteredTotal).toBe(0);
  });
});
