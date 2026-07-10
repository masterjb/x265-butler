import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runBootReconcile,
  startPeriodicReconcile,
  stopPeriodicReconcile,
  type ReconcileDeps,
} from '@/src/lib/watch/reconcile';
import type { ShareRow } from '@/src/lib/db/schema';

function makeShare(id: number, name: string, p: string): ShareRow {
  return {
    id,
    name,
    path: p,
    min_size_mb: 100,
    extensions_csv: 'mkv',
    max_depth: null,
    created_at: 0,
    updated_at: 0,
  } as ShareRow;
}

interface DepsStub extends ReconcileDeps {
  // expose mocks for assertions
  _scanMock: ReturnType<typeof vi.fn>;
  _orphanMock: ReturnType<typeof vi.fn>;
  _enqueueMock: ReturnType<typeof vi.fn>;
}

function makeDeps(opts: {
  shares?: ShareRow[];
  scanResult?: { filesAdded?: number; filesUpdated?: number };
  scanThrows?: boolean;
  orphanIds?: number[];
  orphanThrows?: boolean;
  enqueueReturns?: 'job' | 'null' | 'throw';
  reconcileIntervalH?: string;
}): DepsStub {
  const shares = opts.shares ?? [makeShare(1, 'a', '/mnt/a')];
  const scanMock = vi.fn(async () => {
    if (opts.scanThrows) throw new Error('boom');
    return {
      rootPath: shares[0].path,
      filesScanned: 0,
      filesAdded: opts.scanResult?.filesAdded ?? 0,
      filesUpdated: opts.scanResult?.filesUpdated ?? 0,
      filesUnchanged: 0,
      filesFailed: 0,
      filesVanished: 0,
      durationMs: 0,
      startedAt: 0,
      finishedAt: 0,
    };
  });
  const orphanMock = vi.fn(() => {
    if (opts.orphanThrows) throw new Error('orphan-fail');
    return opts.orphanIds ?? [];
  });
  const enqueueMock = vi.fn(() => {
    if (opts.enqueueReturns === 'throw') throw new Error('enqueue-fail');
    if (opts.enqueueReturns === 'null') return null;
    return { id: 999 };
  });
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  return {
    shareRepo: () =>
      ({
        listAll: () => shares,
      }) as unknown as ReconcileDeps['shareRepo'] extends () => infer R ? R : never,
    fileRepo: () =>
      ({
        getById: (id: number) => ({ id, version: 1, status: 'pending' as const }),
      }) as unknown as ReconcileDeps['fileRepo'] extends () => infer R ? R : never,
    jobRepo: () =>
      ({
        enqueue: enqueueMock,
      }) as unknown as ReconcileDeps['jobRepo'] extends () => infer R ? R : never,
    settingRepo: () =>
      ({
        get: (k: string) =>
          k === 'autoScan.reconcileIntervalH' ? opts.reconcileIntervalH : undefined,
      }) as unknown as ReconcileDeps['settingRepo'] extends () => infer R ? R : never,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runScan: scanMock as any,
    findOrphanFileIds: orphanMock,
    encoderResolver: () => 'libx265',
    emitQueueUpdated: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    log: log as any,
    _scanMock: scanMock,
    _orphanMock: orphanMock,
    _enqueueMock: enqueueMock,
  };
}

describe('runBootReconcile', () => {
  afterEach(() => {
    // 28-06 R10: no RECONCILE_ORPHAN_CAP bleed across tests.
    delete process.env.RECONCILE_ORPHAN_CAP;
  });

  it('invokes runScan once with first share path + extensions', async () => {
    const deps = makeDeps({ scanResult: { filesAdded: 3, filesUpdated: 2 } });
    const result = await runBootReconcile(deps);
    expect(deps._scanMock).toHaveBeenCalledTimes(1);
    expect(deps._scanMock.mock.calls[0][0]).toMatchObject({
      rootPath: '/mnt/a',
      extensions: ['mkv'],
      minSizeMb: 100,
    });
    expect(result.reconcileCount).toBe(5);
    expect(result.orphanReEnqueueCount).toBe(0);
  });

  it('noop when shareRepo.listAll returns empty', async () => {
    const deps = makeDeps({ shares: [] });
    const result = await runBootReconcile(deps);
    expect(deps._scanMock).not.toHaveBeenCalled();
    expect(result).toEqual({ reconcileCount: 0, orphanReEnqueueCount: 0 });
  });

  it('runScan throws → error logged, returns zero result', async () => {
    const deps = makeDeps({ scanThrows: true });
    const result = await runBootReconcile(deps);
    expect(result).toEqual({ reconcileCount: 0, orphanReEnqueueCount: 0 });
  });

  it('audit M10: orphan-sweep enqueues each returned file id', async () => {
    const deps = makeDeps({
      scanResult: { filesAdded: 1, filesUpdated: 0 },
      orphanIds: [10, 20, 30],
      enqueueReturns: 'job',
    });
    const result = await runBootReconcile(deps);
    expect(deps._orphanMock).toHaveBeenCalledTimes(1);
    expect(deps._enqueueMock).toHaveBeenCalledTimes(3);
    expect(result.orphanReEnqueueCount).toBe(3);
    expect(deps.emitQueueUpdated).toHaveBeenCalled();
  });

  it('audit M10: enqueue returning null does not bump orphan counter', async () => {
    const deps = makeDeps({
      orphanIds: [10, 20],
      enqueueReturns: 'null',
    });
    const result = await runBootReconcile(deps);
    expect(deps._enqueueMock).toHaveBeenCalledTimes(2);
    expect(result.orphanReEnqueueCount).toBe(0);
  });

  it('audit M4/AC-15: simulated 50 dropped → next reconcile re-discovers all 50', async () => {
    // Plan-level dedup is via skip-pipeline (SHA-256) inside runScan. Here we
    // verify the reconcile pathway calls runScan, whose multi-share branch
    // walks every share regardless of how watcher's rate-cap dropped events.
    // The 50 dropped files would re-appear in the next scanResult counters.
    const deps = makeDeps({ scanResult: { filesAdded: 50, filesUpdated: 0 } });
    const result = await runBootReconcile(deps);
    expect(result.reconcileCount).toBe(50);
  });

  it('orphan-query throws → warn logged, sweep skipped, reconcileCount preserved', async () => {
    const deps = makeDeps({
      scanResult: { filesAdded: 5 },
      orphanThrows: true,
    });
    const result = await runBootReconcile(deps);
    expect(result.reconcileCount).toBe(5);
    expect(result.orphanReEnqueueCount).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 28-06 R10: orphan re-enqueue cap (RECONCILE_ORPHAN_CAP)
  // ──────────────────────────────────────────────────────────────────────────

  it('AC-5: RECONCILE_ORPHAN_CAP=2 with 3 orphans → enqueues first 2 + capped-warn', async () => {
    process.env.RECONCILE_ORPHAN_CAP = '2';
    const deps = makeDeps({ orphanIds: [10, 20, 30], enqueueReturns: 'job' });
    const result = await runBootReconcile(deps);
    expect(deps._enqueueMock).toHaveBeenCalledTimes(2);
    expect(result.orphanReEnqueueCount).toBe(2);
    // first 2 ids (slice(0,2)) — SQLite return order preserved
    expect(deps._enqueueMock.mock.calls.map((c: unknown[]) => c[0])).toEqual([10, 20]);
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auto_scan_reconcile_orphan_capped',
        total: 3,
        capped: 2,
        deferred: 1,
      }),
      expect.any(String),
    );
  });

  it('AC-6: under-cap (unset → default 1000) enqueues all, no capped-log', async () => {
    const deps = makeDeps({ orphanIds: [10, 20], enqueueReturns: 'job' });
    const result = await runBootReconcile(deps);
    expect(deps._enqueueMock).toHaveBeenCalledTimes(2);
    expect(result.orphanReEnqueueCount).toBe(2);
    expect(deps.log.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auto_scan_reconcile_orphan_capped' }),
      expect.any(String),
    );
  });

  it('AC-6: malformed RECONCILE_ORPHAN_CAP ("0" / "abc") falls back to 1000', async () => {
    for (const bad of ['0', 'abc']) {
      process.env.RECONCILE_ORPHAN_CAP = bad;
      const deps = makeDeps({ orphanIds: [10, 20, 30], enqueueReturns: 'job' });
      const result = await runBootReconcile(deps);
      expect(deps._enqueueMock).toHaveBeenCalledTimes(3);
      expect(result.orphanReEnqueueCount).toBe(3);
      expect(deps.log.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auto_scan_reconcile_orphan_capped' }),
        expect.any(String),
      );
      delete process.env.RECONCILE_ORPHAN_CAP;
    }
  });

  it('audit SR-4: deferred remainder drains on the next tick (forward progress)', async () => {
    // tick 1: cap=2, orphans [10,20,30] → enqueue [10,20], defer 30.
    process.env.RECONCILE_ORPHAN_CAP = '2';
    const deps1 = makeDeps({ orphanIds: [10, 20, 30], enqueueReturns: 'job' });
    await runBootReconcile(deps1);
    expect(deps1._enqueueMock.mock.calls.map((c: unknown[]) => c[0])).toEqual([10, 20]);

    // tick 2: the 2 enqueued now have job rows → orphan LEFT JOIN excludes them →
    // findOrphanFileIds returns only [30]. Under cap → enqueued, no capped-log.
    const deps2 = makeDeps({ orphanIds: [30], enqueueReturns: 'job' });
    const result2 = await runBootReconcile(deps2);
    expect(deps2._enqueueMock).toHaveBeenCalledTimes(1);
    expect(deps2._enqueueMock.mock.calls[0][0]).toBe(30);
    expect(result2.orphanReEnqueueCount).toBe(1);
    expect(deps2.log.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auto_scan_reconcile_orphan_capped' }),
      expect.any(String),
    );
  });
});

describe('startPeriodicReconcile', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('fires reconcile at 6h interval by default', async () => {
    const deps = makeDeps({ scanResult: { filesAdded: 1 } });
    const onResult = vi.fn();
    const handle = startPeriodicReconcile(deps, onResult);
    await vi.advanceTimersByTimeAsync(6 * 3600 * 1000);
    await Promise.resolve();
    expect(deps._scanMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 3600 * 1000);
    await Promise.resolve();
    expect(deps._scanMock).toHaveBeenCalledTimes(2);
    stopPeriodicReconcile(handle);
  });

  it('honors custom autoScan.reconcileIntervalH', async () => {
    const deps = makeDeps({ reconcileIntervalH: '1' });
    const onResult = vi.fn();
    const handle = startPeriodicReconcile(deps, onResult);
    await vi.advanceTimersByTimeAsync(3600 * 1000);
    await Promise.resolve();
    expect(deps._scanMock).toHaveBeenCalledTimes(1);
    stopPeriodicReconcile(handle);
  });

  it('stopPeriodicReconcile clears the interval (no further invocations)', async () => {
    const deps = makeDeps({});
    const onResult = vi.fn();
    const handle = startPeriodicReconcile(deps, onResult);
    stopPeriodicReconcile(handle);
    await vi.advanceTimersByTimeAsync(6 * 3600 * 1000);
    await Promise.resolve();
    expect(deps._scanMock).not.toHaveBeenCalled();
  });
});
