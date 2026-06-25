// 02-03: HMR-safe singleton bootstrap.
//
// Called from the top of every Route Handler that needs the encoder loop running.
// The boolean check is cheap (one property read on globalThis); the real work runs
// exactly once per process, surviving Next.js dev hot-reload via `globalThis`
// (declared in src/lib/global-runtime-state.d.ts — audit S5).
//
// 05-09: Pause concept retired — boot path no longer reads queue_paused
// setting nor calls setPaused. Skip / Cancel-All-Queued operate via in-memory
// _activeControllers abort, not via a persisted pause flag.

import { logger } from './logger';
import { settingRepo, trashRepo, jobRepo, benchRunRepo } from './db';
import { startEncoderLoop, stopEncoderLoop, probeFfmpegVersionAtBoot } from './encode';
import { sweepJobLogs } from './log/sweep';
// ISS-001: the per-job log-retention sweep MUST resolve the cache path the same
// way dispatch does. A raw `settingRepo().get('cache_pool_path')` returns '' on
// any DC-B install (unset row) or on an upgrader migrated off the legacy
// /mnt/cache default in 36-03 → the old falsy-guard silently skipped the sweep.
// Pure (uncached) resolver is correct here: dispatch-equivalent, fresh-per-tick,
// honours a late-mounting /mnt/cache; the 1h sweep cadence makes the per-call
// /mnt/cache write-probe negligible (no probe-storm — unlike the 60s read
// surfaces that use the Cached variant).
import { resolveEffectiveCachePath } from './encode/cache-path';
// 16-01 T4: auto-scan watcher service. Fire-and-forget start; teardown awaits
// chokidar .close() BEFORE stopping the encoder loop so no event flushes mid-shutdown.
import { startWatcherService, stopWatcherService } from './watch';
import { migrateLegacyCachePath } from './db/migrate-legacy-cache-path';
// 40-01: headless CPU + event-loop-lag attribution sampler. Fire-safe start
// right after the encoder loop; torn down alongside the sweep timer.
import {
  startCpuAttributionSampler,
  stopCpuAttributionSampler,
} from './diagnostics/cpu-attribution-sampler';

// audit-added M2 / S4 / D10 lookup: 02-03 retention-sweep configuration.
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1h
const SWEEP_BATCH_SIZE = 1000;
const SWEEP_MAX_BATCHES_PER_TICK = 10; // 10 × 1000 = 10k row max per tick

// Always read globalThis fresh — supports HMR (module re-import keeps the
// existing state) AND test isolation (__forTests_resetServerInit can replace
// the global without leaving a stale closure ref behind).
function getState(): { started: boolean; sweepTimer: NodeJS.Timeout | null } {
  return (globalThis.__x265butler_init ??= { started: false, sweepTimer: null });
}

export function ensureServerInit(): void {
  const state = getState();
  if (state.started) return;

  // audit-added S2 (02-03): never spawn the encoder loop during `next build` static
  // analysis. Next.js may invoke Route Handler modules at build time for route
  // discovery; spawning ffmpeg + acquiring DB write locks would break CI.
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    logger.debug({ action: 'server_init_skipped', reason: 'next_build_phase' });
    return;
  }

  state.started = true;

  logger.info({ action: 'server_init' }, 'server init complete');

  // 36-03 (b2): one-time-safe deletion of the Pre-24-03 legacy default
  // cache_pool_path row so upgraders fall to DC-B auto-resolve (avoids
  // cache_pool_unavailable:EACCES on hosts without the CA-template /mnt/cache map).
  try {
    migrateLegacyCachePath(settingRepo(), logger);
  } catch (err) {
    logger.error(
      {
        action: 'legacy_cache_path_migrate_failed',
        err: err instanceof Error ? err.stack : String(err),
      },
      'legacy cache_pool_path migration threw — continuing boot',
    );
  }

  // 03-04 audit M3: probe ffmpeg version at server-init time (NOT lazily on
  // first /api/stats — eliminates 5s blocking on first dashboard load).
  // Fire-and-forget — does NOT block init flow.
  probeFfmpegVersionAtBoot();

  // 11-01: recover any bench_runs stuck in 'running' from a prior crash
  try {
    const recovered = benchRunRepo().resetStuckRunningToFailed();
    if (recovered > 0) {
      logger.warn(
        { action: 'bench_boot_recovery', recovered },
        'bench runs stuck running reset to failed',
      );
    }
  } catch {
    // non-fatal — bench infra not critical to encoder startup
  }

  startEncoderLoop();

  // 40-01: start the headless cpu_attribution sampler (no-op when
  // CPU_ATTRIBUTION_DISABLED=1; idempotent). try/catch so a sampler-start
  // failure never aborts boot.
  try {
    startCpuAttributionSampler();
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.stack : String(err),
        action: 'cpu_attribution_start_failed',
      },
      'cpu_attribution sampler start threw — continuing boot',
    );
  }

  // 16-01 T4: auto-scan watcher boot — fire-and-forget so a slow share-walk
  // or chokidar bind does NOT block route handler responsiveness. Failures
  // are logged inside the service; HTTP routes stay live regardless.
  startWatcherService(logger).catch((err) => {
    logger.error(
      { err: err instanceof Error ? err.stack : String(err), action: 'auto_scan_start_failed' },
      'auto-scan startWatcherService threw — service stays stopped',
    );
  });

  // 02-03 Task 3: retention sweep — every 1h, batched 10×1000 rows max per tick
  // (matches 02-01 S4 bounded delete). Try/catch keeps the timer alive across
  // transient DB errors (sweep retries on the next tick).
  state.sweepTimer = setInterval(() => {
    try {
      const now = Math.floor(Date.now() / 1000);
      let total = 0;
      for (let i = 0; i < SWEEP_MAX_BATCHES_PER_TICK; i++) {
        const deleted = trashRepo().deleteExpired(now, SWEEP_BATCH_SIZE);
        total += deleted;
        if (deleted < SWEEP_BATCH_SIZE) break;
      }
      if (total > 0) {
        logger.info({ action: 'retention_sweep', deleted: total }, 'retention sweep complete');
      }
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.stack : String(err) },
        'retention sweep failed (timer continues)',
      );
    }
    // 05-03 T1.E: per-job log retention sweep. Independent from trash sweep —
    // try/catch each so one failure does not abort the other.
    void (async () => {
      try {
        // ISS-001: route through the resolver (NOT a raw read) so retention runs
        // against the auto-resolved path when no explicit override is set.
        const { effectivePath: cachePoolPath } = resolveEffectiveCachePath(
          settingRepo().get('cache_pool_path'),
        );
        const retentionDaysRaw = settingRepo().get('trash_retention_days') ?? '30';
        const retentionDays = parseInt(retentionDaysRaw, 10);
        if (cachePoolPath && Number.isFinite(retentionDays) && retentionDays > 0) {
          await sweepJobLogs({
            cachePoolPath,
            retentionDays,
            jobRepo: jobRepo(),
          });
        }
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.stack : String(err) },
          'log retention sweep failed (timer continues)',
        );
      }
    })();
  }, SWEEP_INTERVAL_MS);
}

export async function teardownServerInit(): Promise<void> {
  const state = getState();
  if (!state.started) return;
  if (state.sweepTimer) {
    clearInterval(state.sweepTimer);
    state.sweepTimer = null;
  }
  // 40-01: stop the cpu_attribution sampler on the SAME teardown path prod +
  // tests share (audit S2) — no leaked open-handle setInterval.
  stopCpuAttributionSampler();
  state.started = false;
  // 16-01 T4: stop the watcher BEFORE the encoder loop so any in-flight
  // flushBatch can complete (or cancel) before encoder shutdown drains slots.
  await stopWatcherService();
  await stopEncoderLoop();
  logger.info({ action: 'server_teardown' }, 'server teardown complete');
}

// Test-only — reset the global guard so test runs are isolated.
export function __forTests_resetServerInit(): void {
  const state = globalThis.__x265butler_init;
  if (state?.sweepTimer) {
    clearInterval(state.sweepTimer);
  }
  globalThis.__x265butler_init = { started: false, sweepTimer: null };
}
