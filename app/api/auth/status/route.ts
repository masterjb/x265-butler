import crypto from 'node:crypto';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { parseSessionCookie, verifySession } from '@/src/lib/auth/session';
import { getCachedAuthSetting } from '@/src/lib/auth/settings-cache';

// 05-01 Task 2 — GET /api/auth/status.
//
// Always 200; never Set-Cookie; never DB write on hot path.
// AC-5: p95 <50ms (settings-cache hits, no per-request bcrypt).

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function GET(req: Request): Promise<Response> {
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse(
      { authEnabled: false, setupCompleted: false, authenticated: false, username: null },
      200,
    );
  }

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/auth/status' });

  const authEnabled = getCachedAuthSetting('auth_enabled') === 'true';
  const setupCompleted = getCachedAuthSetting('auth_setup_completed') === 'true';

  if (!authEnabled) {
    return jsonResponse(
      { authEnabled: false, setupCompleted, authenticated: false, username: null, requestId },
      200,
    );
  }

  const cookieToken = parseSessionCookie(req.headers.get('cookie'));
  if (!cookieToken) {
    return jsonResponse(
      { authEnabled: true, setupCompleted, authenticated: false, username: null, requestId },
      200,
    );
  }

  const secret = getCachedAuthSetting('session_secret');
  if (!secret) {
    return jsonResponse(
      { authEnabled: true, setupCompleted, authenticated: false, username: null, requestId },
      200,
    );
  }

  const result = verifySession(cookieToken, secret);
  if (!result.payload) {
    log.warn(
      { event: 'auth_session_invalid', reason: result.reason },
      'auth session invalid on status check',
    );
    return jsonResponse(
      { authEnabled: true, setupCompleted, authenticated: false, username: null, requestId },
      200,
    );
  }

  return jsonResponse(
    {
      authEnabled: true,
      setupCompleted,
      authenticated: true,
      username: result.payload.username,
      requestId,
    },
    200,
  );
}
