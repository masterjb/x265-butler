import crypto from 'node:crypto';
import { z } from 'zod';
import { userRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { DUMMY_BCRYPT_HASH, verifyPassword } from '@/src/lib/auth/password';
import { buildSetCookieHeader, signSession } from '@/src/lib/auth/session';
import { check, extractIp, hashIp, recordFailure, recordSuccess } from '@/src/lib/auth/rate-limit';
import { getCachedAuthSetting } from '@/src/lib/auth/settings-cache';
import { jsonResponse } from '@/src/lib/api/json-response';

// 05-01 Task 2 — POST /api/auth/login.
//
// audit M2: extractIp(req, trustProxyXff) default-secure (XFF ignored unless explicit).
// audit S4: auth_rate_limit_hit pino warn on 429.
// audit S10: dummy-bcrypt path on missing user keeps timing flat (constant-time intent).
// audit S1: pepper-mixed via verifyPassword(plain, pepper, hash).

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BODY_CAP_BYTES = 16 * 1024;

const bodySchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

export async function POST(req: Request): Promise<Response> {
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse({ skipped: true, reason: 'build-time-skip', requestId: 'build' }, 200);
  }

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/auth/login' });

  const ct = req.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('application/json')) {
    return jsonResponse({ error_code: 'unsupported_media_type', requestId }, 415);
  }

  const contentLengthRaw = req.headers.get('content-length');
  const contentLength = contentLengthRaw ? parseInt(contentLengthRaw, 10) : 0;
  if (Number.isFinite(contentLength) && contentLength > BODY_CAP_BYTES) {
    log.warn(
      { event: 'auth_login_body_too_large', contentLength, cap: BODY_CAP_BYTES },
      'POST body exceeds size cap',
    );
    return jsonResponse({ error_code: 'body_too_large', requestId }, 413);
  }

  // Extract IP BEFORE body parse so rate-limit hits even on malformed bodies.
  const trustProxyXff = getCachedAuthSetting('auth_trust_proxy_xff') === 'true';
  const ip = extractIp(req, trustProxyXff);

  // audit M1 + S4: rate-limit gate first.
  const decision = check(ip);
  if (!decision.allowed) {
    log.warn(
      {
        event: 'auth_rate_limit_hit',
        ip_hash: hashIp(ip),
        attempt_count: decision.attemptCount,
        retry_after_sec: decision.retryAfterSec,
      },
      'auth login rate-limit hit — rejecting',
    );
    return jsonResponse({ error_code: 'rate_limit_exceeded', requestId }, 429, {
      'Retry-After': String(decision.retryAfterSec),
    });
  }

  let body: unknown;
  try {
    const text = await req.text();
    body = text === '' ? {} : JSON.parse(text);
  } catch {
    return jsonResponse({ error_code: 'invalid_json', requestId }, 400);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(
      { error_code: 'invalid_body', details: parsed.error.issues, requestId },
      400,
    );
  }

  const { username, password } = parsed.data;
  const pepper = getCachedAuthSetting('password_pepper');
  const ttlSec = parseInt(getCachedAuthSetting('session_ttl_seconds') || '604800', 10);
  const sessionSecret = getCachedAuthSetting('session_secret');

  const user = userRepo().findByUsername(username);

  // audit S10: dummy-bcrypt branch on missing user.
  if (!user) {
    // Run a real bcrypt compare against the dummy hash so timing matches the
    // real path. Discard the boolean — answer is always 401.
    await verifyPassword(password, pepper, DUMMY_BCRYPT_HASH);
    recordFailure(ip);
    log.warn(
      { event: 'auth_login_failure', ip_hash: hashIp(ip), reason: 'unknown_username' },
      'auth login failure — unknown username',
    );
    return jsonResponse({ error_code: 'invalid_credentials', requestId }, 401);
  }

  const ok = await verifyPassword(password, pepper, user.password_hash);
  if (!ok) {
    recordFailure(ip);
    log.warn(
      {
        event: 'auth_login_failure',
        ip_hash: hashIp(ip),
        username,
        reason: 'wrong_password',
      },
      'auth login failure — wrong password',
    );
    return jsonResponse({ error_code: 'invalid_credentials', requestId }, 401);
  }

  // Success path.
  recordSuccess(ip);
  const nowSec = Math.floor(Date.now() / 1000);
  userRepo().setLastLoginAt(user.id, nowSec);

  if (!sessionSecret) {
    // Pathological state: auth_enabled='true' but session_secret missing.
    // This should never happen post-setup; if it does, refuse with 500.
    log.error(
      { event: 'auth_session_secret_missing' },
      'session_secret empty — auth misconfigured',
    );
    return jsonResponse({ error_code: 'internal_error', requestId }, 500);
  }
  const token = signSession(
    { userId: user.id, username: user.username, expiresAt: nowSec + ttlSec },
    sessionSecret,
  );
  log.info(
    { event: 'auth_login_success', ip_hash: hashIp(ip), username: user.username },
    'auth login success',
  );
  return jsonResponse({ username: user.username, requestId }, 200, {
    'Set-Cookie': buildSetCookieHeader(token, ttlSec),
  });
}
