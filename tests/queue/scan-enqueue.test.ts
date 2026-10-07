// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createScanEnqueueHook, type ScanEnqueueDeps } from '@/src/lib/queue/scan-enqueue';
import type { FileRow, FileStatus } from '@/src/lib/db/schema';

function row(id: number, version = 1, status: FileStatus = 'pending'): FileRow {
  return { id, version, status, path: `/m/${id}.mkv` } as FileRow;
}

function makeDeps(opts: {
  autoEncode?: () => string | undefined;
  fresh?: (id: number) => FileRow | undefined;
  enqueue?: (id: number, encoder: string, version: number, crf: null) => unknown;
}) {
  const enqueue = vi.fn(opts.enqueue ?? (() => ({ id: 1 })));
  const emit = vi.fn();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), telemetry: vi.fn() };
  const deps: ScanEnqueueDeps = {
    settingRepo: () => ({
      get: (k: string) => (k === 'auto_encode' ? (opts.autoEncode ?? (() => 'true'))() : undefined),
    }),
    fileRepo: () => ({ getById: (id: number) => (opts.fresh ? opts.fresh(id) : row(id)) }),
    jobRepo: () => ({ enqueue }) as never,
    encoder: () => 'auto',
    emitQueueUpdated: emit,
    log: log as never,
  };
  return { deps, enqueue, emit, log };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('scan enqueue hook', () => {
  it('enqueues pending rows when auto encode is on', () => {
    const { deps, enqueue } = makeDeps({ fresh: (id) => row(id, 3) });
    const hook = createScanEnqueueHook(deps);

    expect(hook.onPending(row(7, 3))).toBe(true);

    expect(enqueue).toHaveBeenCalledWith(7, 'auto', 3, null);
    expect(hook.enqueuedCount()).toBe(1);
  });

  it.each([['false'], [undefined], ['TRUE'], ['1']])(
    'does nothing when auto encode is %s',
    (value) => {
      const { deps, enqueue } = makeDeps({ autoEncode: () => value });
      const hook = createScanEnqueueHook(deps);

      expect(hook.onPending(row(1))).toBe(false);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it('reads the switch per call', () => {
    let value = 'true';
    const { deps, enqueue } = makeDeps({ autoEncode: () => value });
    const hook = createScanEnqueueHook(deps);

    hook.onPending(row(1));
    value = 'false';
    hook.onPending(row(2));

    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('skips a row that is no longer pending at hook time', () => {
    const { deps, enqueue } = makeDeps({ fresh: (id) => row(id, 2, 'skipped-sidecar') });
    const hook = createScanEnqueueHook(deps);

    expect(hook.onPending(row(1))).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('uses the fresh version', () => {
    const { deps, enqueue } = makeDeps({ fresh: (id) => row(id, 9) });
    const hook = createScanEnqueueHook(deps);

    hook.onPending(row(1, 1));

    expect(enqueue).toHaveBeenCalledWith(1, 'auto', 9, null);
  });

  it('a vanished row is skipped', () => {
    const { deps, enqueue } = makeDeps({ fresh: () => undefined });
    expect(createScanEnqueueHook(deps).onPending(row(1))).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('emits queue.updated once per batch only if something was enqueued', () => {
    const { deps, emit } = makeDeps({});
    const hook = createScanEnqueueHook(deps);

    hook.onBatchEnd();
    expect(emit).not.toHaveBeenCalled();

    hook.onPending(row(1));
    hook.onPending(row(2));
    hook.onBatchEnd();
    hook.onBatchEnd();

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('null from enqueue is not counted', () => {
    const { deps } = makeDeps({ enqueue: () => null });
    const hook = createScanEnqueueHook(deps);

    expect(hook.onPending(row(1))).toBe(false);
    expect(hook.enqueuedCount()).toBe(0);
  });

  it('enqueue throw is logged and skipped', () => {
    let n = 0;
    const { deps, log } = makeDeps({
      enqueue: () => {
        n++;
        if (n === 1) throw new Error('db busy');
        return { id: 2 };
      },
    });
    const hook = createScanEnqueueHook(deps);

    expect(hook.onPending(row(1))).toBe(false);
    expect(hook.onPending(row(2))).toBe(true);
    expect(log.warn.mock.calls.filter((c) => c[0]?.action === 'scan_enqueue_failed')).toHaveLength(
      1,
    );
  });

  it('stops at the per-scan cap and warns once', () => {
    vi.stubEnv('RECONCILE_ORPHAN_CAP', '2');
    const { deps, enqueue, log } = makeDeps({});
    const hook = createScanEnqueueHook(deps);

    const results = [1, 2, 3, 4].map((id) => hook.onPending(row(id)));

    expect(results).toEqual([true, true, false, false]);
    expect(enqueue).toHaveBeenCalledTimes(2);
    const warns = log.warn.mock.calls.filter((c) => c[0]?.action === 'scan_enqueue_capped');
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({ capped: 2 });
    expect(hook.cappedCount()).toBe(2);
  });

  it.each([['abc'], ['0'], ['-5'], ['']])(
    'cap parses like RECONCILE_ORPHAN_CAP (%s ⇒ 1000)',
    (value) => {
      vi.stubEnv('RECONCILE_ORPHAN_CAP', value);
      const { deps, enqueue } = makeDeps({});
      const hook = createScanEnqueueHook(deps);
      for (let id = 1; id <= 1001; id++) hook.onPending(row(id));
      expect(enqueue).toHaveBeenCalledTimes(1000);
    },
  );
});
