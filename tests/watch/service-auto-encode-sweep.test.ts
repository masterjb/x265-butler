// Plan 52-04 E8 / AC-5: triggerAutoEncodeSweep is fire-and-forget. It enqueues
// the waiting files once and never lets a sweep failure escape to the caller
// (the settings PUT / onboarding finish must answer 200 regardless).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { sweepSpy } = vi.hoisted(() => ({ sweepSpy: vi.fn<() => number>() }));

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({ get: () => undefined, set: vi.fn(), getAll: () => ({}) }),
  shareRepo: () => ({ listAll: () => [], getById: () => undefined }),
  fileRepo: () => ({}),
  jobRepo: () => ({ listActive: () => [], countByStatus: () => 0 }),
  blocklistRepo: () => ({}),
  getDb: () => ({ prepare: vi.fn() }),
}));

vi.mock('@/src/lib/scan/orchestrator', () => ({ runScan: vi.fn() }));
vi.mock('@/src/lib/encode/events', () => ({ engineEvents: { emit: vi.fn() } }));
vi.mock('@/src/lib/watch/mount-detect', () => ({
  readMaxUserWatches: () => 524288,
  countCurrentInotifyWatches: () => 0,
  detectMountMode: () => 'inotify' as const,
}));
vi.mock('@/src/lib/watch/watcher', () => ({
  startWatcher: vi.fn(),
  stopWatcher: vi.fn(),
  getWatcherSnapshot: () => ({ status: 'running' }),
  resetWatcherState: vi.fn(),
  setReconcileResult: vi.fn(),
  setWatcherStatusEnum: vi.fn(),
}));
vi.mock('@/src/lib/watch/reconcile', () => ({
  runBootReconcile: vi.fn(),
  startPeriodicReconcile: vi.fn(),
  stopPeriodicReconcile: vi.fn(),
  sweepPendingOrphans: sweepSpy,
}));

import { triggerAutoEncodeSweep } from '@/src/lib/watch/service';

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

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  sweepSpy.mockReset();
});

describe('triggerAutoEncodeSweep (52-04)', () => {
  it('test_trigger_when_called_then_sweeps_once', async () => {
    sweepSpy.mockReturnValue(4);
    triggerAutoEncodeSweep(makeLog() as never);
    await flush();
    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });

  it('test_trigger_when_sweep_succeeds_then_logs_enqueued_count', async () => {
    sweepSpy.mockReturnValue(4);
    const log = makeLog();
    triggerAutoEncodeSweep(log as never);
    await flush();
    expect(log.info).toHaveBeenCalledWith(
      { action: 'auto_encode_sweep_complete', enqueued: 4 },
      expect.any(String),
    );
  });

  it('test_trigger_when_sweep_throws_then_does_not_throw_synchronously', () => {
    sweepSpy.mockImplementation(() => {
      throw new Error('db locked');
    });
    expect(() => triggerAutoEncodeSweep(makeLog() as never)).not.toThrow();
  });

  it('test_trigger_when_sweep_throws_then_logs_error', async () => {
    sweepSpy.mockImplementation(() => {
      throw new Error('db locked');
    });
    const log = makeLog();
    triggerAutoEncodeSweep(log as never);
    await flush();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auto_encode_sweep_failed' }),
      expect.any(String),
    );
  });
});
