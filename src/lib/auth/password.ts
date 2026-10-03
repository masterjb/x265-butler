// 05-01: password hashing + verification + complexity.
// Phase 5 Plan 05-01 (Auth Backend Foundation) — audit M5 + S1 + S2 + S13.
//
// CRITICAL audit M5 (bcrypt 72-byte truncation safety):
// bcrypt silently truncates inputs past 72 bytes. With pepper concatenation
// (S1) the input length grows = silent password truncation past byte 72.
// Mitigation: pre-hash via HMAC-SHA256(pepper, plain) → base64url 44 bytes
// well under the 72-byte limit. Single source of truth via prepareForBcrypt().
//
// Constant-time intent (audit S10): caller without a user MUST run a dummy
// verifyPassword against DUMMY_BCRYPT_HASH so timing of hit/miss is flat.
// Test: tests/auth/password.test.ts asserts p95 timing-delta ≤50ms on 1000 trials.

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export const BCRYPT_COST_DEFAULT = 12;
export const BCRYPT_COST_MIN = 10;
export const BCRYPT_COST_MAX = 14;

// Precomputed bcryptjs hash of literal 'x265-butler-dummy-blocked' at cost=12.
// Used to keep verifyPassword timing flat when the user is not found.
// Re-generated at module-load if absent — but we hard-code one to ensure
// timing is identical across processes (no first-load drift).
//
// Verified offline:
//   bcryptjs.hashSync('x265-butler-dummy-blocked', 12)
//   → '$2a$12$tNrqPrdotbJVQfNXm9uS5OumHgHtSxPa.QmH8MMuaTsaEYn/DIORK'
export const DUMMY_BCRYPT_HASH = '$2a$12$tNrqPrdotbJVQfNXm9uS5OumHgHtSxPa.QmH8MMuaTsaEYn/DIORK';

// 05-02 T2 audit S4: complexity-validation re-exported from a node:crypto-free
// module so Client Components (setup-form) can import the same rule set
// without pulling the server-only crypto namespace via tree-shake fail.
export { validatePasswordComplexity, type PasswordComplexityResult } from './password-complexity';

/**
 * audit M5: pre-hash via HMAC-SHA256(pepper, plain) → base64url (44 bytes).
 * This is the SINGLE source of truth for the byte sequence handed to bcrypt;
 * hashPassword + verifyPassword both call this so the same plaintext + pepper
 * always produce the same bcrypt-input bytes.
 *
 * Empty pepper is allowed (factory state before /api/auth/setup completes;
 * verifyPassword on missing-user path passes pepper='' alongside DUMMY_BCRYPT_HASH).
 */
export function prepareForBcrypt(plain: string, pepper: string): string {
  return crypto.createHmac('sha256', pepper).update(plain, 'utf8').digest('base64url');
}

export async function hashPassword(plain: string, pepper: string, cost: number): Promise<string> {
  if (cost < BCRYPT_COST_MIN || cost > BCRYPT_COST_MAX) {
    throw new Error(`bcrypt_cost ${cost} out of range [${BCRYPT_COST_MIN}, ${BCRYPT_COST_MAX}]`);
  }
  const prepared = prepareForBcrypt(plain, pepper);
  return bcrypt.hash(prepared, cost);
}

export async function verifyPassword(
  plain: string,
  pepper: string,
  hash: string,
): Promise<boolean> {
  // bcryptjs.compare returns false (not throws) on malformed hashes — safe.
  const prepared = prepareForBcrypt(plain, pepper);
  return bcrypt.compare(prepared, hash);
}

// validatePasswordComplexity moved to password-complexity.ts (audit S4 client-safe).
// Re-exported above for server-side callers that already import from this module.

/**
 * Clamp operator-supplied bcrypt_cost setting to safe range.
 * Out-of-range values fall back to default rather than throwing — defends
 * against operator bricking auth via malformed setting.
 */
export function clampBcryptCost(raw: string | undefined): number {
  if (!raw) return BCRYPT_COST_DEFAULT;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return BCRYPT_COST_DEFAULT;
  if (parsed < BCRYPT_COST_MIN) return BCRYPT_COST_MIN;
  if (parsed > BCRYPT_COST_MAX) return BCRYPT_COST_MAX;
  return parsed;
}
