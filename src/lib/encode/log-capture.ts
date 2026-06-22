// 05-03 T1.A: per-job ffmpeg stdout+stderr capture to disk.
// Phase 5 Plan 05-03 (Logs Viewer) — AC-1 + audit M3.
//
// Opens write stream at `{cache_pool_path}/logs/{jobId}.log` mode 0640. Returns
// null when path non-writable (graceful degrade). audit M3: incoming chunks are
// decoded via Buffer.toString('utf8') so non-UTF-8 ffmpeg byte sequences
// (binary subtitle data, malformed metadata) become valid UTF-8 with U+FFFD.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { logger } from '@/src/lib/logger';

declare global {
  var __x265butler_log_capture_disabled_warned: boolean | undefined;
}

function warnDisabledOnce(reason: string): void {
  if (globalThis.__x265butler_log_capture_disabled_warned) return;
  globalThis.__x265butler_log_capture_disabled_warned = true;
  logger.warn(
    { event: 'log_capture_disabled', reason },
    'log capture disabled — cache_pool_path not writable',
  );
}

export interface JobLogStream {
  /** Append a chunk (Buffer or string) to the log file. */
  write(chunk: Buffer | string): void;
  /** fsync-then-close. Idempotent. */
  close(): Promise<void>;
  /** Filesystem path of the underlying log file (for SSE watchers). */
  filePath: string;
}

/**
 * Open a write stream for a job's log. Returns null on non-writable path.
 * audit M3: chunks decoded via Buffer.toString('utf8') for non-UTF-8 safety.
 */
export async function openJobLogStream(
  jobId: string,
  cachePoolPath: string,
): Promise<JobLogStream | null> {
  if (!cachePoolPath) {
    warnDisabledOnce('no_cache_pool_path');
    return null;
  }
  // Sync existsSync gate: when cachePoolPath does not exist on disk, return
  // null IMMEDIATELY without attempting async mkdir. Defends against
  // orchestrator tests that mock stageRoot to a non-existent path AND keeps
  // open-time bounded for production callers (typical hot-path: cache_pool
  // exists; mkdir-recursive on existing dir is microseconds).
  if (!fs.existsSync(cachePoolPath)) {
    warnDisabledOnce('cache_pool_path_does_not_exist');
    return null;
  }
  const logsDir = path.join(cachePoolPath, 'logs');
  try {
    await fsp.mkdir(logsDir, { recursive: true, mode: 0o750 });
    await fsp.access(logsDir, fs.constants.W_OK);
  } catch (err) {
    warnDisabledOnce(err instanceof Error ? err.message : String(err));
    return null;
  }

  const filePath = path.join(logsDir, `${jobId}.log`);
  const stream = fs.createWriteStream(filePath, { flags: 'a', mode: 0o640 });

  let closed = false;
  let fd: number | undefined;
  let streamErrored = false;
  stream.on('open', (openedFd: number) => {
    fd = openedFd;
  });
  // CRITICAL: handle 'error' event so unhandled-error never crashes the process.
  stream.on('error', (err: Error) => {
    streamErrored = true;
    closed = true;
    logger.warn(
      { event: 'log_capture_stream_error', err: err.message, filePath },
      'log capture stream errored — write disabled',
    );
  });

  function timestampPrefix(): string {
    return Date.now().toString(16) + ' ';
  }

  return {
    filePath,
    write(chunk: Buffer | string): void {
      if (closed || streamErrored) return;
      // audit M3: UTF-8-safe decoding — replaces invalid sequences with U+FFFD.
      const str = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      // Prefix each line with millisecond-since-epoch hex timestamp.
      const lines = str.split('\n');
      const out = lines
        .map((line, idx) => (idx === lines.length - 1 ? line : `${timestampPrefix()}${line}\n`))
        .join('');
      stream.write(out);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        if (fd !== undefined) {
          await new Promise<void>((resolve) => {
            fs.fdatasync(fd!, () => resolve());
          });
        }
      } catch {
        // best-effort fdatasync
      }
      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });
    },
  };
}
