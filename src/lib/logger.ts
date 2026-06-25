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

import pino from 'pino';
import { pushLine } from '@/src/lib/log/ring-buffer';

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

export const logger =
  typeof pinoLib.multistream === 'function'
    ? pinoLib(
        { level: process.env.LOG_LEVEL ?? 'info' },
        pinoLib.multistream([
          { stream: process.stdout, level: 'debug' },
          { stream: ringWriter as unknown as NodeJS.WritableStream, level: 'debug' },
        ]),
      )
    : pinoLib({ level: 'info' });
