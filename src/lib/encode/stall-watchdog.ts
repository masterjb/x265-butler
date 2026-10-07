// Detects an encode that stopped making progress. ffmpeg reports its output
// position (`out_time`) every 30 seconds; when that position has not grown for
// the configured time, the watchdog reports once and the caller stops ffmpeg.
//
// The check runs on its own timer instead of on progress events, so an ffmpeg
// that stops writing anything at all is caught as well. The reference time
// starts when the watchdog is created, which covers a hang before the first
// frame.

import { logger as defaultLogger, type AppLogger } from '@/src/lib/logger';

type IntervalHandle = unknown;

export interface StallWatchdogOptions {
  timeoutMs: number;
  onStall: () => void;
  checkEveryMs?: number;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => IntervalHandle;
  clearInterval?: (handle: IntervalHandle) => void;
}

export interface StallWatchdog {
  /** Feed the latest output position in milliseconds (null when ffmpeg had none). */
  observe(outTimeMs: number | null): void;
  stop(): void;
}

const MAX_CHECK_EVERY_MS = 30_000;

export function createStallWatchdog(opts: StallWatchdogOptions): StallWatchdog {
  if (!(opts.timeoutMs > 0)) {
    return { observe: () => {}, stop: () => {} };
  }

  const now = opts.now ?? Date.now;
  const setTimer = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer =
    opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const checkEveryMs =
    opts.checkEveryMs ?? Math.min(MAX_CHECK_EVERY_MS, Math.max(1, opts.timeoutMs / 4));

  let lastAdvanceAt = now();
  let maxOutTimeMs = -Infinity;
  let handle: IntervalHandle | null = null;

  const stop = (): void => {
    if (handle !== null) {
      clearTimer(handle);
      handle = null;
    }
  };

  handle = setTimer(() => {
    if (now() - lastAdvanceAt >= opts.timeoutMs) {
      stop();
      opts.onStall();
    }
  }, checkEveryMs);

  return {
    observe(outTimeMs) {
      if (outTimeMs === null || !(outTimeMs > maxOutTimeMs)) return;
      maxOutTimeMs = outTimeMs;
      lastAdvanceAt = now();
    },
    stop,
  };
}

/**
 * ENCODE_STALL_DETECTION_DISABLED. Kill switch convention of the repo: only `1`
 * turns the detection off; unset, `0`, `true` or anything else leaves it on.
 */
export function resolveStallDetectionEnabled(raw: string | undefined): boolean {
  return (raw ?? '').trim() !== '1';
}

let _enabledCache: boolean | undefined;

/** Memoized; flipping the variable needs a container restart. */
export function stallDetectionEnabled(log: AppLogger = defaultLogger): boolean {
  if (_enabledCache === undefined) {
    const raw = process.env.ENCODE_STALL_DETECTION_DISABLED;
    _enabledCache = resolveStallDetectionEnabled(raw);
    log.info(
      { action: 'stall_detection_resolved', enabled: _enabledCache, envRaw: raw ?? null },
      'stall detection resolved',
    );
  }
  return _enabledCache;
}

export function __forTests_resetStallDetectionCache(): void {
  _enabledCache = undefined;
}
