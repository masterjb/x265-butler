// @vitest-environment node
// 49-04: the `telemetry` (25) log tier.
//
// Every claim of the plan is EXECUTED here, not argued — including the negative
// controls that make a later regression fail loudly:
//   - AC-10 fails if someone drops the ring stream to `debug` in the DEFAULT case
//     (the 40-01 AC-8 ring-budget arithmetic hangs off that).
//   - AC-16 fails if someone pins the ring hard at 25 (that would make
//     assembleWebVitals + assembleBlocklistEvaluation permanently empty).
//
// The stream pairs below are built from the SAME exported resolvers the
// production module uses (resolveStdoutLevel / resolveRingLevel /
// resolveInstanceLevel / LOGGER_CUSTOM_LEVELS / LOGGER_LEVEL_VALUES) — a
// hand-written second builder would test itself, not the shipped wiring.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';
import {
  TELEMETRY_LEVEL,
  LOGGER_CUSTOM_LEVELS,
  LOGGER_LEVEL_VALUES,
  resolveStdoutLevel,
  resolveRingLevel,
  resolveInstanceLevel,
  levelLabelFor,
} from '@/src/lib/logger';
import { pushLine, tail, _resetForTesting } from '@/src/lib/log/ring-buffer';
import { assembleWebVitals } from '@/src/lib/diagnostics/web-vitals';
import { assembleBlocklistEvaluation } from '@/src/lib/diagnostics/blocklist-evaluation';

interface Captured {
  msg: string;
  level: number;
}

function sink(out: Captured[]): { write(chunk: string): void } {
  return {
    write(chunk: string): void {
      const p = JSON.parse(chunk) as Captured;
      out.push({ msg: p.msg, level: p.level });
    },
  };
}

interface Pair {
  log: pino.Logger<'telemetry'>;
  stdout: Captured[];
  ring: Captured[];
  stdoutLevel: number;
  ringLevel: number;
  instanceLevel: number;
  invalid: boolean;
}

/**
 * Build the production stream wiring for a given LOG_LEVEL, with both streams
 * swapped for capture sinks. `ringToRealBuffer` instead routes the ring stream
 * into the REAL ring buffer, so the /api/diagnostics scanners can be run
 * against it end-to-end (AC-16).
 */
function buildPair(rawLogLevel: string | undefined, ringToRealBuffer = false): Pair {
  const resolution = resolveStdoutLevel(rawLogLevel);
  const ringLevel = resolveRingLevel(resolution.value);
  const instanceLevel = resolveInstanceLevel(resolution.value, ringLevel);

  const stdout: Captured[] = [];
  const ring: Captured[] = [];

  const ringStream = ringToRealBuffer
    ? {
        write(chunk: string): void {
          pushLine(chunk);
          const p = JSON.parse(chunk) as Captured;
          ring.push({ msg: p.msg, level: p.level });
        },
      }
    : sink(ring);

  const log = pino(
    { level: levelLabelFor(instanceLevel), customLevels: LOGGER_CUSTOM_LEVELS },
    pino.multistream(
      [
        { stream: sink(stdout) as unknown as NodeJS.WritableStream, level: resolution.value },
        { stream: ringStream as unknown as NodeJS.WritableStream, level: ringLevel },
      ],
      { levels: LOGGER_LEVEL_VALUES },
    ),
  );

  return {
    log,
    stdout,
    ring,
    stdoutLevel: resolution.value,
    ringLevel,
    instanceLevel,
    invalid: resolution.invalid,
  };
}

function emitEveryLevel(log: pino.Logger<'telemetry'>): void {
  log.trace('m-trace');
  log.debug('m-debug');
  log.telemetry('m-telemetry');
  log.info('m-info');
  log.warn('m-warn');
  log.error('m-error');
}

const msgs = (c: Captured[]): string[] => c.map((x) => x.msg);

beforeEach(() => {
  _resetForTesting();
});

afterEach(() => {
  _resetForTesting();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('49-04 AC-1/AC-3/AC-9: default LOG_LEVEL', () => {
  it('telemetry reaches the ring but NOT stdout; info/warn/error reach both', () => {
    const p = buildPair(undefined);
    emitEveryLevel(p.log);

    expect(msgs(p.stdout)).toEqual(['m-info', 'm-warn', 'm-error']);
    expect(msgs(p.ring)).toEqual(['m-telemetry', 'm-info', 'm-warn', 'm-error']);
    expect(p.stdoutLevel).toBe(30);
    expect(p.ringLevel).toBe(TELEMETRY_LEVEL);
  });

  it('AC-3 negative control: an ordinary debug line reaches NEITHER destination', () => {
    const p = buildPair(undefined);
    p.log.debug({ probe: 'x' }, 'plain-debug-line');

    expect(msgs(p.stdout)).not.toContain('plain-debug-line');
    expect(msgs(p.ring)).not.toContain('plain-debug-line');
  });

  it('the telemetry line carries pino level 25', () => {
    const p = buildPair(undefined);
    p.log.telemetry('tele');
    expect(p.ring.find((l) => l.msg === 'tele')?.level).toBe(25);
  });
});

describe('49-04 AC-4/AC-5/AC-6b: LOG_LEVEL as the operator lever', () => {
  it('AC-4: LOG_LEVEL=debug pulls the telemetry back onto stdout (the revert lever)', () => {
    const p = buildPair('debug');
    emitEveryLevel(p.log);

    expect(msgs(p.stdout)).toContain('m-telemetry');
    expect(msgs(p.stdout)).toContain('m-debug');
  });

  it('AC-5: LOG_LEVEL=trace — the instance gate never blocks what a stream wants', () => {
    const p = buildPair('trace');
    emitEveryLevel(p.log);

    expect(msgs(p.stdout)).toContain('m-trace');
    expect(p.instanceLevel).toBe(10);
  });

  it('AC-5: LOG_LEVEL=warn — telemetry stays in the ring, stays off stdout', () => {
    const p = buildPair('warn');
    emitEveryLevel(p.log);

    expect(msgs(p.stdout)).toEqual(['m-warn', 'm-error']);
    expect(msgs(p.ring)).toContain('m-telemetry');
  });

  it('AC-6b: LOG_LEVEL=silent — stdout says nothing, the ring keeps its evidence', () => {
    const p = buildPair('silent');
    emitEveryLevel(p.log);

    expect(p.stdout).toEqual([]);
    expect(msgs(p.ring)).toEqual(['m-telemetry', 'm-info', 'm-warn', 'm-error']);
    // 'silent' is a legitimate value, NOT a typo — no warning is owed.
    expect(p.invalid).toBe(false);
  });
});

describe('49-04 AC-17: no stream ever gets an unresolvable label', () => {
  it('silent resolves to the NUMERIC sentinel +Infinity, not to the label', () => {
    const r = resolveStdoutLevel('silent');
    expect(r.value).toBe(Number.POSITIVE_INFINITY);
    expect(typeof r.value).toBe('number');
    // The hardening this pins down: as a *stream* level the LABEL 'silent' is
    // byte-identical to a typo, because pino has no numeric value for it and
    // multistream then compares against `undefined`. Both go quiet — but only
    // one of them is meant to.
    expect(LOGGER_LEVEL_VALUES.silent).toBeUndefined();
  });

  it('every resolved stream level is a number for every input', () => {
    for (const raw of [
      undefined,
      '',
      'trace',
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
      'telemetry',
      'silent',
      'junktypo',
    ]) {
      const r = resolveStdoutLevel(raw);
      expect(typeof r.value).toBe('number');
      expect(Number.isNaN(r.value)).toBe(false);
      expect(typeof resolveRingLevel(r.value)).toBe('number');
    }
  });

  it('an unknown label never reaches a stream — it is replaced by info(30)', () => {
    const r = resolveStdoutLevel('nichtexistierenderlevel');
    expect(r.value).toBe(30);
    expect(r.invalid).toBe(true);
    // The negative control for the measured trap: handing the raw label through
    // to the stream would have produced a COMPLETELY silent stdout.
    const captured: Captured[] = [];
    const naive = pino(
      { level: 'trace', customLevels: LOGGER_CUSTOM_LEVELS },
      pino.multistream(
        [
          {
            stream: sink(captured) as unknown as NodeJS.WritableStream,
            level: 'nichtexistierenderlevel' as never,
          },
        ],
        { levels: LOGGER_LEVEL_VALUES },
      ),
    );
    naive.info('would-be-lost');
    naive.error('would-be-lost-too');
    expect(captured).toEqual([]); // <- exactly the dark hole this plan closes

    // ...whereas the shipped resolver keeps stdout speaking on the same input.
    const shipped = buildPair('nichtexistierenderlevel');
    shipped.log.info('still-heard');
    shipped.log.error('still-heard-too');
    expect(msgs(shipped.stdout)).toEqual(['still-heard', 'still-heard-too']);
  });
});

describe('49-04 AC-10: ring budget frozen at the default LOG_LEVEL', () => {
  it('encode_progress (logger.debug) does NOT enter the ring', () => {
    // FROZEN ASSERTION. This test is meant to fail if someone later drops the
    // ring stream to `debug` in the DEFAULT case: orchestrator.ts emits
    // encode_progress at debug, and letting it into the 1000-line ring would
    // invalidate the 40-01 AC-8 arithmetic (cpu_attribution 240 lines/h,
    // ~4 h hold) that the diagnostics copy-report depends on.
    const p = buildPair(undefined);
    p.log.debug({ action: 'encode_progress', jobId: 1, pct: 12 }, 'encode_progress');

    expect(msgs(p.ring)).not.toContain('encode_progress');
    expect(p.ringLevel).toBe(25);
  });
});

describe('49-04 AC-12: child loggers inherit the tier', () => {
  it('child().telemetry exists, lands in the ring, stays off stdout', () => {
    const p = buildPair(undefined);
    const child = p.log.child({ mod: 'x' });

    expect(typeof child.telemetry).toBe('function');
    child.telemetry({ k: 1 }, 'child-telemetry');

    expect(msgs(p.ring)).toContain('child-telemetry');
    expect(msgs(p.stdout)).not.toContain('child-telemetry');
  });
});

describe('49-04 AC-16: the ring loses no line it held before the plan', () => {
  it('LOG_LEVEL=debug — a debug line still lands IN the ring (floor is 20, not 25)', () => {
    // FROZEN ASSERTION against a later "let us just pin the ring at 25". Two
    // diagnostic surfaces match lines emitted via logger.debug; a hard pin would
    // make BOTH permanently empty in EVERY configuration, which is precisely the
    // bug class this plan exists to abolish.
    const p = buildPair('debug');
    p.log.debug('debug-into-ring');

    expect(p.ringLevel).toBe(20);
    expect(msgs(p.ring)).toContain('debug-into-ring');
  });

  it('assembleWebVitals + assembleBlocklistEvaluation still find their debug lines under LOG_LEVEL=debug', () => {
    const p = buildPair('debug', /* ringToRealBuffer */ true);

    p.log.debug({ route: '/library', metric: 'ttfb', value: 1200 }, 'web_vital_captured');
    p.log.debug(
      {
        path: '/mnt/user/media/a.mkv',
        matchedEntry: { id: 7, kind: 'path_pattern', pattern: '*.sample.*' },
      },
      'blocklist_evaluation',
    );

    const vitals = assembleWebVitals();
    expect(vitals.byRoute['/library']?.ttfb?.sampleSize).toBe(1);
    expect(vitals.byRoute['/library']?.ttfb?.p75).toBe(1200);

    const blocklist = assembleBlocklistEvaluation({
      blocklistRepo: () => ({ count: () => 3 }) as never,
      patternsCacheTimestampGetter: () => null,
    });
    expect(blocklist.recentEvaluations).toHaveLength(1);
    expect(blocklist.recentEvaluations[0].path).toBe('/mnt/user/media/a.mkv');
    expect(blocklist.recentEvaluations[0].matchedEntry).toMatchObject({
      id: 7,
      kind: 'path_pattern',
    });
  });

  it('LOG_LEVEL=trace — trace reaches stdout but NOT the ring (floor stays at 20, exactly as before)', () => {
    const p = buildPair('trace');
    p.log.trace('trace-line');

    expect(msgs(p.stdout)).toContain('trace-line');
    expect(msgs(p.ring)).not.toContain('trace-line');
    expect(p.ringLevel).toBe(20);
  });
});

describe('49-04 AC-6: an unusable LOG_LEVEL degrades visibly instead of going quiet', () => {
  beforeEach(() => {
    vi.resetModules();
    delete globalThis.__x265butler_log_level_warned;
    _resetForTesting();
  });

  afterEach(() => {
    vi.resetModules();
    delete globalThis.__x265butler_log_level_warned;
    vi.unstubAllEnvs();
  });

  it('construction does not throw, stdout still SPEAKS, and exactly one log_level_invalid is emitted', async () => {
    vi.stubEnv('LOG_LEVEL', 'nichtexistierenderlevel');

    const mod = await import('@/src/lib/logger');

    // Positive probe — "nothing threw" is NOT enough. Before 49-04 the naive
    // construction accepted the junk label on the stream and stdout went
    // completely silent; that failure mode is invisible to a throw-check.
    // isLevelEnabled only proves the INSTANCE gate, so the stdout STREAM level
    // is asserted separately (30 = info, i.e. it still speaks).
    expect(mod.resolveStdoutLevel().value).toBe(30);
    expect(mod.resolveStdoutLevel().invalid).toBe(true);
    expect(mod.logger.isLevelEnabled('info')).toBe(true);

    const invalidLines = tail(1000).lines.filter((l) => {
      try {
        return (JSON.parse(l) as { msg?: string }).msg === 'log_level_invalid';
      } catch {
        return false;
      }
    });
    expect(invalidLines).toHaveLength(1);
    const payload = JSON.parse(invalidLines[0]) as Record<string, unknown>;
    expect(payload.requested).toBe('nichtexistierenderlevel');
    expect(payload.resolved).toBe('info');
  });

  it('the warn-once guard is a globalThis flag, not "module load happens once"', async () => {
    vi.stubEnv('LOG_LEVEL', 'nichtexistierenderlevel');

    await import('@/src/lib/logger');
    expect(globalThis.__x265butler_log_level_warned).toBe(true);

    // Next.js compiles server modules into SEVERAL registries and HMR
    // re-imports them, so a module-scope side effect fires once per REGISTRY,
    // not once per process. Re-importing after a module-registry reset is the
    // closest reproduction of that.
    vi.resetModules();
    await import('@/src/lib/logger');

    const invalidLines = tail(1000).lines.filter((l) => {
      try {
        return (JSON.parse(l) as { msg?: string }).msg === 'log_level_invalid';
      } catch {
        return false;
      }
    });
    expect(invalidLines).toHaveLength(1); // still ONE, not two
  });

  it('a valid LOG_LEVEL emits no warning at all', async () => {
    vi.stubEnv('LOG_LEVEL', 'warn');

    await import('@/src/lib/logger');

    const invalidLines = tail(1000).lines.filter((l) => {
      try {
        return (JSON.parse(l) as { msg?: string }).msg === 'log_level_invalid';
      } catch {
        return false;
      }
    });
    expect(invalidLines).toHaveLength(0);
    expect(globalThis.__x265butler_log_level_warned).toBeUndefined();
  });
});

describe('49-04 AC-8: the client-bundle path knows telemetry (ship-blocking)', () => {
  afterEach(() => {
    vi.doUnmock('pino');
    vi.resetModules();
  });

  it('the REAL pino/browser.js shim generates the method from customLevels', async () => {
    // Deliberately the real shim, not a hand-written fake: a unit test against
    // the node branch proves NOTHING about the client bundle. app/error.tsx and
    // app/global-error.tsx import the logger transitively, so a missing method
    // here is a crash on the error page itself.
    // `pino/browser.js` ships no type declaration — importing it through a
    // string variable keeps TS out of the way without a project-wide
    // `declare module` shim. The point of the test is the RUNTIME shape.
    const browserEntry = 'pino/browser.js';
    const browserPino = (await import(/* @vite-ignore */ browserEntry)) as unknown as {
      default: (opts: unknown) => Record<string, unknown>;
    };
    const factory = (browserPino.default ?? browserPino) as unknown as (
      opts: unknown,
    ) => Record<string, unknown>;

    const shimLogger = factory({ level: 'info', customLevels: LOGGER_CUSTOM_LEVELS });
    expect(typeof shimLogger.telemetry).toBe('function');
    expect(() => (shimLogger.telemetry as (...a: unknown[]) => void)({ a: 1 }, 'x')).not.toThrow();

    const child = (shimLogger.child as (b: unknown) => Record<string, unknown>)({ mod: 'y' });
    expect(typeof child.telemetry).toBe('function');
  });

  it('logger.ts own fallback branch (no multistream) exposes telemetry', async () => {
    vi.resetModules();
    // doMock (not vi.mock) so the stub applies only to the dynamic import below
    // and does not leak into the other describes in this file.
    vi.doMock('pino', async () => {
      const actual = (await vi.importActual('pino')) as { default: unknown };
      const real = actual.default as (...a: unknown[]) => unknown;
      // Same callable, but WITHOUT the multistream capability — that is exactly
      // what pino's "browser" package.json field swaps in.
      const shim = ((opts: unknown) => real(opts)) as unknown as Record<string, unknown>;
      shim.levels = (actual.default as unknown as { levels: unknown }).levels;
      return { default: shim };
    });

    const mod = await import('@/src/lib/logger');
    expect(typeof mod.logger.telemetry).toBe('function');
    expect(() => mod.logger.telemetry({ a: 1 }, 'fallback-telemetry')).not.toThrow();
  });
});
