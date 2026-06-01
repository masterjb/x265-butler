import crypto from 'node:crypto';
import { getDb, settingRepo, userRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';
import { invalidateAuthSettingsCache } from '@/src/lib/auth/settings-cache';
import { hashIp, extractIp, clearAll as clearRateLimitBuckets } from '@/src/lib/auth/rate-limit';
import { buildClearCookieHeader } from '@/src/lib/auth/session';

// 05-02 Task 2 — POST /api/auth/disable-and-delete.
// Phase 5 Plan 05-02 (Auth UI) — AC-8 + audit M3 + M4.
//
// Operator-driven nuclear path: disables auth + clears session_secret +
// deletes user row in a single transaction. Idempotent on userCount=0 path
// (matches 04-02 blocklist DELETE semantics).
//
// audit M4: Content-Type: application/json gate prevents form-CSRF.
// audit M3: settings reset runs even on userCount=0 (defends against
// inconsistent state from manual SQL edit).

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BODY_CAP_BYTES = 16 * 1024;

function jsonResponse(body: unknown, status: number, extraHeaders?: HeadersInit): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((v, k) => headers.append(k, v));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function emptyResponse(status: number, extraHeaders?: HeadersInit): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((v, k) => headers.append(k, v));
  }
  return new Response(null, { status, headers });
}

export async function POST(req: Request): Promise<Response> {
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return emptyResponse(204);
  }

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/auth/disable-and-delete' });

  // audit M4: 415 Content-Type gate (CSRF defense — forms can't set this).
  const contentType = (req.headers.get('content-type') ?? '').trim().toLowerCase();
  if (!contentType.startsWith('application/json')) {
    log.warn({ contentType }, 'unsupported content-type');
    return jsonResponse({ error_code: 'invalid_content_type', requestId }, 415);
  }

  const contentLengthRaw = req.headers.get('content-length');
  const contentLength = contentLengthRaw ? parseInt(contentLengthRaw, 10) : 0;
  if (Number.isFinite(contentLength) && contentLength > BODY_CAP_BYTES) {
    return jsonResponse({ error_code: 'body_too_large', requestId }, 413);
  }

  // Strict empty-body check (carry-forward 04-03 S1).
  try {
    const text = await req.text();
    if (text.trim().length > 0 && text.trim() !== '{}') {
      log.warn({ bodyLen: text.length }, 'unexpected body — disable-and-delete takes empty body');
      return jsonResponse({ error_code: 'unexpected_body', requestId }, 400);
    }
  } catch (err) {
    return jsonResponse(
      {
        error_code: 'invalid_body',
        details: err instanceof Error ? err.message : 'unknown',
        requestId,
      },
      400,
    );
  }

  // requireAuth gate — operator must be logged in to delete themselves.
  const auth = await requireAuth(req);
  const denied = authGuard(auth);
  if (denied) return denied;
  const username = auth.ok && auth.mode === 'authenticated' ? auth.username : null;

  // Best-effort IP for audit log (no rate-limit on this endpoint — D1 deferred).
  const ipHash = (() => {
    try {
      const ip = extractIp(req, false);
      return hashIp(ip);
    } catch {
      return 'unknown';
    }
  })();

  try {
    const repo = settingRepo();
    const userR = userRepo();
    const db = getDb();

    const userCount = userR.count();

    if (userCount === 0) {
      // audit M3: idempotent path still resets inconsistent settings.
      const keysReset: string[] = [];
      const heal = db.transaction(() => {
        if (repo.get('auth_enabled') !== 'false') {
          repo.set('auth_enabled', 'false');
          keysReset.push('auth_enabled');
        }
        if (repo.get('auth_setup_completed') !== 'false') {
          repo.set('auth_setup_completed', 'false');
          keysReset.push('auth_setup_completed');
        }
        if (repo.get('session_secret') !== '') {
          repo.set('session_secret', '');
          keysReset.push('session_secret');
        }
      });
      heal();
      invalidateAuthSettingsCache();
      clearRateLimitBuckets();
      if (keysReset.length > 0) {
        log.warn(
          {
            event: 'auth_inconsistent_state_healed',
            keysReset,
            requestId,
            username,
            ip_hash: ipHash,
          },
          'auth inconsistent state healed via disable-and-delete idempotent path',
        );
      }
      return jsonResponse({ already: true, requestId }, 200, {
        'Set-Cookie': buildClearCookieHeader(),
      });
    }

    // userCount >= 1: full teardown.
    let deletedRowCount = 0;
    const teardown = db.transaction(() => {
      repo.set('auth_enabled', 'false');
      repo.set('auth_setup_completed', 'false');
      repo.set('session_secret', '');
      deletedRowCount = userR.deleteAll();
    });
    teardown();

    invalidateAuthSettingsCache();
    clearRateLimitBuckets();

    log.warn(
      {
        event: 'auth_disabled_with_user_delete',
        requestId,
        username,
        ip_hash: ipHash,
        deletedRowCount,
      },
      'auth disabled and user deleted',
    );

    return emptyResponse(204, { 'Set-Cookie': buildClearCookieHeader() });
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/auth/disable-and-delete: unexpected error',
    );
    return jsonResponse({ error_code: 'internal_error', requestId }, 500);
  }
}
