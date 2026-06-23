// Phase 38 Plan 38-01 — OS scheduler priority (niceness) for spawned ffmpeg children.
//
// Operator report (2026-06-23, forum): UI "very sluggish… pages take a very long
// time to load… sometimes the loading process even crashes" at 3 concurrent
// encodes — but the encodes keep running. Engine healthy; the defect is web-tier
// responsiveness under encode load. ffmpeg/x265 thread pools run at the SAME
// scheduler priority as the Node web server → the interactive process gets no
// timeslice → SSR handlers stall. Lowering the encode niceness (default 19 = run
// only on otherwise-idle CPU) lets the Node UI always win the scheduler while the
// encode still uses full CPU when the UI is idle. This is what Tdarr / Unmanic do.
//
// LOAD-BEARING ASSUMPTION (AC-5, unprovable by unit — confirmed only on real HW):
// Linux niceness is a PER-TASK attribute. os.setPriority(pid) reniices ONLY the
// ffmpeg MAIN thread. x265 worker thread-pools inherit the lowered niceness ONLY
// IF they are created AFTER the setPriority call — which is why reniceChild runs
// synchronously on the line immediately after spawn, BEFORE listener wiring (win
// the inheritance race as early as JS allows). The units here prove setPriority
// was CALLED, NOT that the workers yielded. Operator post-ship check is the only
// real efficacy proof: `ps -eLo pid,tid,ni,comm | grep -Ei 'ffmpeg|x265'` — every
// worker row's NI must read 19 (or the ENCODE_NICE override).
//
// DEGRADED MODE (AC-6): a host where EVERY setPriority EPERMs reverts to the EXACT
// Node-priority starvation this plan fixes. Warn-once trims log VOLUME but the
// single warn payload is reconstruction-sufficient (action + err.message +
// resolvedNice), and isEncodeNiceDegraded() exposes the state for a future
// /api/diagnostics wire-up (named deferred follow-up — this is a backend-only plan).

import os from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { logger as defaultLogger } from '../logger';

type PriorityLogger = Pick<typeof defaultLogger, 'info' | 'warn'>;

// Default niceness: encodes run only on otherwise-idle CPU so the Node web UI
// always wins the scheduler. Valid operator override range is the POSIX nice
// range -20..19 (negatives RAISE priority — escape-hatch only).
const DEFAULT_ENCODE_NICE = 19;
const NICE_MIN = -20;
const NICE_MAX = 19;

let _encodeNiceCache: number | undefined; // undefined = not yet resolved
let _invalidWarned = false; // warn-once: invalid ENCODE_NICE value
let _setPriorityWarned = false; // warn-once: setPriority failure
let _encodeNiceDegraded = false; // sticky: any setPriority failure flips this true

/**
 * Memoized module-load resolver for the encode niceness. Reads ENCODE_NICE ONCE,
 * caches the result. Pattern mirrors the X265_POOLS resolver (profiles.ts).
 *  - unset / empty → DEFAULT (no warn — absence is normal).
 *  - valid integer in -20..19 → used verbatim.
 *  - non-integer / float / out-of-range / junk → DEFAULT + one log.warn.
 * Reject-to-default, NOT clamp (a typo'd 190 should surface, not silently become 19).
 */
export function resolveEncodeNice(log: PriorityLogger = defaultLogger): number {
  if (_encodeNiceCache !== undefined) return _encodeNiceCache;

  const raw = process.env.ENCODE_NICE;
  const trimmed = (raw ?? '').trim();

  if (trimmed === '') {
    _encodeNiceCache = DEFAULT_ENCODE_NICE;
    log.info(
      { action: 'encode_nice_resolved', resolvedNice: _encodeNiceCache, source: 'default' },
      'encode-nice: ffmpeg child niceness resolved',
    );
    return _encodeNiceCache;
  }

  const n = Number(trimmed);
  if (Number.isInteger(n) && n >= NICE_MIN && n <= NICE_MAX) {
    _encodeNiceCache = n;
    log.info(
      { action: 'encode_nice_resolved', resolvedNice: _encodeNiceCache, source: 'env' },
      'encode-nice: ffmpeg child niceness resolved',
    );
    return _encodeNiceCache;
  }

  // Invalid → reject to default + warn ONCE.
  _encodeNiceCache = DEFAULT_ENCODE_NICE;
  if (!_invalidWarned) {
    _invalidWarned = true;
    log.warn(
      { action: 'encode_nice_invalid', raw, resolvedNice: _encodeNiceCache },
      'encode-nice: ENCODE_NICE invalid (non-integer / out of -20..19) — falling back to default 19',
    );
  }
  log.info(
    { action: 'encode_nice_resolved', resolvedNice: _encodeNiceCache, source: 'default' },
    'encode-nice: ffmpeg child niceness resolved',
  );
  return _encodeNiceCache;
}

/**
 * Lower (or raise) the OS scheduler priority of a freshly-spawned ffmpeg child.
 * Soft-degrading: NEVER throws to the caller — a setPriority failure (EPERM on an
 * exotic host, ESRCH if the child already exited) MUST NOT abort the encode. The
 * child simply continues at its inherited priority.
 *
 * Call on the line immediately AFTER spawn, BEFORE listener wiring, NOT awaited.
 */
export function reniceChild(child: ChildProcess, log: PriorityLogger = defaultLogger): void {
  if (child.pid == null) return; // spawn failed — nothing to renice.
  const nice = resolveEncodeNice(log);
  try {
    os.setPriority(child.pid, nice);
  } catch (err) {
    _encodeNiceDegraded = true;
    if (!_setPriorityWarned) {
      _setPriorityWarned = true;
      // Reconstruction-sufficient single line (AC-6): a post-incident reader sees
      // from this one warn that renice was failing → the UI-starvation fix was
      // silently inert on this host.
      log.warn(
        {
          action: 'encode_nice_setpriority_failed',
          err: err instanceof Error ? err.message : String(err),
          resolvedNice: nice,
        },
        'encode-nice: os.setPriority failed — ffmpeg child runs at inherited priority (UI may starve under load)',
      );
    }
  }
}

/**
 * True once any setPriority call has failed this process. Sticky — exposes the
 * renice-degraded mode so a future /api/diagnostics wire-up (deferred follow-up)
 * can surface that the starvation fix is inert. NOT cleared on a later success.
 */
export function isEncodeNiceDegraded(): boolean {
  return _encodeNiceDegraded;
}

// Test-only — clear the memo + warn-once + degraded flags (never barrel-exported).
export function __forTests_resetEncodeNice(): void {
  _encodeNiceCache = undefined;
  _invalidWarned = false;
  _setPriorityWarned = false;
  _encodeNiceDegraded = false;
}
