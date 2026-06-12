// 15-01: cross-cutting helpers for /api/storage/* routes.
//
// Centralizes the audit-required envelope (computedAt + dataAsOf + requestId),
// uniform error-shape (M2: { error, message, requestId } — no stack-leak),
// structured pino-logging events (M1: storage_query_executed +
// storage_query_slow + storage_share_id_unknown), and the auth gate (M2:
// 401 body shape distinct from the upstream `authGuard` default).
//
// All 5 storage routes consume this module; new endpoints in 15-02 inherit
// the same envelope by reuse.

import crypto from 'node:crypto';
import type { Logger } from 'pino';
import { logger } from '@/src/lib/logger';
import { requireAuth } from '@/src/lib/auth/require-auth';

export type StorageErrorCode = 'unauthorized' | 'invalid_query' | 'internal_error';

export interface StorageRequestContext {
  requestId: string;
  // pino child-logger with requestId + route binding pre-applied. Carry the
  // 14-02 SR3 log-correlation pattern.
  log: Logger;
  computedAt: string;
}

const SLOW_QUERY_THRESHOLD_MS = 1000;

export function buildStorageContext(endpoint: string): StorageRequestContext {
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: `/api/storage/${endpoint}` });
  // Pre-repo timestamp anchors the response.computedAt — operator audit-trail
  // reads "when did THIS response shape compute?", not "when did SQL finish?".
  const computedAt = new Date().toISOString();
  return { requestId, log, computedAt };
}

export function errorBody(
  code: StorageErrorCode,
  message: string,
  requestId: string,
): { error: StorageErrorCode; message: string; requestId: string } {
  return { error: code, message, requestId };
}

export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Auth-gate adapter. requireAuth returns a generic decision shape (login flow
 * default); the storage routes need the uniform { error, message, requestId }
 * body per M2. When auth is disabled the helper returns null and the handler
 * proceeds (single-tenant exposure per SR6 / PROJECT.md auth-mode-default).
 */
export async function authGate(
  request: Request,
  ctx: StorageRequestContext,
): Promise<Response | null> {
  const decision = await requireAuth(request);
  if (decision.ok) return null;
  return jsonResponse(
    errorBody('unauthorized', 'authentication required', ctx.requestId),
    decision.status,
  );
}

export interface QueryExecutedExtras {
  share: 'all' | number;
  depth?: number;
  rowCount: number;
}

export function logQueryExecuted(
  ctx: StorageRequestContext,
  endpoint: string,
  extras: QueryExecutedExtras,
  startedAt: number,
): void {
  const duration_ms = Date.now() - startedAt;
  ctx.log.info(
    {
      endpoint,
      share: extras.share,
      depth: extras.depth,
      duration_ms,
      rowCount: extras.rowCount,
      requestId: ctx.requestId,
    },
    'storage_query_executed',
  );
  if (duration_ms > SLOW_QUERY_THRESHOLD_MS) {
    ctx.log.warn(
      {
        endpoint,
        duration_ms,
        threshold: SLOW_QUERY_THRESHOLD_MS,
        requestId: ctx.requestId,
      },
      'storage_query_slow',
    );
  }
}

export function logShareUnknown(
  ctx: StorageRequestContext,
  endpoint: string,
  requestedShareId: number,
  knownShareIds: number[],
): void {
  ctx.log.warn(
    {
      endpoint,
      requestedShareId,
      knownShareIds,
      requestId: ctx.requestId,
    },
    'storage_share_id_unknown',
  );
}

/**
 * Convenience: convert a zod safeParse-failure into the uniform 400 body.
 */
export function invalidQueryResponse(ctx: StorageRequestContext, message: string): Response {
  return jsonResponse(errorBody('invalid_query', message, ctx.requestId), 400);
}
