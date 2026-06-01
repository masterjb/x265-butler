// Plan 05-12 (B3 Queue Reorder): PATCH /api/queue/reorder — operator submits
// an ordered list of jobIds; positions are rewritten 1..N inside one
// db.transaction() with status='queued' guard. Race-against-claimNext is
// resolved at TX time: any id no longer 'queued' rolls back the partial
// updates and returns 409 with conflictingJobIds.
//
// Authorization model: inherits 05-01 single-user contract — any
// authenticated session may reorder. NO per-user RBAC; multi-user role
// separation is deferred to post-v1.0 (Milestone 2). Audit trail captures
// `actorId` for SOC-2 reconstruction (S5 finding).
//
// Idempotent replay (AC-7 / M2): module-scoped LRU dedup cache keyed by
// clientNonce — max 1000 entries, 60s TTL. A network-retry of the same
// PATCH within 60s returns the cached response byte-identically without
// re-running the TX. Cache is per-process (lost on restart); surviving
// restart is NOT in scope — operator restart is rare + retries are
// operator-initiated, so a missed dedup would just re-apply an idempotent
// reorder.
//
// Audit log content (M1): every successful reorder + conflict + idempotent
// replay logs `previousOrder`, `newOrder`, `clientNonce` so SOC-2 audit can
// reconstruct exactly what changed. previousOrder is captured BEFORE the TX
// from the same peekQueued snapshot used for the unknown-id pre-check.

import crypto from 'node:crypto';
import { z } from 'zod';
import { jobRepo } from '@/src/lib/db';
import { engineEvents } from '@/src/lib/encode/events';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z
  .object({
    orderedJobIds: z.array(z.number().int().positive()).min(1).max(1000),
    // M2: clientNonce is REQUIRED per AC-7 idempotent replay contract.
    clientNonce: z.string().uuid(),
  })
  .strict();

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

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function PATCH(request: Request): Promise<Response> {
  const __auth = await requireAuth(request);
  if (!__auth.ok) return authGuard(__auth)!;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/queue/reorder' });
  const startedAt = Date.now();
  const actorId =
    __auth.mode === 'authenticated' ? (__auth.username ?? 'auth_disabled') : 'auth_disabled';

  // M6 16KB body cap — parity with cancel-all + blocklist endpoints.
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
      // targeted message (AC-4 reorder_invalid_nonce code).
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

    const { orderedJobIds, clientNonce } = parsed.data;

    // Duplicate-id rejection (route layer; repo does NOT defend).
    if (new Set(orderedJobIds).size !== orderedJobIds.length) {
      log.warn({ orderedJobIds }, 'reorder_duplicate_jobids');
      return jsonResponse({ error: 'reorder_duplicate_jobids', requestId }, 400);
    }

    // M2 / AC-7 idempotent replay — return cached response byte-identically.
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

    // Pre-check: capture previousOrder snapshot + reject unknown jobIds.
    // The pre-check is racy with claimNext; the inside-TX status guard in
    // reorderQueueTx is the authoritative safety net.
    const queuedNow = jobRepo().peekQueued(1000);
    const queuedIds = new Set(queuedNow.map((j) => j.id));
    const unknown = orderedJobIds.filter((id) => !queuedIds.has(id));
    if (unknown.length > 0) {
      log.warn(
        { unknownJobIds: unknown, clientNonce },
        'reorder_unknown_jobids — pre-check rejected',
      );
      return jsonResponse(
        { error: 'reorder_unknown_jobids', unknownJobIds: unknown, requestId },
        400,
      );
    }

    // M1 audit: capture previousOrder BEFORE TX from the same snapshot.
    const previousOrder = queuedNow.map((j) => j.id);

    const result = jobRepo().reorderQueueTx(orderedJobIds);
    const durationMs = Date.now() - startedAt;

    if ('conflict' in result) {
      log.warn(
        {
          action: 'queue_reorder_race_status_changed',
          actorId,
          conflictingJobIds: result.conflict,
          clientNonce,
          previousOrder,
          attemptedOrder: orderedJobIds,
          durationMs,
        },
        'reorder rolled back — race against claimNext',
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

    // Success path — emit queue.updated + audit log + cache + return 200.
    try {
      const activeJobs = jobRepo().listActive().length;
      const pendingJobs = jobRepo().countByStatus('queued');
      engineEvents.emit({
        type: 'queue.updated',
        activeJobs,
        pendingJobs,
        // 05-09: pause concept retired; field permanently false on the wire.
        paused: false,
      });
    } catch (err) {
      // Non-fatal — pino warn but still return 200 (TX already committed).
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'queue.updated emit failed',
      );
    }

    log.info(
      {
        action: 'queue_reordered',
        actorId,
        count: result.applied.length,
        durationMs,
        clientNonce,
        previousOrder,
        newOrder: orderedJobIds,
      },
      'queue reordered',
    );

    const body = { ok: true, applied: result.applied, requestId };
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
