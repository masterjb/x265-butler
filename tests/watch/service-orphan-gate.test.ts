// 50-03 Task 3 — the orphan media gate in findOrphanFileIds.
//
// NEW file so `tests/watch/reconcile.test.ts` stays untouched (AC-18) — which is
// also the proof that `ReconcileDeps.findOrphanFileIds` kept its `() => number[]`
// signature (E7).
//
// TEST SEAM (audit-added M4): `findOrphanFileIds` is module-private and STAYS
// private — the module surface does not grow for a test. It is reached through
// the seam `tests/watch/service-boot-scan-toggle.test.ts` already uses: mock
// `@/src/lib/watch/reconcile`, run `startWatcherService()`, and take the function
// out of the recorded call arguments.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  settingStore,
  orphanRows,
  shareRows,
  prepareSpy,
  listAllSpy,
  startWatcherSpy,
  stopWatcherSpy,
  runBootReconcileSpy,
  startPeriodicReconcileSpy,
  stopPeriodicReconcileSpy,
  setStatusSpy,
  deleteByIdSpy,
} = vi.hoisted(() => {
  const orphanRows: Array<{ id: number; path: string; share_id: number | null }> = [];
  const shareRows: Array<{ id: number; extensions_csv: string }> = [];
  const listAllSpy = vi.fn(() => shareRows);
  return {
    settingStore: new Map<string, string>(),
    orphanRows,
    shareRows,
    listAllSpy,
    // The parameter types are load-bearing, not decoration: a `vi.fn(() => …)`
    // records `mock.calls` as `[][]`, and reading `calls[0][0]` off that is a
    // tsc error (TS2493) that vitest itself would never surface.
    prepareSpy: vi.fn((sql: string) => {
      void sql;
      return { all: () => orphanRows };
    }),
    startWatcherSpy: vi.fn(async () => {}),
    stopWatcherSpy: vi.fn(async () => {}),
    runBootReconcileSpy: vi.fn(async (deps: unknown) => {
      void deps;
      return { reconcileCount: 0, orphanReEnqueueCount: 0 };
    }),
    startPeriodicReconcileSpy: vi.fn((deps: unknown) => {
      void deps;
      return { timer: setInterval(() => {}, 1_000_000) };
    }),
    stopPeriodicReconcileSpy: vi.fn(),
    setStatusSpy: vi.fn(),
    deleteByIdSpy: vi.fn(),
  };
});

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({
    get: (k: string) => settingStore.get(k),
    set: (k: string, v: string) => settingStore.set(k, v),
    getAll: () => Object.fromEntries(settingStore),
  }),
  shareRepo: () => ({
    listAll: listAllSpy,
    getById: (id: number) => shareRows.find((s) => s.id === id),
  }),
  fileRepo: () => ({ setStatus: setStatusSpy, deleteById: deleteByIdSpy }),
  jobRepo: () => ({ listActive: () => [], countByStatus: () => 0 }),
  blocklistRepo: () => ({}),
  getDb: () => ({ prepare: prepareSpy }),
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
    dirsVisited: 0,
    dirsSkippedCycle: 0,
    dirsSkippedUnreadable: 0,
    dirsSkippedMaxDepth: 0,
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
  getWatcherSnapshot: () => ({ status: 'running' }),
  resetWatcherState: vi.fn(),
  setReconcileResult: vi.fn(),
  setWatcherStatusEnum: vi.fn(),
}));

vi.mock('@/src/lib/watch/reconcile', () => ({
  runBootReconcile: runBootReconcileSpy,
  startPeriodicReconcile: startPeriodicReconcileSpy,
  stopPeriodicReconcile: stopPeriodicReconcileSpy,
}));

import { startWatcherService, __forTests_resetWatcherService } from '@/src/lib/watch/service';
import { __resetIngestFilterMemoForTests } from '@/src/lib/scan/media-eligibility';

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

type OrphanRow = { id: number; path: string; share_id: number | null };

/**
 * Runs the boot path and hands back the production `findOrphanFileIds` closure
 * out of the recorded ReconcileDeps — the module surface stays unchanged.
 */
async function resolveFinder(
  rows: OrphanRow[],
  shares: Array<{ id: number; extensions_csv: string }> = [{ id: 1, extensions_csv: 'mkv,mp4' }],
): Promise<{ find: () => number[]; log: ReturnType<typeof makeLog> }> {
  orphanRows.length = 0;
  orphanRows.push(...rows);
  shareRows.length = 0;
  shareRows.push(...shares);

  const log = makeLog();
  await startWatcherService(log as never);

  const deps = runBootReconcileSpy.mock.calls[0]?.[0] as unknown as {
    findOrphanFileIds: () => number[];
  };
  expect(typeof deps.findOrphanFileIds).toBe('function');
  return { find: deps.findOrphanFileIds, log };
}

function suppressedLines(log: ReturnType<typeof makeLog>) {
  return log.info.mock.calls.filter(
    (c) =>
      (c[0] as { action?: string } | undefined)?.action ===
      'auto_scan_orphan_media_gate_suppressed',
  );
}

beforeEach(() => {
  settingStore.clear();
  settingStore.set('autoScan.enabled', 'true');
  settingStore.set('autoScan.bootScanOnStart', 'true');
  runBootReconcileSpy.mockClear();
  startPeriodicReconcileSpy.mockClear();
  listAllSpy.mockClear();
  prepareSpy.mockClear();
  setStatusSpy.mockClear();
  deleteByIdSpy.mockClear();
  __resetIngestFilterMemoForTests();
  delete process.env.WATCH_INGEST_FILTER_DISABLED;
});

afterEach(() => {
  __forTests_resetWatcherService();
  __resetIngestFilterMemoForTests();
  delete process.env.WATCH_INGEST_FILTER_DISABLED;
});

// ────────────────────────────────────────────────────────────────────────────
// AC-7 — a row that cannot be a medium is not re-enqueued
// ────────────────────────────────────────────────────────────────────────────

describe('AC-7 — non-media orphans are held back', () => {
  it('a sidecar JSON row is excluded', async () => {
    const { find } = await resolveFinder([
      { id: 1, path: '/mnt/media/film.mkv.x265-butler.json', share_id: 1 },
      { id: 2, path: '/mnt/media/film.mkv', share_id: 1 },
    ]);
    expect(find()).toEqual([2]);
  });

  it('a .jpg row is excluded EVEN WITH a probed codec — the gate never looks at it', async () => {
    // M-A: ffprobe answers cover.jpg with codec_name=mjpeg, so this row carries a
    // NON-NULL codec. If the gate were secretly codec-based, this id would survive.
    const { find } = await resolveFinder([
      { id: 10, path: '/mnt/media/poster.jpg', share_id: 1, codec: 'mjpeg' } as OrphanRow,
      { id: 11, path: '/mnt/media/film.mkv', share_id: 1 },
    ]);
    expect(find()).toEqual([11]);
  });

  it('.nfo / .srt / .tmp rows are excluded together', async () => {
    const { find } = await resolveFinder([
      { id: 1, path: '/mnt/media/a.nfo', share_id: 1 },
      { id: 2, path: '/mnt/media/a.srt', share_id: 1 },
      { id: 3, path: '/mnt/media/a.mkv.x265-butler.json.tmp', share_id: 1 },
      { id: 4, path: '/mnt/media/a.mp4', share_id: 1 },
    ]);
    expect(find()).toEqual([4]);
  });

  it('an empty orphan set stays empty', async () => {
    const { find, log } = await resolveFinder([]);
    expect(find()).toEqual([]);
    expect(suppressedLines(log)).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC-8 — the case a codec gate would have lost forever (M-C)
// ────────────────────────────────────────────────────────────────────────────

describe('AC-8 — a transiently-unprobed .mkv keeps its recovery', () => {
  it('a .mkv row whose probe failed (codec NULL) is STILL re-enqueued', async () => {
    // M-C: the scan fast path never re-probes an unchanged file, so this row would
    // keep codec=NULL forever. A codec gate would take its recovery away silently
    // AND permanently. This test is the reason E1 chose the extension.
    const { find } = await resolveFinder([
      { id: 5, path: '/mnt/media/transient.mkv', share_id: 1, codec: null } as OrphanRow,
    ]);
    expect(find()).toEqual([5]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC-9 — share_id NULL / deleted share fall back to the default list
// ────────────────────────────────────────────────────────────────────────────

describe('AC-9 — rows without a share', () => {
  it('share_id NULL → DEFAULT_MEDIA_EXTENSIONS decides', async () => {
    const { find } = await resolveFinder([
      { id: 1, path: '/mnt/media/legacy.mkv', share_id: null },
      { id: 2, path: '/mnt/media/legacy.json', share_id: null },
    ]);
    expect(find()).toEqual([1]);
  });

  it('a share deleted via ON DELETE SET NULL semantics (id not in listAll) falls back too', async () => {
    const { find } = await resolveFinder(
      [
        { id: 1, path: '/mnt/media/gone.mkv', share_id: 99 },
        { id: 2, path: '/mnt/media/gone.jpg', share_id: 99 },
      ],
      [{ id: 1, extensions_csv: 'mkv,mp4' }],
    );
    expect(find()).toEqual([1]);
  });

  it("a share's OWN allowlist wins over the default", async () => {
    // 'avi' is in the default list but NOT in this share's csv → excluded.
    const { find } = await resolveFinder(
      [
        { id: 1, path: '/mnt/media/a.avi', share_id: 1 },
        { id: 2, path: '/mnt/media/a.mkv', share_id: 1 },
      ],
      [{ id: 1, extensions_csv: 'mkv' }],
    );
    expect(find()).toEqual([2]);
  });

  it('AC-19 on this surface: an EMPTY extensions_csv falls back, it does not reject everything', async () => {
    const { find } = await resolveFinder(
      [
        { id: 1, path: '/mnt/media/a.mkv', share_id: 1 },
        { id: 2, path: '/mnt/media/a.json', share_id: 1 },
      ],
      [{ id: 1, extensions_csv: '' }],
    );
    expect(find()).toEqual([1]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC-10 — suppressed orphans are visible, never silent (E8)
// ────────────────────────────────────────────────────────────────────────────

describe('AC-10 — auto_scan_orphan_media_gate_suppressed', () => {
  it('exactly one info line with suppressed, total and at most 5 samples', async () => {
    const rows: OrphanRow[] = [];
    for (let i = 0; i < 12; i++)
      rows.push({ id: i + 1, path: `/mnt/media/j${i}.jpg`, share_id: 1 });
    rows.push({ id: 100, path: '/mnt/media/film.mkv', share_id: 1 });

    const { find, log } = await resolveFinder(rows);
    expect(find()).toEqual([100]);

    const lines = suppressedLines(log);
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toMatchObject({ suppressed: 12, total: 13 });
    expect((lines[0][0] as { samples: string[] }).samples).toHaveLength(5);
  });

  it('suppressed === 0 logs NOTHING', async () => {
    const { find, log } = await resolveFinder([{ id: 1, path: '/mnt/media/a.mkv', share_id: 1 }]);
    expect(find()).toEqual([1]);
    expect(suppressedLines(log)).toHaveLength(0);
  });

  it('the line repeats on every tick while the rows exist (documented, not a bug)', async () => {
    const { find, log } = await resolveFinder([{ id: 1, path: '/mnt/media/a.jpg', share_id: 1 }]);
    find();
    find();
    find();
    expect(suppressedLines(log)).toHaveLength(3);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC-11 — the kill-switch also turns this surface off
// ────────────────────────────────────────────────────────────────────────────

describe('AC-11 — WATCH_INGEST_FILTER_DISABLED=1 on the orphan surface', () => {
  it('every pending row without an active job comes back, and nothing is logged', async () => {
    process.env.WATCH_INGEST_FILTER_DISABLED = '1';
    __resetIngestFilterMemoForTests();
    const { find, log } = await resolveFinder([
      { id: 1, path: '/mnt/media/film.mkv.x265-butler.json', share_id: 1 },
      { id: 2, path: '/mnt/media/poster.jpg', share_id: 1 },
      { id: 3, path: '/mnt/media/film.mkv', share_id: 1 },
    ]);
    expect(find()).toEqual([1, 2, 3]);
    expect(suppressedLines(log)).toHaveLength(0);
  });

  it('with the switch off it does not even read the shares', async () => {
    process.env.WATCH_INGEST_FILTER_DISABLED = '1';
    __resetIngestFilterMemoForTests();
    const { find } = await resolveFinder([{ id: 1, path: '/mnt/media/a.jpg', share_id: 1 }]);
    listAllSpy.mockClear();
    find();
    expect(listAllSpy).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// E12 — one listAll() per tick, never one per row
// ────────────────────────────────────────────────────────────────────────────

describe('E12 — share resolution cost', () => {
  it('reads the share table ONCE per tick regardless of row count', async () => {
    const rows: OrphanRow[] = [];
    for (let i = 0; i < 500; i++)
      rows.push({ id: i + 1, path: `/mnt/media/f${i}.mkv`, share_id: 1 });

    const { find } = await resolveFinder(rows);
    listAllSpy.mockClear();
    expect(find()).toHaveLength(500);
    expect(listAllSpy).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// AC-14 — the gate is READ-ONLY. Existing rows are not touched (E9 / CONTEXT-D5)
// ────────────────────────────────────────────────────────────────────────────

describe('AC-14 — no write to existing data', () => {
  it('a stored sidecar row survives boot + reconcile tick unchanged', async () => {
    const { find } = await resolveFinder([
      { id: 1, path: '/mnt/media/film.mkv.x265-butler.json', share_id: 1 },
    ]);
    // boot ran in resolveFinder; run the tick's finder as the reconcile would
    expect(find()).toEqual([]);

    expect(setStatusSpy).not.toHaveBeenCalled();
    expect(deleteByIdSpy).not.toHaveBeenCalled();
    // and the SELECT really is a SELECT
    for (const call of prepareSpy.mock.calls) {
      expect(String(call[0])).toMatch(/^\s*SELECT/);
      expect(String(call[0])).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i);
    }
  });
});
