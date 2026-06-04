// 05-03 T1.G: GET /api/logs/[jobId] — paginated read + SSE-live stream.
// Phase 5 Plan 05-03 (Logs Viewer) — AC-2 + AC-3 + audit M1, S2, S3, S6, S10.
//
// Two modes:
//   ?live=0 (default): JSON response { jobId, lines, totalLines, status, requestId }
//   ?live=1           : SSE stream — initial 200-line replay + fs.watch tail
//
// Security:
//   - requireAuth() FIRST (carry-forward 05-01 AC-10 — auth before any fs.* call)
//   - jobId regex `^[a-zA-Z0-9_-]{1,64}$` (first-layer path-traversal defense)
//   - audit M1: path.resolve + prefix-startsWith assertion (defense-in-depth)
//
// SSE invariants (carry-forward 02-04 + audit S3 + S6):
//   - heartbeat 30s; per-stream backpressure-aware enqueue
//   - lastReadOffset advances BEFORE emit (so backpressure-skip still progresses)
//   - watcher 'rename' → terminal+close; watcher 'change' shrunk → re-sync to 0
//   - cleanup on req.signal abort within 100ms

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';

import { authGuard, requireAuth, withRenewCookie } from '@/src/lib/auth/require-auth';
import { settingRepo, jobRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JOB_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_LINES = 1000;
const BODY_CAP_BYTES = 5 * 1024 * 1024; // 5 MB
const BODY_CAP_LINES = 5000;
const SSE_INITIAL_REPLAY_LINES = 200;
const HEARTBEAT_MS = 30 * 1000;
const STREAM_HIGH_WATER_MARK = 64;

function jsonResponse(body: unknown, status: number, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(extraHeaders ?? {}),
    },
  });
}

function resolveLogsDir(): { logsDir: string; cachePoolPath: string } | null {
  const cachePoolPath = settingRepo().get('cache_pool_path') ?? '';
  if (!cachePoolPath) return null;
  return { logsDir: path.resolve(cachePoolPath, 'logs'), cachePoolPath };
}

/**
 * audit M1: path containment defense-in-depth.
 * Even when JOB_ID_REGEX passes, assert the resolved file path starts with
 * `<logsDir>/`. Mismatch → caller returns 400 invalid_path.
 */
function safeJobLogPath(logsDir: string, jobId: string): string | null {
  const candidate = path.resolve(path.join(logsDir, `${jobId}.log`));
  const prefix = logsDir + path.sep;
  if (!candidate.startsWith(prefix)) return null;
  return candidate;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  // 05-01 AC-10: auth gate FIRST, before any fs.* / ReadableStream construction.
  const auth = await requireAuth(request);
  const denied = authGuard(auth);
  if (denied) return denied;

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/logs/[jobId]' });

  const { jobId } = await context.params;
  if (!JOB_ID_REGEX.test(jobId)) {
    return jsonResponse({ error_code: 'invalid_job_id', requestId }, 400);
  }

  const dirs = resolveLogsDir();
  if (!dirs) {
    return jsonResponse({ error_code: 'log_not_found', requestId }, 404);
  }

  const filePath = safeJobLogPath(dirs.logsDir, jobId);
  if (!filePath) {
    log.warn({ jobId }, 'path containment check failed');
    return jsonResponse({ error_code: 'invalid_path', requestId }, 400);
  }

  const url = new URL(request.url);
  const live = url.searchParams.get('live') === '1';

  if (live) {
    return liveStream({ filePath, jobId, requestId, request, log });
  }

  return paginatedRead({ filePath, jobId, requestId, url, auth, log });
}

async function paginatedRead(opts: {
  filePath: string;
  jobId: string;
  requestId: string;
  url: URL;
  auth: Awaited<ReturnType<typeof requireAuth>>;
  log: Logger;
}): Promise<Response> {
  const { filePath, jobId, requestId, url, auth, log } = opts;

  let stat: import('fs').Stats;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return jsonResponse({ error_code: 'log_not_found', requestId }, 404);
  }

  const sinceParam = url.searchParams.get('since');
  const since = sinceParam ? Math.max(0, Number.parseInt(sinceParam, 10) || 0) : 0;
  const order = url.searchParams.get('order') === 'desc' ? 'desc' : 'asc';

  // Read from byte-offset (or full file when since=0). Cap at BODY_CAP_BYTES.
  let buffer: Buffer;
  let truncated = false;
  let bytesRead: number;
  if (since > 0 && since < stat.size) {
    const fh = await fsp.open(filePath, 'r');
    try {
      const remaining = stat.size - since;
      const toRead = Math.min(remaining, BODY_CAP_BYTES);
      buffer = Buffer.alloc(toRead);
      const { bytesRead: r } = await fh.read(buffer, 0, toRead, since);
      bytesRead = r;
      if (toRead < remaining) truncated = true;
    } finally {
      await fh.close();
    }
  } else {
    if (stat.size > BODY_CAP_BYTES) {
      const fh = await fsp.open(filePath, 'r');
      try {
        const startAt = stat.size - BODY_CAP_BYTES;
        buffer = Buffer.alloc(BODY_CAP_BYTES);
        const { bytesRead: r } = await fh.read(buffer, 0, BODY_CAP_BYTES, startAt);
        bytesRead = r;
        truncated = true;
      } finally {
        await fh.close();
      }
    } else {
      buffer = await fsp.readFile(filePath);
      bytesRead = buffer.length;
    }
  }

  const text = buffer.toString('utf8', 0, bytesRead);
  let lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  if (lines.length > BODY_CAP_LINES) {
    lines = lines.slice(-BODY_CAP_LINES);
    truncated = true;
  }
  if (lines.length > DEFAULT_LINES && since === 0) {
    lines = lines.slice(-DEFAULT_LINES);
  }
  if (order === 'desc') lines = [...lines].reverse();

  // Resolve job status best-effort (numeric jobIds only; non-numeric → unknown).
  let status: string | null = null;
  const numericId = Number.parseInt(jobId, 10);
  if (Number.isFinite(numericId) && String(numericId) === jobId) {
    try {
      const job = jobRepo().findById(numericId);
      if (job) status = job.status;
    } catch (err) {
      log.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'jobRepo.findById failed (non-fatal)',
      );
    }
  }

  const body = {
    jobId,
    lines,
    totalLines: lines.length,
    fileSize: stat.size,
    nextOffset: stat.size,
    truncated,
    status,
    requestId,
  };
  return withRenewCookie(jsonResponse(body, 200), auth);
}

function liveStream(opts: {
  filePath: string;
  jobId: string;
  requestId: string;
  request: Request;
  log: Logger;
}): Response {
  const { filePath, jobId, requestId, request, log } = opts;

  const stream = new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        let lastReadOffset = 0;
        let droppedLineCount = 0;
        let watcher: import('fs').FSWatcher | null = null;
        let heartbeat: NodeJS.Timeout | null = null;
        let readInFlight = false;

        const safeEnqueue = (frame: string): boolean => {
          if (closed) return false;
          try {
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              return false; // backpressure: caller decides whether to advance offset
            }
            controller.enqueue(enc.encode(frame));
            return true;
          } catch (err) {
            log.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'SSE enqueue threw',
            );
            cleanup();
            return false;
          }
        };

        // Initial replay — last SSE_INITIAL_REPLAY_LINES lines from current file.
        try {
          const stat = await fsp.stat(filePath);
          lastReadOffset = stat.size;
          const initialBytes = Math.min(stat.size, BODY_CAP_BYTES);
          const fh = await fsp.open(filePath, 'r');
          try {
            const buf = Buffer.alloc(initialBytes);
            await fh.read(buf, 0, initialBytes, stat.size - initialBytes);
            const text = buf.toString('utf8');
            const all = text.split('\n');
            if (all.length > 0 && all[all.length - 1] === '') all.pop();
            const tail = all.slice(-SSE_INITIAL_REPLAY_LINES);
            for (const line of tail) {
              if (closed) break;
              safeEnqueue(`data: ${JSON.stringify({ line })}\n\n`);
            }
          } finally {
            await fh.close();
          }
        } catch {
          // file may not exist yet (early subscribe); start at offset 0
          lastReadOffset = 0;
        }

        // Tail-read function: read from lastReadOffset to current size; advance
        // BEFORE emit per audit S3 (so backpressure-skip still advances).
        const tailRead = async (): Promise<void> => {
          if (closed || readInFlight) return;
          readInFlight = true;
          try {
            const stat = await fsp.stat(filePath).catch(() => null);
            if (!stat) return;
            // audit S6: external truncation → re-sync.
            if (stat.size < lastReadOffset) {
              lastReadOffset = 0;
            }
            if (stat.size <= lastReadOffset) return;

            const remaining = stat.size - lastReadOffset;
            const toRead = Math.min(remaining, BODY_CAP_BYTES);
            const fh = await fsp.open(filePath, 'r');
            let chunk: Buffer;
            try {
              chunk = Buffer.alloc(toRead);
              await fh.read(chunk, 0, toRead, lastReadOffset);
            } finally {
              await fh.close();
            }
            const beforeOffset = lastReadOffset;
            lastReadOffset = lastReadOffset + toRead; // advance BEFORE emit (audit S3)

            const text = chunk.toString('utf8');
            const lines = text.split('\n');
            if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

            for (const line of lines) {
              if (closed) break;
              const ok = safeEnqueue(`data: ${JSON.stringify({ line })}\n\n`);
              if (!ok) {
                droppedLineCount++;
              }
            }
            if (droppedLineCount > 0 && (droppedLineCount & 0x1f) === 0) {
              log.info(
                {
                  event: 'log_sse_backpressure_drop',
                  jobId,
                  droppedLineCount,
                  bytesAdvanced: lastReadOffset - beforeOffset,
                  currentOffset: lastReadOffset,
                },
                'SSE backpressure drop',
              );
            }
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, 'tail-read failed');
          } finally {
            readInFlight = false;
          }
        };

        // fs.watch primary — caveat documented in README for cifs/nfs/fuse.
        try {
          watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
            if (closed) return;
            if (eventType === 'rename') {
              // audit S6: rename → terminal.
              safeEnqueue(`event: terminal\ndata: ${JSON.stringify({ status: 'rename' })}\n\n`);
              cleanup();
              return;
            }
            // change → tail
            void tailRead();
          });
          watcher.on('error', (err) => {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, 'fs.watch errored');
          });
        } catch (err) {
          log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'fs.watch unavailable',
          );
        }

        heartbeat = setInterval(() => {
          if (closed) {
            if (heartbeat) clearInterval(heartbeat);
            return;
          }
          safeEnqueue(`: ping\n\n`);
        }, HEARTBEAT_MS);

        function cleanup(): void {
          if (closed) return;
          closed = true;
          if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
          }
          try {
            watcher?.close();
          } catch {
            // already closed
          }
          watcher = null;
          try {
            controller.close();
          } catch {
            // already closed
          }
          log.info(
            { event: 'log_sse_closed', jobId, droppedLineCount, lastReadOffset, requestId },
            'log SSE stream closed',
          );
        }

        request.signal.addEventListener('abort', cleanup, { once: true });
      },
    },
    { highWaterMark: STREAM_HIGH_WATER_MARK },
  );

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
