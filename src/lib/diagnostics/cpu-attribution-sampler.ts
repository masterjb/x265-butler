// 40-01: headless CPU + event-loop-lag attribution sampler.
//
// Purpose: localize WHERE the single-process next-server core is burned during
// concurrent encodes — with the browser closed. A server-side setInterval reads
// perf_hooks.monitorEventLoopDelay (event-loop BLOCKING) + process.cpuUsage()
// delta (per-core CPU%) each tick and emits a `cpu_attribution` pino event into
// the ring-buffer (which already fans out to /api/diagnostics + copy-report).
// High lag ⇒ JS / sync-SQLite on the loop; low lag + high CPU ⇒ off-loop burn
// (pipe-read / native addon / GC / threadpool). This is the missing measurement
// that drives the data-driven fix in 40-02.
//
// 40-01 audit-grounded invariants:
//  - Emit level ≥ info (info default / warn when p99 > threshold) so it survives
//    the `LOG_LEVEL ?? 'info'` instance gate → ring-buffer writer (AC-3). NEVER
//    `debug` — that is the precise 22-01→38-02 dark-surface bug.
//  - Default interval 15s (NOT 5s): the 1000-line ring is shared by ALL evidence;
//    15s = 240 lines/h → a 1000-line ring holds ~4 h of samples interleaved with
//    slow_query/slow_request/recentErrors (AC-8 ring-budget). 5s = 720 lines/h →
//    ring goes all-sampler in ~83 min, evicting the other diagnostic evidence.
//  - process.cpuUsage() is process-AGGREGATE (main thread + libuv pool + V8 GC +
//    native addons) → it discriminates main-loop-vs-off-loop ONLY, NOT a specific
//    offender (AC-10). 40-02 narrows per-thread.
//  - HMR-safe `globalThis` singleton handle (NOT module-level) + idempotent
//    double-start guard → no leaked setInterval / double emit on a Next.js HMR
//    module re-import (audit S1).
//  - The per-tick `jobRepo().listActive()` is itself a sync better-sqlite3 query
//    on the loop — the instrument adds the very class of work it measures. At
//    ≥15s this is negligible AND it is captured inside the next window's lag
//    histogram (honest, not hidden). It is the ONLY DB call per tick (audit S3).

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { logger } from '@/src/lib/logger';
import { jobRepo } from '@/src/lib/db';

// Default p99 event-loop-lag threshold (ms) above which the tick emits at WARN.
// 50ms p99 ≈ a visibly janky event loop. Operator-tunable via
// CPU_ATTRIBUTION_LAG_WARN_MS (reject-to-default, mirrors resolveSlowQueryMs).
const DEFAULT_LAG_WARN_MS = 50;

// Default sampler tick interval (ms). Raised from 5000 → 15000 per AC-8
// ring-budget (see header). Operator-tunable via CPU_ATTRIBUTION_INTERVAL_MS.
const DEFAULT_INTERVAL_MS = 15000;

// Mirror of ring-buffer MAX_LINES (ring-buffer.ts:9) — used only to log the
// flood arithmetic at resolution time (NOT imported to avoid coupling).
const RING_MAX_LINES = 1000;

let _disabledCache: boolean | undefined;
let _lagWarnMsCache: number | undefined;
let _intervalMsCache: number | undefined;

/**
 * Read the kill-switch ONCE and memoize. `=1` fully suppresses the sampler:
 * no timer, no histogram, no events, payload reverts to the empty block (AC-6).
 * Flip requires a container restart (mirrors the NEXT_PUBLIC_* / backend
 * kill-switch pattern).
 */
export function isCpuAttributionDisabled(): boolean {
  if (_disabledCache !== undefined) return _disabledCache;
  _disabledCache = process.env.CPU_ATTRIBUTION_DISABLED === '1';
  return _disabledCache;
}

/**
 * Memoized p99-lag WARN threshold. Mirrors resolveSlowQueryMs EXACTLY:
 *  - unset / empty → DEFAULT (50).
 *  - valid positive integer → used verbatim.
 *  - NaN / ≤0 / float / junk → DEFAULT. Reject-to-default, NOT clamp.
 * Logs the resolution ONCE as an audit-info event.
 */
export function resolveCpuAttributionLagMs(): number {
  if (_lagWarnMsCache !== undefined) return _lagWarnMsCache;

  const trimmed = (process.env.CPU_ATTRIBUTION_LAG_WARN_MS ?? '').trim();
  const n = Number(trimmed);
  const valid = trimmed !== '' && Number.isInteger(n) && n > 0;

  _lagWarnMsCache = valid ? n : DEFAULT_LAG_WARN_MS;
  logger.info(
    {
      action: 'cpu_attribution_lag_resolved',
      resolvedMs: _lagWarnMsCache,
      source: valid ? 'env' : 'default',
    },
    'cpu_attribution_lag_resolved',
  );
  return _lagWarnMsCache;
}

/**
 * Memoized tick interval. Same reject-to-default semantics. Logs the resolution
 * ONCE WITH the ring-budget arithmetic (lines/h + hours-to-flood of the shared
 * 1000-line ring) so a later interval change is traceable (AC-8).
 */
export function resolveCpuAttributionIntervalMs(): number {
  if (_intervalMsCache !== undefined) return _intervalMsCache;

  const trimmed = (process.env.CPU_ATTRIBUTION_INTERVAL_MS ?? '').trim();
  const n = Number(trimmed);
  const valid = trimmed !== '' && Number.isInteger(n) && n > 0;

  _intervalMsCache = valid ? n : DEFAULT_INTERVAL_MS;
  const linesPerHour = Math.round(3_600_000 / _intervalMsCache);
  const hoursToFlood = round1(RING_MAX_LINES / linesPerHour);
  logger.info(
    {
      action: 'cpu_attribution_interval_resolved',
      resolvedMs: _intervalMsCache,
      source: valid ? 'env' : 'default',
      linesPerHour,
      hoursToFlood,
      ringMaxLines: RING_MAX_LINES,
    },
    'cpu_attribution_interval_resolved',
  );
  return _intervalMsCache;
}

/**
 * Pure emit-level decision: WARN when the loop p99-lag exceeds the threshold
 * (janky), INFO otherwise. Extracted so the gate decision is unit-testable
 * deterministically (the live histogram p99 is not injectable). BOTH levels are
 * ≥ info (30) so the line survives the `LOG_LEVEL ?? 'info'` instance gate (AC-3).
 */
export function pickCpuAttributionLevel(p99Ms: number, thresholdMs: number): 'warn' | 'info' {
  return p99Ms > thresholdMs ? 'warn' : 'info';
}

interface SamplerHandle {
  timer: NodeJS.Timeout | null;
  histogram: ReturnType<typeof monitorEventLoopDelay> | null;
}

// HMR-safe singleton handle on globalThis (mirror __x265butler_init +
// ring-buffer). A module-level handle would be lost on a Next.js HMR module
// re-import while the old setInterval keeps running → a leaked timer + double
// emit (audit S1).
function getHandle(): SamplerHandle {
  return (globalThis.__x265butler_cpu_attribution_sampler ??= { timer: null, histogram: null });
}

function round1(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

function round2(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * Start the headless sampler. No-op when disabled. Idempotent: a second call
 * while a timer already exists returns WITHOUT creating a second timer/histogram
 * (two timers = double ring traffic + two histograms fighting over reset()).
 */
export function startCpuAttributionSampler(): void {
  if (isCpuAttributionDisabled()) {
    logger.info({ action: 'cpu_attribution_sampler_disabled' }, 'cpu_attribution_sampler_disabled');
    return;
  }

  const handle = getHandle();
  if (handle.timer) return; // idempotent double-start guard (audit S1)

  const lagWarnMs = resolveCpuAttributionLagMs();
  const intervalMs = resolveCpuAttributionIntervalMs();

  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  handle.histogram = h;

  // Per-core CPU% baseline — process.cpuUsage() is cumulative µs; we delta it.
  let lastCpu = process.cpuUsage();
  let lastTs = performance.now();

  handle.timer = setInterval(() => {
    // A throw inside a tick must NOT kill the timer (mirror sweepTimer).
    try {
      const nowTs = performance.now();
      const dtMs = nowTs - lastTs;
      const cpu = process.cpuUsage(lastCpu); // µs since baseline
      // µs → ms (/1000), normalized to one core over the tick interval (/dtMs).
      const cpuUserPctCore = round1((cpu.user / 1000 / dtMs) * 100);
      const cpuSysPctCore = round1((cpu.system / 1000 / dtMs) * 100);
      lastCpu = process.cpuUsage();
      lastTs = nowTs;

      // Histogram values are NANOSECONDS → /1e6 for ms. percentile(50) (NOT mean)
      // backs the eventLoopLagP50Ms field so the label is truthful. reset() so
      // each tick is a fresh window.
      const eventLoopLagP50Ms = round2(h.percentile(50) / 1e6);
      const eventLoopLagP99Ms = round2(h.percentile(99) / 1e6);
      const eventLoopLagMaxMs = round2(h.max / 1e6);
      h.reset();

      // The ONLY DB call per tick (audit S3). Guard so a DB blip → 0, not a dead
      // sampler.
      let activeEncodes = 0;
      try {
        activeEncodes = jobRepo().listActive().length;
      } catch {
        activeEncodes = 0;
      }

      const payload = {
        action: 'cpu_attribution',
        eventLoopLagP50Ms,
        eventLoopLagP99Ms,
        eventLoopLagMaxMs,
        cpuUserPctCore,
        cpuSysPctCore,
        activeEncodes,
        uptimeSec: Math.floor(process.uptime()),
      };

      // ≥ info both branches (AC-3): warn when the loop is janky, info otherwise.
      // The pino `msg` MUST be the literal 'cpu_attribution' (scanner matches it).
      if (pickCpuAttributionLevel(eventLoopLagP99Ms, lagWarnMs) === 'warn') {
        logger.warn(payload, 'cpu_attribution');
      } else {
        logger.info(payload, 'cpu_attribution');
      }
    } catch (err) {
      logger.error(
        {
          action: 'cpu_attribution_sample_failed',
          err: err instanceof Error ? err.stack : String(err),
        },
        'cpu_attribution sampler tick threw (timer continues)',
      );
    }
  }, intervalMs);

  // Never keep the process alive solely for the sampler.
  handle.timer.unref?.();
}

/**
 * Stop the sampler: clear the timer + disable the histogram. Idempotent.
 * Shared by teardownServerInit (prod shutdown) and test teardown.
 */
export function stopCpuAttributionSampler(): void {
  const handle = getHandle();
  if (handle.timer) {
    clearInterval(handle.timer);
    handle.timer = null;
  }
  if (handle.histogram) {
    handle.histogram.disable();
    handle.histogram = null;
  }
}

/**
 * Test-only: full teardown — stop any timer + disable the histogram + clear the
 * memos so a test can re-resolve under a different env. Operates on the same
 * globalThis handle so no leaked open-handle setInterval crosses test files
 * (audit S2).
 */
export function __forTests_resetCpuAttributionSampler(): void {
  stopCpuAttributionSampler();
  _disabledCache = undefined;
  _lagWarnMsCache = undefined;
  _intervalMsCache = undefined;
}
