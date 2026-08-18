// 48-02 (Bundle C): windowed collapse of the `auto_scan_watch_error` WARN.
//
// WHY: `onWatcherError` logged EVERY non-ENOSPC chokidar error at WARN,
// unthrottled. Reporter R2's share root enclosed `/`, so chokidar produced one
// EACCES per `/sys` path — a log flood that emptied the SHARED 1000-line ring
// buffer and destroyed the very diagnostic evidence the copy-report exists to
// carry. Bundle B stops that particular storm at the source; C makes the log
// path survive ANY storm, including ones we have not seen yet.
//
// Contract:
//   - the FIRST error of a window is reported to the caller as 'emit' — the
//     caller logs the existing `auto_scan_watch_error` WARN with its UNCHANGED
//     shape, so existing greps and tests keep working.
//   - every later error of the same window is 'suppressed' (counted, not logged).
//   - at window close, if more than one error was observed, ONE summary WARN
//     `auto_scan_watch_error_summary` carries windowMs, count, byCode and
//     ≤ WATCH_ERROR_SAMPLE_CAP raw messages. If exactly one was observed the
//     immediate line already told the whole story and NOTHING more is logged.
//
// ESCALATION (audit S4): a PERMANENT storm is the reporter's actual case — a
// bad share root does not fix itself. At a fixed 60 s window that still costs
// 2 lines/60 s ≈ 2880/day against a 1000-line ring, i.e. C would only SLOW the
// eviction it exists to prevent. So every window that closes non-empty doubles
// the next one (60s → 120 → 240 → 480 → 900 cap) and re-arms; the first window
// that closes EMPTY resets to the base and stops re-arming, so the next
// isolated error is reported immediately again. Steady-state cost under a
// permanent storm: ≤ 2 lines per 15 minutes.
//
// The emit/suppress DECISION never depends on Date.now() ordering — the window
// boundary is the timer firing. Tests drive it with vi.useFakeTimers().
//
// SCOPE: the aggregator is process-GLOBAL. The main inotify instance and every
// forced-polling instance funnel into `onWatcherError` with no share
// attribution, exactly as the existing `auto_scan_watch_error` line does.
// Per-share windows are deliberately NOT introduced — that would claim a
// granularity chokidar's error objects do not carry.

export const WATCH_ERROR_WINDOW_MS = 60_000;
export const WATCH_ERROR_WINDOW_MAX_MS = 900_000;
export const WATCH_ERROR_SAMPLE_CAP = 5;

export type WatchErrorInput = { message: string; code?: string };

type WarnLogger = { warn: (obj: Record<string, unknown>, msg: string) => void };

let timer: NodeJS.Timeout | null = null;
let count = 0;
let byCode: Record<string, number> = {};
let samples: string[] = [];
let currentWindowMs: number = WATCH_ERROR_WINDOW_MS;

function openWindow(log: WarnLogger): void {
  const windowMs = currentWindowMs;
  timer = setTimeout(() => closeWindow(windowMs, log), windowMs);
  // Never keep the Node process alive for a diagnostics window (AC-12).
  timer.unref?.();
}

function closeWindow(windowMs: number, log: WarnLogger): void {
  const observed = count;
  const observedByCode = byCode;
  const observedSamples = samples;
  timer = null;
  count = 0;
  byCode = {};
  samples = [];

  if (observed > 1) {
    log.warn(
      {
        action: 'auto_scan_watch_error_summary',
        windowMs,
        // TOTAL errors observed in the window, INCLUDING the one that was
        // logged immediately — so `count` reads as "how bad was it", not as a
        // remainder the reader has to add back.
        count: observed,
        byCode: observedByCode,
        samples: observedSamples,
      },
      'watcher error storm suppressed',
    );
  }

  if (observed > 0) {
    // Non-empty close → escalate and re-arm an EMPTY window. The re-armed
    // window is what makes a quiet close observable at all (a window can only
    // be opened by an error, so without the re-arm `observed === 0` would be
    // unreachable and the escalation could never reset).
    currentWindowMs = Math.min(currentWindowMs * 2, WATCH_ERROR_WINDOW_MAX_MS);
    openWindow(log);
  } else {
    currentWindowMs = WATCH_ERROR_WINDOW_MS;
  }
}

/**
 * Record one non-ENOSPC watcher error.
 *
 * @returns 'emit' when the CALLER should log the immediate
 *          `auto_scan_watch_error` WARN (first error of the window),
 *          'suppressed' otherwise.
 */
export function recordWatchError(err: WatchErrorInput, log: WarnLogger): 'emit' | 'suppressed' {
  count++;
  const key = err.code ?? 'unknown';
  byCode[key] = (byCode[key] ?? 0) + 1;
  if (samples.length < WATCH_ERROR_SAMPLE_CAP) samples.push(err.message);

  if (timer === null) {
    openWindow(log);
    return 'emit';
  }
  // A re-armed window that has not seen an error yet still reports its first
  // one immediately — same rule, no special case.
  return count === 1 ? 'emit' : 'suppressed';
}

/**
 * Clear the pending window timer, drop the buffered counters and reset the
 * escalation state. Called from stopWatcher() and resetWatcherState() so a
 * torn-down watcher can never fire a summary for a previous life (AC-12).
 */
export function resetWatchErrorAggregator(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  count = 0;
  byCode = {};
  samples = [];
  currentWindowMs = WATCH_ERROR_WINDOW_MS;
}

/** Test-only introspection — production code never calls this. */
export function __forTests_getWatchErrorAggregatorState(): {
  windowOpen: boolean;
  count: number;
  currentWindowMs: number;
} {
  return { windowOpen: timer !== null, count, currentWindowMs };
}
