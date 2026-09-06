/*
 * 05-01 Task 1: src/lib/auth/session.ts.
 * Covers M4 (timingSafeEqual), S5 (rolling renewal threshold).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import nodeCrypto from 'node:crypto';
import {
  SESSION_COOKIE_NAME,
  buildClearCookieHeader,
  buildSetCookieHeader,
  parseSessionCookie,
  shouldRenew,
  signSession,
  verifySession,
} from '@/src/lib/auth/session';

const SECRET = 'a'.repeat(64);
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 1;

describe('signSession + verifySession — happy path', () => {
  it('test_signSession_when_called_then_returns_two_dot_segments', () => {
    const token = signSession({ userId: 1, username: 'admin', expiresAt: FUTURE }, SECRET);
    expect(token.split('.').length).toBe(2);
  });

  it('test_verifySession_when_correctly_signed_then_returns_payload', () => {
    const token = signSession({ userId: 1, username: 'admin', expiresAt: FUTURE }, SECRET);
    const result = verifySession(token, SECRET);
    expect(result.payload).toEqual({ userId: 1, username: 'admin', expiresAt: FUTURE });
    expect(result.reason).toBeNull();
  });
});

describe('verifySession — failure modes', () => {
  it('test_verifySession_when_empty_token_then_bad_format', () => {
    expect(verifySession('', SECRET).reason).toBe('bad_format');
  });

  it('test_verifySession_when_no_dot_then_bad_format', () => {
    expect(verifySession('not-a-cookie', SECRET).reason).toBe('bad_format');
  });

  it('test_verifySession_when_payload_not_json_then_bad_format', () => {
    // Sign a non-JSON payload manually so signature passes; JSON.parse fails.
    const payloadB64 = Buffer.from('not-json-content', 'utf8').toString('base64url');
    const sig = nodeCrypto
      .createHmac('sha256', SECRET)
      .update(payloadB64, 'utf8')
      .digest()
      .toString('base64url');
    const token = `${payloadB64}.${sig}`;
    expect(verifySession(token, SECRET).reason).toBe('bad_format');
  });

  it('test_verifySession_when_signature_mutated_one_byte_then_bad_signature', () => {
    const token = signSession({ userId: 1, username: 'admin', expiresAt: FUTURE }, SECRET);
    const [p, sig] = token.split('.');
    // Flip FIRST char (base64url's last char carries spare bits for SHA-256
    // length — flipping there can decode to identical Buffer; first char is
    // always meaningful).
    const firstChar = sig[0];
    const tampered = `${p}.${firstChar === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
    expect(verifySession(tampered, SECRET).reason).toBe('bad_signature');
  });

  it('test_verifySession_when_signature_length_differs_then_bad_signature', () => {
    const token = signSession({ userId: 1, username: 'admin', expiresAt: FUTURE }, SECRET);
    const [p] = token.split('.');
    const tampered = `${p}.AAAA`;
    expect(verifySession(tampered, SECRET).reason).toBe('bad_signature');
  });

  it('test_verifySession_when_expired_then_expired', () => {
    const token = signSession({ userId: 1, username: 'admin', expiresAt: PAST }, SECRET);
    const result = verifySession(token, SECRET);
    expect(result.reason).toBe('expired');
    expect(result.payload).toBeNull();
  });

  it('test_verifySession_when_wrong_secret_then_bad_signature', () => {
    const token = signSession({ userId: 1, username: 'admin', expiresAt: FUTURE }, SECRET);
    const result = verifySession(token, 'b'.repeat(64));
    expect(result.reason).toBe('bad_signature');
  });
});

describe('verifySession — audit M4 timingSafeEqual lockdown', () => {
  it('test_session_module_uses_crypto_timingSafeEqual', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src', 'lib', 'auth', 'session.ts'),
      'utf8',
    );
    expect(src).toContain('crypto.timingSafeEqual');
  });

  it('test_session_module_does_not_use_strict_equals_on_signatures', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src', 'lib', 'auth', 'session.ts'),
      'utf8',
    );
    // Strip block + line comments before scanning so banned-pattern doc-strings
    // don't trip the gate. After stripping, code paths must not use === or
    // Buffer.compare on signature variables.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(stripped).not.toMatch(/(provided|expected)Sig\s*===\s*(provided|expected)Sig/);
    expect(stripped).not.toMatch(/Buffer\.compare\s*\(/);
  });
});

describe('shouldRenew — audit S5', () => {
  const TTL = 100;
  it('test_shouldRenew_when_remaining_above_half_then_false', () => {
    expect(shouldRenew({ userId: 1, username: 'a', expiresAt: 1100 }, TTL, 1000)).toBe(false);
  });

  it('test_shouldRenew_when_remaining_at_half_then_false', () => {
    expect(shouldRenew({ userId: 1, username: 'a', expiresAt: 1050 }, TTL, 1000)).toBe(false);
  });

  it('test_shouldRenew_when_remaining_under_half_then_true', () => {
    expect(shouldRenew({ userId: 1, username: 'a', expiresAt: 1049 }, TTL, 1000)).toBe(true);
  });

  it('test_shouldRenew_when_already_expired_then_false', () => {
    expect(shouldRenew({ userId: 1, username: 'a', expiresAt: 999 }, TTL, 1000)).toBe(false);
  });
});

describe('Set-Cookie helpers', () => {
  it('test_buildSetCookieHeader_when_called_then_includes_HttpOnly_SameSite_Lax_and_no_Secure', () => {
    const header = buildSetCookieHeader('payload.sig', 604_800);
    expect(header).toContain(`${SESSION_COOKIE_NAME}=payload.sig`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=604800');
    expect(header).not.toContain('Secure');
  });

  it('test_buildClearCookieHeader_when_called_then_max_age_zero', () => {
    const header = buildClearCookieHeader();
    expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(header).toContain('Max-Age=0');
  });
});

describe('parseSessionCookie', () => {
  it('test_parseSessionCookie_when_null_header_then_null', () => {
    expect(parseSessionCookie(null)).toBeNull();
  });

  it('test_parseSessionCookie_when_other_cookies_present_then_extracts_session', () => {
    const header = `foo=bar; ${SESSION_COOKIE_NAME}=abc.def; baz=qux`;
    expect(parseSessionCookie(header)).toBe('abc.def');
  });

  it('test_parseSessionCookie_when_session_cookie_absent_then_null', () => {
    expect(parseSessionCookie('foo=bar')).toBeNull();
  });

  it('test_parseSessionCookie_when_token_contains_equals_then_preserves_them', () => {
    const header = `${SESSION_COOKIE_NAME}=a==b==`;
    expect(parseSessionCookie(header)).toBe('a==b==');
  });
});
