// 05-03 T1.B: in-memory ring buffer for container log tail.
// Phase 5 Plan 05-03 (Logs Viewer) — audit S1 + AC-5.
//
// HMR-safe globalThis singleton (matches 02-03 / 05-01 patterns). Populated
// by pino multistream wrap (see logger.ts). Read by /api/logs/container.
//
// audit S1: <100µs per push budget — pure Map operations, no setTimeout/queueMicrotask.

const MAX_LINES = 1000;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

interface RingBufferStore {
  lines: string[];
  totalBytes: number;
}

declare global {
  var __x265butler_log_ring_buffer: RingBufferStore | undefined;
}

function getStore(): RingBufferStore {
  if (!globalThis.__x265butler_log_ring_buffer) {
    globalThis.__x265butler_log_ring_buffer = {
      lines: [],
      totalBytes: 0,
    };
  }
  return globalThis.__x265butler_log_ring_buffer;
}

/**
 * Append one line to the ring buffer. Strips trailing \n for storage.
 * Evicts oldest entries when count >MAX_LINES OR total bytes >MAX_BYTES.
 */
export function pushLine(rawLine: string): void {
  const store = getStore();
  const line = rawLine.endsWith('\n') ? rawLine.slice(0, -1) : rawLine;
  if (line.length === 0) return;
  const lineBytes = Buffer.byteLength(line, 'utf8');
  store.lines.push(line);
  store.totalBytes += lineBytes;
  while (store.lines.length > MAX_LINES || store.totalBytes > MAX_BYTES) {
    const oldest = store.lines.shift();
    if (oldest === undefined) break;
    store.totalBytes -= Buffer.byteLength(oldest, 'utf8');
  }
}

export interface RingBufferTail {
  lines: string[];
  totalLines: number;
  totalBytes: number;
}

/**
 * Return the last `n` lines + capacity metrics.
 * `n` is clamped to [1, MAX_LINES].
 */
export function tail(n: number): RingBufferTail {
  const store = getStore();
  const safeN = Math.max(1, Math.min(n, MAX_LINES));
  const slice = store.lines.slice(-safeN);
  return {
    lines: slice,
    totalLines: store.lines.length,
    totalBytes: store.totalBytes,
  };
}

/** Test-only: clear the buffer. Not exported in production paths. */
export function _resetForTesting(): void {
  if (process.env.NODE_ENV === 'production' && process.env.VITEST !== 'true') return;
  const store = getStore();
  store.lines = [];
  store.totalBytes = 0;
}

export const RING_BUFFER_LIMITS = {
  MAX_LINES,
  MAX_BYTES,
};
