import crypto from 'node:crypto';
import { jobRepo } from '@/src/lib/db';
import { engineEvents, type EngineEvent } from '@/src/lib/encode/events';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

import { gateAuth } from '@/src/lib/api/auth-gate';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEARTBEAT_MS = 30 * 1000;
const PROGRESS_THROTTLE_MS = 1000;
const DROP_LOG_BATCH = 10;
// audit-added M4: bounded queue. Default ReadableStream highWaterMark=1 is too
// aggressive (would drop the 2nd frame before the consumer reads the 1st).
// 64 chunks ≈ 64 * <1KB SSE frames = ≤64 KB per-stream memory ceiling — bounded
// against forgotten-tab OOM but loose enough that healthy consumers never hit
// the drop path. Backpressure (desiredSize ≤ 0) still triggers at 64 chunks
// behind for genuine slow consumers.
const STREAM_HIGH_WATER_MARK = 64;

// GET /api/events — Server-Sent-Events stream of EngineEvent frames.
// Per CONTEXT §5 + audit M4 + S3 + S10 + S11 + S13.
export async function GET(request: Request): Promise<Response> {
  // 05-01 Plan T3: requireAuth gate.
  const { denied } = await gateAuth(request);
  if (denied) return denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/events' });
  const startMs = Date.now();

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const enc = new TextEncoder();

        // Per-stream state
        const lastProgressByJob = new Map<number, number>();
        let closed = false; // audit-added S10: idempotent cleanup guard
        let deliveredCount = 0;
        let droppedCount = 0;
        let lastDropLogAt = 0;

        // audit-added M4: backpressure-aware enqueue. desiredSize<=0 means the
        // stream's internal queue is full; dropping is the only safe response
        // (cannot await on a non-async ReadableStream start callback).
        const safeEnqueue = (frame: string): boolean => {
          if (closed) return false;
          try {
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              droppedCount++;
              if (droppedCount - lastDropLogAt >= DROP_LOG_BATCH) {
                log.debug(
                  { action: 'sse_event_dropped', droppedCount },
                  'SSE backpressure: dropping events',
                );
                lastDropLogAt = droppedCount;
              }
              return false;
            }
            controller.enqueue(enc.encode(frame));
            deliveredCount++;
            return true;
          } catch (err) {
            log.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'SSE enqueue threw; cleaning up',
            );
            cleanup();
            return false;
          }
        };

        // Initial frame — UI baseline. audit-added M2: countByStatus accurate.
        const active = jobRepo().listActive();
        const pending = jobRepo().countByStatus('queued');
        safeEnqueue(
          `data: ${JSON.stringify({
            type: 'queue.updated',
            activeJobs: active.length,
            pendingJobs: pending,
          })}\n\n`,
        );

        // audit-added S13: replay last-known progress for any active job so a UI
        // joining mid-encode sees the current progress immediately, not after
        // the next ≤1s onProgress emit.
        for (const activeJob of active) {
          const lastProgress = engineEvents.getLastProgress(activeJob.id);
          if (lastProgress) {
            safeEnqueue(`data: ${JSON.stringify(lastProgress)}\n\n`);
          }
        }

        const onEvent = (ev: EngineEvent): void => {
          if (closed) return;
          if (ev.type === 'job.progress') {
            const last = lastProgressByJob.get(ev.jobId) ?? 0;
            const now = Date.now();
            if (now - last < PROGRESS_THROTTLE_MS) return; // per-jobId throttle
            lastProgressByJob.set(ev.jobId, now);
          }
          safeEnqueue(`data: ${JSON.stringify(ev)}\n\n`);
        };

        const unsubscribe = engineEvents.subscribe(onEvent);

        const heartbeat = setInterval(() => {
          if (closed) {
            clearInterval(heartbeat);
            return;
          }
          safeEnqueue(': ping\n\n');
        }, HEARTBEAT_MS);

        // audit-added S10 + S11: idempotent cleanup; safe to call multiple times.
        // audit-added S3: safeUnsubscribe — pino-warns on throw instead of silently swallowing.
        function cleanup(): void {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          try {
            unsubscribe();
          } catch (err) {
            log.warn(
              { err: err instanceof Error ? err.message : String(err) },
              'SSE unsubscribe threw',
            );
          }
          try {
            controller.close();
          } catch {
            // already closed; swallow
          }
          log.info(
            {
              action: 'sse_stream_closed',
              durationMs: Date.now() - startMs,
              deliveredCount,
              droppedCount,
            },
            'SSE stream closed',
          );
        }

        // audit-added S10: { once: true } so we cannot fire twice on close+abort sequence
        request.signal.addEventListener('abort', cleanup, { once: true });
      },
    },
    { highWaterMark: STREAM_HIGH_WATER_MARK },
  );

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
