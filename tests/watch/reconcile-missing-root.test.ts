// A share whose root is not mapped (VOLUME /media removed) must
// not take the auto-scan down. The walker keeps throwing on a missing root (its
// contract); the reconcile is the caller that must contain it: no throw, one
// error line per tick, nothing enqueued.
import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { runBootReconcile, type ReconcileDeps } from '@/src/lib/watch/reconcile';
import { walkFiles } from '@/src/lib/scan/walker';
import type { ShareRow } from '@/src/lib/db/schema';

const MISSING_ROOT = path.join(os.tmpdir(), `x265-54-01-missing-${process.pid}`);

function makeDeps(): {
  deps: ReconcileDeps;
  error: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
} {
  const share = {
    id: 1,
    name: 'Library',
    path: MISSING_ROOT,
    min_size_mb: 0,
    extensions_csv: 'mkv',
    max_depth: null,
    created_at: 0,
    updated_at: 0,
  } as ShareRow;
  const error = vi.fn();
  const enqueue = vi.fn();
  const log = {
    error,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    telemetry: vi.fn(),
    child: vi.fn(),
  };
  log.child.mockReturnValue(log);
  const deps = {
    shareRepo: () => ({ listAll: () => [share] }),
    fileRepo: () => ({}),
    jobRepo: () => ({ enqueue }),
    settingRepo: () => ({ get: () => null, getAll: () => ({}) }),
    // The real walker on the missing root: the exact error the auto-scan sees.
    runScan: async (opts: { rootPath: string }) => {
      const it = walkFiles(opts.rootPath, { extensions: ['mkv'], minSizeMb: 0 });
      await it.next();
      throw new Error('unreachable: walker must throw on a missing root');
    },
    findOrphanFileIds: () => [],
    encoderResolver: () => 'libx265',
    emitQueueUpdated: vi.fn(),
    log,
  } as unknown as ReconcileDeps;
  return { deps, error, enqueue };
}

describe('reconcile with an unmapped share root', () => {
  it('walker throws "root not accessible" on the missing root (contract unchanged)', async () => {
    const it = walkFiles(MISSING_ROOT, { extensions: ['mkv'], minSizeMb: 0 });
    await expect(it.next()).rejects.toThrow(/root not accessible/);
  });

  it('runBootReconcile does not throw, logs exactly one error, enqueues nothing', async () => {
    const { deps, error, enqueue } = makeDeps();
    await expect(runBootReconcile(deps)).resolves.toEqual({
      reconcileCount: 0,
      orphanReEnqueueCount: 0,
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatchObject({ action: 'auto_scan_reconcile_run_scan_failed' });
    expect(String(error.mock.calls[0][0].err)).toMatch(/root not accessible/);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
