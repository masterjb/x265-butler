// Queue reorder.
//
// PATCH moves ONE queued job before another (`beforeJobId: null` = to the
// end). The body stays a few bytes whatever the queue length; sending the
// whole ordered list hit the 16 KB body cap on large queues and, with the
// queue page showing only the first 1000 jobs, renumbered the visible jobs
// while the hidden ones kept their old positions and slipped in between.
// The repository does the move in one transaction against the queue as
// ordered by the processing order setting: everything from the front up to
// the drop point is pinned, so the job lands exactly where it was dropped.
//
// DELETE clears the manual order: every queued job is unpinned and the queue
// follows the processing order alone again. Idempotent by nature.
//
// Authorization model: inherits the single-user auth contract; any
// authenticated session may reorder. Log lines carry `actorId`.
//
// Idempotent replay (PATCH): module-scoped LRU dedup cache keyed by
// clientNonce, max 1000 entries, 60s TTL. A network retry of the same PATCH
// within 60s returns the cached response byte-identically without moving the
// job a second time. Per-process; a restart loses it, which is harmless
// because a repeated move to the same place changes nothing visible.
//
// Log lines name the job, its neighbour and the indexes instead of full ID
// lists, which would be tens of kilobytes on a large queue.

import crypto from 'node:crypto';
import { z } from 'zod';
import { jobRepo, settingRepo } from '@/src/lib/db';
import { engineEvents } from '@/src/lib/encode/events';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { queueCountsSnapshot } from '@/src/lib/queue/counts';
import { QUEUE_ORDER_SETTING_KEY, resolveQueueOrder } from '@/src/lib/queue/queue-order';

import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z
  .object({
    jobId: z.number().int().positive(),
    beforeJobId: z.number().int().positive().nullable(),
    // clientNonce is REQUIRED by the idempotent replay contract.
    clientNonce: z.string().uuid(),
  })
  .strict()
  .refine((b) => b.jobId !== b.beforeJobId, {
    message: 'jobId and beforeJobId must differ',
    path: ['beforeJobId'],
  });

interface CachedResponse {
  status: number;
  body: unknown;
  ts: number;
}

const NONCE_TTL_MS = 60_000;
const NONCE_CACHE_MAX = 1000;
// Module-scoped Map preserves insertion order; LRU eviction by oldest insertion.
const nonceCache = new Map<string, CachedResponse>();

function nonceCacheLookup(nonce: string): CachedResponse | undefined {
  const entry = nonceCache.get(nonce);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > NONCE_TTL_MS) {
    nonceCache.delete(nonce);
    return undefined;
  }
  return entry;
}

function nonceCacheStore(nonce: string, status: number, body: unknown): void {
  if (nonceCache.size >= NONCE_CACHE_MAX) {
    // Evict oldest insertion. Map iteration is insertion-order — first key is oldest.
    const oldest = nonceCache.keys().next().value;
    if (oldest !== undefined) nonceCache.delete(oldest);
  }
  nonceCache.set(nonce, { status, body, ts: Date.now() });
}

// Test-only export — reset between cases.
export function __resetNonceCacheForTests(): void {
  nonceCache.clear();
}

export async function PATCH(request: Request): Promise<Response> {
  const { denied, auth } = await gateAuth(request);
  if (denied) return denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/queue/reorder' });
  const startedAt = Date.now();
  const actorId =
    auth.mode === 'authenticated' ? (auth.username ?? 'auth_disabled') : 'auth_disabled';

  // 16KB body cap — parity with cancel-all + blocklist endpoints.
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader && parseInt(contentLengthHeader, 10) > 16384) {
    return jsonResponse({ error: 'body_too_large', requestId }, 413);
  }

  const contentType = (request.headers.get('content-type') ?? '').trim().toLowerCase();
  if (!contentType.startsWith('application/json')) {
    log.warn({ contentType }, 'unsupported content-type, rejecting with 415');
    return jsonResponse({ error: 'unsupported_media_type', requestId }, 415);
  }

  try {
    let bodyJson: unknown = {};
    const text = await request.text();
    // Defense-in-depth: reject bodies that exceed cap when no content-length header.
    if (text.length > 16384) {
      return jsonResponse({ error: 'body_too_large', requestId }, 413);
    }
    if (text.trim().length > 0) {
      try {
        bodyJson = JSON.parse(text);
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, 'invalid JSON body');
        return jsonResponse({ error: 'invalid_body', details: 'malformed JSON', requestId }, 400);
      }
    }

    const parsed = bodySchema.safeParse(bodyJson);
    if (!parsed.success) {
      // Distinguish nonce-related zod errors so the client can surface a
      // targeted message (reorder_invalid_nonce code).
      const nonceIssue = parsed.error.issues.find((i) => i.path.includes('clientNonce'));
      if (nonceIssue) {
        log.warn({ issues: parsed.error.issues }, 'invalid clientNonce, rejecting with 400');
        return jsonResponse(
          { error: 'reorder_invalid_nonce', details: parsed.error.issues, requestId },
          400,
        );
      }
      log.warn({ issues: parsed.error.issues }, 'body schema validation failed');
      return jsonResponse({ error: 'invalid_body', details: parsed.error.issues, requestId }, 400);
    }

    const { jobId, beforeJobId, clientNonce } = parsed.data;

    // Idempotent replay — return cached response byte-identically.
    const cached = nonceCacheLookup(clientNonce);
    if (cached) {
      log.info(
        {
          action: 'queue_reorder_idempotent_replay',
          actorId,
          clientNonce,
          originalStatus: cached.status,
        },
        'idempotent replay served from cache',
      );
      return jsonResponse(cached.body, cached.status);
    }

    const order = resolveQueueOrder(settingRepo().get(QUEUE_ORDER_SETTING_KEY));
    const result = jobRepo().moveBefore(jobId, beforeJobId, order);
    const durationMs = Date.now() - startedAt;

    if ('unknown' in result) {
      log.warn(
        { unknownJobIds: result.unknown, jobId, beforeJobId, clientNonce, actorId },
        'reorder_unknown_jobids',
      );
      return jsonResponse(
        { error: 'reorder_unknown_jobids', unknownJobIds: result.unknown, requestId },
        400,
      );
    }

    if ('conflict' in result) {
      log.warn(
        {
          action: 'queue_reorder_race_status_changed',
          actorId,
          conflictingJobIds: result.conflict,
          jobId,
          beforeJobId,
          clientNonce,
          durationMs,
        },
        'reorder rolled back: a job is no longer queued',
      );
      const body = {
        error: 'reorder_race_status_changed',
        conflictingJobIds: result.conflict,
        requestId,
      };
      // Cache 409 so a network-retry sees the same 409, not a fresh attempt.
      nonceCacheStore(clientNonce, 409, body);
      return jsonResponse(body, 409);
    }

    emitQueueUpdated(log);

    log.info(
      {
        action: 'queue_reordered',
        actorId,
        jobId,
        beforeJobId,
        fromIndex: result.fromIndex,
        toIndex: result.toIndex,
        pinnedCount: result.pinnedCount,
        queueLength: result.queueLength,
        order,
        durationMs,
        clientNonce,
      },
      'queue reordered',
    );

    const body = { ok: true, pinnedCount: result.pinnedCount, requestId };
    nonceCacheStore(clientNonce, 200, body);
    return jsonResponse(body, 200);
  } catch (err) {
    log.error(
      {
        action: 'queue_reorder_unexpected_error',
        err: err instanceof Error ? err.stack : String(err),
      },
      '/api/queue/reorder: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const { denied, auth } = await gateAuth(request);
  if (denied) return denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/queue/reorder', method: 'DELETE' });
  const actorId =
    auth.mode === 'authenticated' ? (auth.username ?? 'auth_disabled') : 'auth_disabled';

  try {
    const unpinned = jobRepo().clearManualOrder();
    emitQueueUpdated(log);
    log.info({ action: 'queue_manual_order_cleared', actorId, unpinned }, 'manual order cleared');
    return jsonResponse({ ok: true, unpinned, requestId }, 200);
  } catch (err) {
    log.error(
      {
        action: 'queue_manual_order_clear_failed',
        err: err instanceof Error ? err.stack : String(err),
      },
      '/api/queue/reorder DELETE: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}

// Non-fatal: the write already committed, a failed emit only delays the UI.
function emitQueueUpdated(log: { warn: (obj: object, msg: string) => void }): void {
  try {
    // One listActive() pass yields all three numbers (queue/counts).
    const counts = queueCountsSnapshot(jobRepo());
    engineEvents.emit({
      type: 'queue.updated',
      activeJobs: counts.activeJobs,
      pendingJobs: counts.pendingJobs,
      encodingJobs: counts.encodingJobs,
      // Legacy field, kept on the wire; always false here.
      paused: false,
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'queue.updated emit failed',
    );
  }
}
