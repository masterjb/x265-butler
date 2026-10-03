import crypto from 'node:crypto';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { buildClearCookieHeader, parseSessionCookie, verifySession } from '@/src/lib/auth/session';
import { getCachedAuthSetting } from '@/src/lib/auth/settings-cache';

// 05-01 Task 2 — POST /api/auth/logout. Idempotent — always 204 + clear cookie.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BODY_CAP_BYTES = 16 * 1024;

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
  const log = logger.child({ requestId, route: '/api/auth/logout' });

  const contentLengthRaw = req.headers.get('content-length');
  const contentLength = contentLengthRaw ? parseInt(contentLengthRaw, 10) : 0;
  if (Number.isFinite(contentLength) && contentLength > BODY_CAP_BYTES) {
    return emptyResponse(413);
  }

  // Optional best-effort log: if a valid cookie was present, log username.
  const cookieToken = parseSessionCookie(req.headers.get('cookie'));
  if (cookieToken) {
    const secret = getCachedAuthSetting('session_secret');
    if (secret) {
      const result = verifySession(cookieToken, secret);
      if (result.payload) {
        log.info({ event: 'auth_logout', username: result.payload.username }, 'auth logout');
      } else {
        log.info(
          { event: 'auth_logout', reason: result.reason },
          'auth logout (invalid session cookie)',
        );
      }
    }
  } else {
    log.info({ event: 'auth_logout', reason: 'no_cookie' }, 'auth logout (no cookie)');
  }

  return emptyResponse(204, { 'Set-Cookie': buildClearCookieHeader() });
}
