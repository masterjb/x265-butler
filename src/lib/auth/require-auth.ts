// 05-01: requireAuth() helper for Route Handlers.
// Phase 5 Plan 05-01 (Auth Backend Foundation) — audit S5 rolling renewal.
//
// Every protected handler calls this at the top:
//   const auth = await requireAuth(req);
//   const denied = authGuard(auth);
//   if (denied) return denied;
//   // ... handler body ...
//   return withRenewCookie(response, auth);
//
// Off-by-default contract: when auth_enabled='false' (factory default) the
// helper returns immediately with mode='disabled' — zero DB writes, no session
// lookup, no rate-limiter touch. Existing 1146 tests stay green.
//
// audit S5: rolling renewal — when remaining session TTL < 50%, the helper
// returns a renewCookie field; handler pipes it via withRenewCookie. Renewal
// is INTENTIONALLY skipped on SSE responses (deferred to 05-02).

import { logger } from '@/src/lib/logger';
import {
  buildSetCookieHeader,
  parseSessionCookie,
  shouldRenew,
  signSession,
  verifySession,
} from '@/src/lib/auth/session';
import { getCachedAuthSetting } from '@/src/lib/auth/settings-cache';

export type AuthDecision =
  | {
      ok: true;
      mode: 'disabled' | 'authenticated';
      username: string | null;
      renewCookie?: string;
    }
  | { ok: false; status: 401; body: { error_code: 'auth_required'; requestId?: string } };

export async function requireAuth(req: Request): Promise<AuthDecision> {
  const enabled = getCachedAuthSetting('auth_enabled') === 'true';
  if (!enabled) {
    return { ok: true, mode: 'disabled', username: null };
  }

  const cookieToken = parseSessionCookie(req.headers.get('cookie'));
  if (!cookieToken) {
    return { ok: false, status: 401, body: { error_code: 'auth_required' } };
  }

  const secret = getCachedAuthSetting('session_secret');
  if (!secret) {
    // Pathological state: auth_enabled='true' without session_secret. Treat as
    // anonymous so the operator can re-run /api/auth/setup or auth-reset.ts.
    logger.warn(
      { event: 'auth_session_invalid', reason: 'missing_secret' },
      'auth_enabled=true but session_secret empty — treating request as anonymous',
    );
    return { ok: false, status: 401, body: { error_code: 'auth_required' } };
  }

  const result = verifySession(cookieToken, secret);
  if (!result.payload) {
    logger.warn({ event: 'auth_session_invalid', reason: result.reason }, 'auth session invalid');
    return { ok: false, status: 401, body: { error_code: 'auth_required' } };
  }

  // audit S5: rolling renewal.
  let renewCookie: string | undefined;
  const ttlSec = parseInt(getCachedAuthSetting('session_ttl_seconds') || '604800', 10);
  const nowSec = Math.floor(Date.now() / 1000);
  if (shouldRenew(result.payload, ttlSec, nowSec)) {
    const newToken = signSession(
      {
        userId: result.payload.userId,
        username: result.payload.username,
        expiresAt: nowSec + ttlSec,
      },
      secret,
    );
    renewCookie = buildSetCookieHeader(newToken, ttlSec);
    logger.debug(
      { event: 'auth_session_renewed', username: result.payload.username },
      'session cookie rolled forward',
    );
  }

  return {
    ok: true,
    mode: 'authenticated',
    username: result.payload.username,
    renewCookie,
  };
}

/**
 * Convert an AuthDecision to a 401 Response when denied. Returns null when ok.
 * Caller pattern:
 *   const denied = authGuard(auth);
 *   if (denied) return denied;
 */
export function authGuard(decision: AuthDecision): Response | null {
  if (decision.ok) return null;
  return new Response(JSON.stringify(decision.body), {
    status: decision.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * audit S5: pipe rolling-renewal Set-Cookie into a successful response.
 * No-op when no renewal happened (decision.renewCookie undefined or disabled mode).
 */
export function withRenewCookie(res: Response, decision: AuthDecision): Response {
  if (!decision.ok || !decision.renewCookie) return res;
  res.headers.append('Set-Cookie', decision.renewCookie);
  return res;
}
