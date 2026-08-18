// 05-01: signed session cookie. HMAC-SHA256 over JSON payload via Node crypto.
// Phase 5 Plan 05-01 (Auth Backend Foundation) — audit M4 + S5.
//
// Cookie shape: <base64url-payload>.<base64url-signature>
// Payload: { userId, username, expiresAt } (epoch seconds)
//
// audit M4: signature comparison MUST use crypto.timingSafeEqual on equal-length
// Buffers — NEVER `===`, NEVER Buffer.compare. Length-mismatch returns null
// without invoking timingSafeEqual (which throws on length mismatch).
//
// audit S5: shouldRenew(payload, ttlSec, now) returns true when remaining-TTL <
// half. Caller (require-auth) re-issues a fresh cookie via signSession.
//
// SECURITY note: NO Secure cookie flag — LAN-only deployment per PROJECT.md.
// Future Edge-runtime auth would need JWKS pubkey signing — out of scope here
// (deferred D4).

import crypto from 'node:crypto';

export const SESSION_COOKIE_NAME = 'x265b_session';

export interface SessionPayload {
  userId: number;
  username: string;
  expiresAt: number; // epoch seconds
}

export type SessionInvalidReason = 'bad_format' | 'bad_signature' | 'expired';

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function base64urlDecode(s: string): Buffer | null {
  try {
    return Buffer.from(s, 'base64url');
  } catch {
    return null;
  }
}

function hmac(secret: string, payload: string): Buffer {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest();
}

export function signSession(payload: SessionPayload, secret: string): string {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = base64urlEncode(Buffer.from(payloadJson, 'utf8'));
  const sig = hmac(secret, payloadB64);
  const sigB64 = base64urlEncode(sig);
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a signed cookie token.
 * Returns the parsed payload on success, null on bad-format / bad-signature / expired.
 *
 * audit M4: HMAC compare uses crypto.timingSafeEqual. Length-mismatch
 * short-circuits to null without invoking timingSafeEqual (which throws).
 */
export function verifySession(
  token: string,
  secret: string,
  nowSec?: number,
): { payload: SessionPayload; reason: null } | { payload: null; reason: SessionInvalidReason } {
  if (!token || typeof token !== 'string') return { payload: null, reason: 'bad_format' };

  const parts = token.split('.');
  if (parts.length !== 2) return { payload: null, reason: 'bad_format' };

  const [payloadB64, providedSigB64] = parts;
  if (!payloadB64 || !providedSigB64) return { payload: null, reason: 'bad_format' };

  const expectedSig = hmac(secret, payloadB64);
  const providedSig = base64urlDecode(providedSigB64);
  if (!providedSig) return { payload: null, reason: 'bad_format' };

  // audit M4: crypto.timingSafeEqual requires equal-length buffers — guard first.
  if (providedSig.length !== expectedSig.length) {
    return { payload: null, reason: 'bad_signature' };
  }
  if (!crypto.timingSafeEqual(expectedSig, providedSig)) {
    return { payload: null, reason: 'bad_signature' };
  }

  const payloadBuf = base64urlDecode(payloadB64);
  if (!payloadBuf) return { payload: null, reason: 'bad_format' };
  let payload: unknown;
  try {
    payload = JSON.parse(payloadBuf.toString('utf8'));
  } catch {
    return { payload: null, reason: 'bad_format' };
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as SessionPayload).userId !== 'number' ||
    typeof (payload as SessionPayload).username !== 'string' ||
    typeof (payload as SessionPayload).expiresAt !== 'number'
  ) {
    return { payload: null, reason: 'bad_format' };
  }

  const now = nowSec ?? Math.floor(Date.now() / 1000);
  if ((payload as SessionPayload).expiresAt <= now) {
    return { payload: null, reason: 'expired' };
  }
  return { payload: payload as SessionPayload, reason: null };
}

/**
 * audit S5: rolling renewal — true when remaining TTL < ttlSec/2.
 * Caller re-issues cookie via signSession with fresh expiresAt.
 */
export function shouldRenew(payload: SessionPayload, ttlSec: number, nowSec: number): boolean {
  const remaining = payload.expiresAt - nowSec;
  return remaining > 0 && remaining < ttlSec / 2;
}

/**
 * Build a Set-Cookie header value. NO Secure flag (LAN-only deployment).
 * SameSite=Lax is the documented CSRF mitigation alongside JSON-only POST.
 */
export function buildSetCookieHeader(token: string, ttlSec: number): string {
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttlSec}`;
}

export function buildClearCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * Parse the session cookie value out of an HTTP Cookie header string.
 * Tolerant: multiple cookies, leading/trailing whitespace, extra =.
 * Returns the raw token string or null if not present.
 */
export function parseSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = trimmed.slice(0, eqIdx);
    if (name === SESSION_COOKIE_NAME) {
      return trimmed.slice(eqIdx + 1);
    }
  }
  return null;
}
