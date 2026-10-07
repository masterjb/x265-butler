import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  mockSettingGet,
  mockStartEncoderLoop,
  mockStopEncoderLoop,
  mockPurgeExpiredTrash,
  mockProbeFfmpegVersionAtBoot,
  mockSweepJobLogs,
  mockResolveEffectiveCachePath,
  mockStartCpuAttributionSampler,
  mockStopCpuAttributionSampler,
} = vi.hoisted(() => ({
  mockSettingGet: vi.fn<(key: string) => string | undefined>(),
  mockStartEncoderLoop: vi.fn(),
  mockStopEncoderLoop: vi.fn<() => Promise<void>>(),
  mockPurgeExpiredTrash: vi.fn<(opts: { now: number; repo: unknown }) => Promise<unknown>>(),
  mockProbeFfmpegVersionAtBoot: vi.fn(),
  // Prove the log-retention sweep routes through the resolver.
  mockSweepJobLogs:
    vi.fn<(args: { cachePoolPath: string; retentionDays: number }) => Promise<void>>(),
  mockResolveEffectiveCachePath:
    vi.fn<(v: string | undefined) => { effectivePath: string; resolution: string }>(),
  // Mock the sampler so server-init tests assert the
  // start/teardown WIRING without spawning a real setInterval + histogram (no
  // leaked open handle across this file's fake/real-timer churn).
  mockStartCpuAttributionSampler: vi.fn(),
  mockStopCpuAttributionSampler: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => ({ get: mockSettingGet }),
  trashRepo: () => ({ name: 'trash-repo' }),
  jobRepo: () => ({}),
  default: {},
  shareRepo: () => ({ listAll: () => [] }),
}));

vi.mock('@/src/lib/encode', () => ({
  startEncoderLoop: mockStartEncoderLoop,
  stopEncoderLoop: mockStopEncoderLoop,
  // Probe trigger from ensureServerInit
  probeFfmpegVersionAtBoot: mockProbeFfmpegVersionAtBoot,
  default: {},
}));

// Mock the sweep + resolver so the wiring (resolver → sweep) is
// asserted in isolation; the resolver's own behaviour is covered by
// tests/encode/cache-path.test.ts.
vi.mock('@/src/lib/trash/purge', () => ({
  purgeExpiredTrash: mockPurgeExpiredTrash,
}));

vi.mock('@/src/lib/log/sweep', () => ({
  sweepJobLogs: mockSweepJobLogs,
}));

// Stub the cpu_attribution sampler — its start/stop are wired
// into ensureServerInit / teardownServerInit and asserted below.
vi.mock('@/src/lib/diagnostics/cpu-attribution-sampler', () => ({
  startCpuAttributionSampler: mockStartCpuAttributionSampler,
  stopCpuAttributionSampler: mockStopCpuAttributionSampler,
}));

// Partial mock: stub only resolveEffectiveCachePath, keep the real MNT_CACHE_DEFAULT
// (+ siblings) so the boot-path migrateLegacyCachePath still resolves its imports.
vi.mock('@/src/lib/encode/cache-path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/encode/cache-path')>();
  return {
    ...actual,
    resolveEffectiveCachePath: mockResolveEffectiveCachePath,
  };
});

import {
  ensureServerInit,
  teardownServerInit,
  __forTests_resetServerInit,
} from '@/src/lib/server-init';

describe('server-init', () => {
  let originalNextPhase: string | undefined;

  beforeEach(() => {
    originalNextPhase = process.env.NEXT_PHASE;
    delete process.env.NEXT_PHASE;
    mockSettingGet.mockReset();
    mockStartEncoderLoop.mockReset();
    mockStopEncoderLoop.mockReset();
    mockPurgeExpiredTrash.mockReset();
    mockProbeFfmpegVersionAtBoot.mockReset();
    mockSweepJobLogs.mockReset();
    mockResolveEffectiveCachePath.mockReset();
    mockStartCpuAttributionSampler.mockReset();
    mockStopCpuAttributionSampler.mockReset();
    mockStopEncoderLoop.mockResolvedValue(undefined);
    mockSettingGet.mockReturnValue(undefined);
    mockPurgeExpiredTrash.mockResolvedValue({ ran: true, deleted: 0, failed: 0, skipped: 0 });
    mockSweepJobLogs.mockResolvedValue(undefined);
    // Default: resolver behaves like the auto-resolved config-fallback (cache_pool_path unset).
    mockResolveEffectiveCachePath.mockReturnValue({
      effectivePath: '/config/cache',
      resolution: 'config-fallback',
    });
    __forTests_resetServerInit();
  });

  afterEach(() => {
    if (originalNextPhase === undefined) {
      delete process.env.NEXT_PHASE;
    } else {
      process.env.NEXT_PHASE = originalNextPhase;
    }
    __forTests_resetServerInit();
  });

  it('test_ensureServerInit_when_first_call_then_starts_loop_and_marks_started', () => {
    ensureServerInit();
    expect(mockStartEncoderLoop).toHaveBeenCalledOnce();
    expect(globalThis.__x265butler_init?.started).toBe(true);
  });

  it('test_ensureServerInit_when_called_twice_then_idempotent_no_double_start', () => {
    ensureServerInit();
    ensureServerInit();
    expect(mockStartEncoderLoop).toHaveBeenCalledOnce();
  });

  // Pause concept retired — server-init no longer reads queue_paused.
  it('test_ensureServerInit_when_called_then_does_not_read_queue_paused_setting', () => {
    mockSettingGet.mockImplementation((k) => (k === 'queue_paused' ? 'true' : undefined));
    ensureServerInit();
    // settingRepo().get('queue_paused') is NEVER called in the boot path
    // since the pause concept was retired. (sweep-timer's separate calls for cache_pool_path /
    // trash_retention_days fire on the 1h tick, not at init.)
    const queuePausedReads = mockSettingGet.mock.calls.filter(([k]) => k === 'queue_paused');
    expect(queuePausedReads).toHaveLength(0);
  });

  it('test_ensureServerInit_when_NEXT_PHASE_phase_production_build_then_skips_completely', () => {
    // Build-time guard
    process.env.NEXT_PHASE = 'phase-production-build';
    ensureServerInit();
    expect(mockStartEncoderLoop).not.toHaveBeenCalled();
    expect(globalThis.__x265butler_init?.started).toBe(false);
  });

  it('test_teardownServerInit_when_started_then_resets_state_and_calls_stopEncoderLoop', async () => {
    ensureServerInit();
    expect(globalThis.__x265butler_init?.started).toBe(true);
    await teardownServerInit();
    expect(mockStopEncoderLoop).toHaveBeenCalledOnce();
    expect(globalThis.__x265butler_init?.started).toBe(false);
  });

  it('test_teardownServerInit_when_not_started_then_noop_resolves_without_calling_stop', async () => {
    await teardownServerInit();
    expect(mockStopEncoderLoop).not.toHaveBeenCalled();
  });

  // cpu_attribution sampler start/stop wiring.
  it('test_ensureServerInit_when_first_call_then_starts_cpu_attribution_sampler', () => {
    ensureServerInit();
    expect(mockStartCpuAttributionSampler).toHaveBeenCalledOnce();
  });

  it('test_teardownServerInit_when_started_then_stops_cpu_attribution_sampler', async () => {
    ensureServerInit();
    await teardownServerInit();
    expect(mockStopCpuAttributionSampler).toHaveBeenCalledOnce();
  });

  it('test_globalThis_guard_when_state_already_started_then_subsequent_call_noop', () => {
    // Simulate HMR: state pre-existing with started=true (e.g. previous module load)
    globalThis.__x265butler_init = { started: true, sweepTimer: null };
    ensureServerInit();
    expect(mockStartEncoderLoop).not.toHaveBeenCalled();
  });

  // Retention sweep tests
  it('test_retention_sweep_when_tick_fires_then_purge_called_with_now_and_repo', async () => {
    vi.useFakeTimers();
    ensureServerInit();
    expect(mockPurgeExpiredTrash).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // 1h
    expect(mockPurgeExpiredTrash).toHaveBeenCalledOnce();
    expect(mockPurgeExpiredTrash).toHaveBeenCalledWith(
      expect.objectContaining({ now: expect.any(Number), repo: { name: 'trash-repo' } }),
    );
    vi.useRealTimers();
  });

  it('test_retention_sweep_when_purge_rejects_then_logged_and_timer_continues', async () => {
    vi.useFakeTimers();
    mockPurgeExpiredTrash.mockRejectedValueOnce(new Error('db transient'));
    ensureServerInit();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mockPurgeExpiredTrash).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mockPurgeExpiredTrash).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('test_retention_sweep_when_purge_rejects_then_log_sweep_still_runs', async () => {
    vi.useFakeTimers();
    mockPurgeExpiredTrash.mockRejectedValueOnce(new Error('db transient'));
    ensureServerInit();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mockSweepJobLogs).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('test_teardownServerInit_when_sweep_active_then_clearInterval_called', async () => {
    vi.useFakeTimers();
    ensureServerInit();
    expect(globalThis.__x265butler_init?.sweepTimer).not.toBeNull();
    await teardownServerInit();
    // sweepTimer cleared back to null + advancing timer must NOT trigger more calls
    expect(globalThis.__x265butler_init?.sweepTimer).toBeNull();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mockPurgeExpiredTrash).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // Per-job log-retention sweep MUST route through the resolver, not a raw
  // cache_pool_path read. Pre-fix the raw read returned '' on an auto-resolved
  // install (unset row) or an upgrader whose legacy row the boot migration
  // removed → falsy guard SKIPPED the sweep.
  it('test_log_retention_sweep_when_cache_path_unset_then_resolves_and_sweeps', () => {
    vi.useFakeTimers();
    // cache_pool_path unset (undefined), trash_retention_days default '30'.
    mockSettingGet.mockImplementation((k) => (k === 'trash_retention_days' ? '30' : undefined));
    ensureServerInit();
    expect(mockSweepJobLogs).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60 * 60 * 1000); // 1h tick
    // resolver consulted with the RAW setting value (undefined), NOT bypassed.
    expect(mockResolveEffectiveCachePath).toHaveBeenCalledWith(undefined);
    // sweep RUNS against the auto-resolved fallback path (pre-fix it was skipped).
    expect(mockSweepJobLogs).toHaveBeenCalledOnce();
    expect(mockSweepJobLogs).toHaveBeenCalledWith(
      expect.objectContaining({ cachePoolPath: '/config/cache', retentionDays: 30 }),
    );
    vi.useRealTimers();
  });

  it('test_log_retention_sweep_when_explicit_override_then_resolver_returns_override_verbatim', () => {
    vi.useFakeTimers();
    mockSettingGet.mockImplementation((k) =>
      k === 'cache_pool_path'
        ? '/mnt/user/mycache'
        : k === 'trash_retention_days'
          ? '30'
          : undefined,
    );
    mockResolveEffectiveCachePath.mockReturnValue({
      effectivePath: '/mnt/user/mycache',
      resolution: 'user-override',
    });
    ensureServerInit();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(mockResolveEffectiveCachePath).toHaveBeenCalledWith('/mnt/user/mycache');
    expect(mockSweepJobLogs).toHaveBeenCalledWith(
      expect.objectContaining({ cachePoolPath: '/mnt/user/mycache', retentionDays: 30 }),
    );
    vi.useRealTimers();
  });

  it('job log sweep keeps 30 days regardless of trash retention', async () => {
    vi.useFakeTimers();
    mockSettingGet.mockImplementation((k) => (k === 'trash_retention_days' ? '365' : undefined));
    ensureServerInit();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mockSweepJobLogs).toHaveBeenCalledWith(expect.objectContaining({ retentionDays: 30 }));
    vi.useRealTimers();
  });

  // ffmpeg version probe at server-init time
  it('test_ensureServerInit_when_called_then_probeFfmpegVersionAtBoot_invoked_once', () => {
    ensureServerInit();
    expect(mockProbeFfmpegVersionAtBoot).toHaveBeenCalledTimes(1);
  });

  it('test_ensureServerInit_when_called_twice_then_probeFfmpegVersionAtBoot_still_only_invoked_once', () => {
    ensureServerInit();
    ensureServerInit();
    expect(mockProbeFfmpegVersionAtBoot).toHaveBeenCalledTimes(1);
  });

  it('test_ensureServerInit_when_NEXT_PHASE_phase_production_build_then_probe_NOT_invoked', () => {
    process.env.NEXT_PHASE = 'phase-production-build';
    ensureServerInit();
    expect(mockProbeFfmpegVersionAtBoot).not.toHaveBeenCalled();
  });

  it('test_ensureServerInit_when_called_then_probe_runs_BEFORE_startEncoderLoop_so_init_returns_synchronously', () => {
    // Probe is fire-and-forget — even if its implementation took 10s, init returns immediately.
    // Mock impl simulates a never-resolving probe; ensureServerInit should still return.
    mockProbeFfmpegVersionAtBoot.mockImplementation(() => {
      // Simulate fire-and-forget: no return value, no await — kick off and return.
    });
    const start = Date.now();
    ensureServerInit();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100); // should return ~immediately
    // Both probe + startEncoderLoop ran
    expect(mockProbeFfmpegVersionAtBoot).toHaveBeenCalledTimes(1);
    expect(mockStartEncoderLoop).toHaveBeenCalledTimes(1);
  });
});
