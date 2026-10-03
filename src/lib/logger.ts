// 05-03 T1.C: pino multistream retrofit (audit S5).
// Phase 5 Plan 05-03 (Logs Viewer) — AC-5 + audit S5.
//
// Original 01-01 setup: single pino instance to stdout. Retrofit fans out
// every log line to BOTH process.stdout (preserved) AND the in-memory
// ring buffer consumed by /api/logs/container.
//
// IMPORTANT: this module is imported by Client Components (app/error.tsx,
// app/global-error.tsx). pino's package.json picks the browser shim there.
// We MUST NOT import `node:stream` here — webpack has no client polyfill.
// The ring writer is a duck-typed object matching pino.multistream's minimum
// stream contract (.write/.end/.on) so we avoid the node:stream dep entirely.
//
// audit S5 verification: tests/log/logger-multistream.test.ts asserts
// `logger.info(...)` reaches both destinations.
//
// ── 49-04: the three log tiers ────────────────────────────────────────────
// Until 49-04 there were only two useful states: "nobody records it"
// (`debug`, dropped at the instance gate BEFORE the multistream fan-out) and
// "the operator reads it in the container log" (`info`). A diagnostic line
// that wants to be RECORDED but not SHOUTED had no home. That gap produced the
// same bug three times: `slow_query` (22-01, emitted at debug → the
// /api/diagnostics surface was permanently `[]` for two phases, fixed in
// 38-02), `cpu_attribution` (40-01, put on `info` PREVENTIVELY and therefore
// spamming stdout every 15s — the N100 forum report G4) and
// `blocklist_evaluation` (22-00, dark to this day).
//
//   debug     (20) — developer trace. Neither stdout nor ring at the default
//                    LOG_LEVEL. For lines nobody but a locally-debugging
//                    developer should see.
//   telemetry (25) — diagnostic evidence. Ring YES (so /api/diagnostics and
//                    the copy-report carry it), stdout NO. The target tier for
//                    periodic telemetry.
//   info      (30) and above — the operator is meant to see it in the
//                    container log.
//
// Level wiring (all three numeric — see `assertStreamLevel`):
//   stdoutLevel   = LOG_LEVEL ?? 'info'   ('silent' → +Infinity, junk → info)
//   ringLevel     = min(25, max(20, stdoutLevel))
//   instanceLevel = min(stdoutLevel, ringLevel)
//
// Two invariants carried by that wiring:
//   1. The instance gate never blocks what a stream wants (LOG_LEVEL=trace
//      still reaches stdout).
//   2. The ring loses no line it holds today — hence the `max(20, …)` floor,
//      NOT a hard pin at 25. See `resolveRingLevel`.

import pino from 'pino';
import { pushLine } from '@/src/lib/log/ring-buffer';

/** 49-04: the diagnostic-evidence tier — quiet on stdout, recorded in the ring. */
export const TELEMETRY_LEVEL = 25;
const DEBUG_LEVEL = 20;
const INFO_LEVEL = 30;

/**
 * The ONE custom-level declaration. Both construction branches (node
 * multistream AND the browser shim fallback) use it — a second, drifting
 * options builder is how `logger.telemetry` would end up `undefined` in the
 * client bundle and crash the error page.
 */
export const LOGGER_CUSTOM_LEVELS = { telemetry: TELEMETRY_LEVEL } as const;

/**
 * Label → numeric value for every level this logger knows. `pino.levels.values`
 * exists on the browser shim too, so this is safe at module scope in the client
 * bundle. Note `'silent'` is deliberately NOT in here: pino has no numeric value
 * for it, and handing the label to a stream makes multistream compare against
 * `undefined` — byte-identical to a typo. See `resolveStdoutLevel`.
 */
export const LOGGER_LEVEL_VALUES: Record<string, number> = {
  ...pino.levels.values,
  telemetry: TELEMETRY_LEVEL,
};

export interface StdoutLevelResolution {
  /** Numeric pino level for the stdout stream. `+Infinity` means "say nothing". */
  value: number;
  /** The raw LOG_LEVEL as given, for the warning payload. */
  requested: string | undefined;
  /** True when the label was unknown and we fell back to `info`. */
  invalid: boolean;
}

/**
 * Resolve LOG_LEVEL to a NUMERIC stdout stream level.
 *
 *  - unset / empty            → info (30)
 *  - 'silent'                 → +Infinity (valid, no warning)
 *  - a known label            → its numeric value
 *  - anything else            → info (30) + `invalid: true`
 *
 * Reject-to-default, NOT clamp and NOT throw — the same convention as
 * ENCODE_NICE / SLOW_QUERY_MS / CPU_ATTRIBUTION_*. Before 49-04 an unknown
 * LOG_LEVEL crashed the process at module load; keeping that would mean one env
 * typo kills the container. Silently accepting it would be worse still: the
 * value would travel to the stream, multistream would compare against
 * `undefined` and the container log would go COMPLETELY quiet (measured).
 */
export function resolveStdoutLevel(
  raw: string | undefined = process.env.LOG_LEVEL,
): StdoutLevelResolution {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { value: INFO_LEVEL, requested: raw, invalid: false };
  // 'silent' is a valid pino INSTANCE level but has no numeric stream value.
  // Resolve it to a numeric sentinel so the silent path does not depend on
  // pino's unknown-label behaviour (pino is pinned as "^9" — unpinned minor).
  if (trimmed === 'silent') {
    return { value: Number.POSITIVE_INFINITY, requested: raw, invalid: false };
  }
  const known = LOGGER_LEVEL_VALUES[trimmed];
  if (typeof known === 'number') return { value: known, requested: raw, invalid: false };
  return { value: INFO_LEVEL, requested: raw, invalid: true };
}

/**
 * Ring stream level: `min(25, max(20, stdoutLevel))`.
 *
 * The `max(DEBUG_LEVEL, …)` FLOOR is not decoration and must not be simplified
 * away to a fixed 25. Two ring consumers match lines that are emitted via
 * `logger.debug`: `web-vitals.ts` (`web_vital_captured`,
 * app/api/diagnostics/log-event/route.ts) and `blocklist-evaluation.ts`
 * (`blocklist_evaluation`, src/lib/skip/pipeline.ts). Pinning the ring at 25
 * would make BOTH surfaces permanently empty in EVERY configuration — today
 * they are at least conditionally recoverable via `LOG_LEVEL=debug`.
 *
 * Invariant: the ring loses no line it holds today. The ceiling at 25 keeps the
 * default case unchanged (no `encode_progress` flood in the 1000-line ring) and
 * keeps `LOG_LEVEL=trace` from adding a trace flood — exactly as today.
 */
export function resolveRingLevel(stdoutValue: number): number {
  return Math.min(TELEMETRY_LEVEL, Math.max(DEBUG_LEVEL, stdoutValue));
}

/**
 * Instance level: the lower of the two stream levels.
 * Invariant: the instance gate never blocks what a stream wants. (A fixed
 * `'debug'` would satisfy the default case but would swallow `LOG_LEVEL=trace`,
 * which the operator asked for explicitly.)
 */
export function resolveInstanceLevel(stdoutValue: number, ringValue: number): number {
  return Math.min(stdoutValue, ringValue);
}

/**
 * Construction invariant (AC-17): a stream level is ALWAYS a number — either
 * finite or `+Infinity`. A label that pino cannot resolve silences its stream
 * without a word, so no label may ever reach `multistream` again.
 */
export function assertStreamLevel(value: number, which: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`logger: ${which} stream level must be a number, got ${String(value)}`);
  }
  return value;
}

/**
 * Numeric instance level → the pino label. Unlike the STREAM levels (numbers,
 * AC-17) the INSTANCE level must be a label pino can set on itself. By
 * construction `resolveInstanceLevel` can only return a value that is in
 * LOGGER_LEVEL_VALUES (it is `min(stdout, ring)` and the ring is capped at 25),
 * so the lookup always hits; it throws rather than guessing if that ever stops
 * being true, because an unknown instance label would make pino throw at module
 * load with a far less obvious message.
 */
export function levelLabelFor(value: number): string {
  for (const [label, v] of Object.entries(LOGGER_LEVEL_VALUES)) {
    if (v === value) return label;
  }
  throw new Error(`logger: instance level ${String(value)} has no label`);
}

interface DuckStream {
  write(chunk: string | Buffer): boolean;
  end(): void;
  on(): DuckStream;
  once(): DuckStream;
  removeListener(): DuckStream;
}

const ringWriter: DuckStream = {
  write(chunk: string | Buffer): boolean {
    try {
      pushLine(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    } catch {
      // Never block log emission on buffer failure.
    }
    return true;
  },
  end(): void {},
  on(): DuckStream {
    return ringWriter;
  },
  once(): DuckStream {
    return ringWriter;
  },
  removeListener(): DuckStream {
    return ringWriter;
  },
};

// Capability check (NOT environment check): pino's package.json "browser"
// field swaps in a shim that has NO `multistream` export. Detecting the
// MISSING capability is more reliable than guessing the runtime — it works
// for Node (real multistream), browser (shim, undefined), AND vitest jsdom
// (real pino imported despite jsdom-defined `window`). Client components
// (app/error.tsx, app/global-error.tsx) import this module transitively;
// in their bundle pino.multistream is undefined → fallback path runs.
type PinoMaybeMultistream = typeof pino & {
  multistream?: typeof pino.multistream;
};
const pinoLib = pino as PinoMaybeMultistream;

const stdoutResolution = resolveStdoutLevel();
const stdoutLevelValue = assertStreamLevel(stdoutResolution.value, 'stdout');
const ringLevelValue = assertStreamLevel(resolveRingLevel(stdoutLevelValue), 'ring');
const instanceLevelValue = resolveInstanceLevel(stdoutLevelValue, ringLevelValue);
const instanceLevelLabel = levelLabelFor(instanceLevelValue);

// The custom level must actually be wired into the value table the multistream
// level comparison uses, or `telemetry` lines silently pick the wrong stream.
if (LOGGER_LEVEL_VALUES.telemetry !== TELEMETRY_LEVEL) {
  throw new Error('logger: LOGGER_LEVEL_VALUES lost the telemetry level');
}

export const logger =
  typeof pinoLib.multistream === 'function'
    ? pinoLib(
        { level: instanceLevelLabel, customLevels: LOGGER_CUSTOM_LEVELS },
        pinoLib.multistream(
          [
            { stream: process.stdout, level: stdoutLevelValue },
            { stream: ringWriter as unknown as NodeJS.WritableStream, level: ringLevelValue },
          ],
          // Custom-level resolution for the per-stream level comparison.
          // `useOnlyCustomLevels` stays unset — the tier is purely ADDITIVE,
          // the standard levels must keep existing.
          { levels: LOGGER_LEVEL_VALUES },
        ),
      )
    : // Browser shim fallback. `customLevels` is ship-blocking here: without it
      // `logger.telemetry` is `undefined` in the client bundle and the call
      // crashes exactly on the error page (app/error.tsx, app/global-error.tsx
      // import this module transitively).
      pinoLib({ level: 'info', customLevels: LOGGER_CUSTOM_LEVELS });

/**
 * The application logger type — `pino.Logger` PLUS the `telemetry` tier.
 *
 * Modules that take a logger as a parameter MUST annotate it with this instead
 * of the bare `pino.Logger`: the bare type is `Logger<never>` and is NOT
 * assignable from a logger that declares custom levels, so passing `logger`
 * into a `pino.Logger` parameter stopped compiling with 49-04. It is also the
 * honest type — a downstream module holding a `Logger<never>` could not call
 * `.telemetry()` even though the object it holds has the method.
 */
export type AppLogger = typeof logger;

declare global {
  var __x265butler_log_level_warned: boolean | undefined;
}

// Warn ONCE per process about an unusable LOG_LEVEL. The globalThis guard is
// not ceremony: Next.js compiles server modules into several registries and HMR
// re-imports them, so a module-scope side effect fires once per REGISTRY, not
// once per process. Same pattern as __x265butler_log_ring_buffer /
// __x265butler_cpu_attribution_sampler. In the client bundle
// process.env.LOG_LEVEL is undefined ⇒ never invalid ⇒ never warned here.
if (stdoutResolution.invalid && !globalThis.__x265butler_log_level_warned) {
  globalThis.__x265butler_log_level_warned = true;
  logger.warn(
    {
      action: 'log_level_invalid',
      requested: stdoutResolution.requested,
      resolved: 'info',
    },
    'log_level_invalid',
  );
}
