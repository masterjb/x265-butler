// 05-02 T2 audit S4: client-safe password complexity validation.
// Extracted from password.ts so Client Components (setup-form) can import
// without pulling node:crypto via tree-shake fail.
//
// password.ts re-exports this for server-side use — single source of truth.

export interface PasswordComplexityResult {
  ok: boolean;
  error_code?: 'password_too_short' | 'password_too_long' | 'password_too_weak';
}

/**
 * audit S2: password complexity rules.
 * Reject all-numeric, all-same-char, single-character-class.
 * Enforced AFTER zod min(12) so error_code reflects the more specific cause.
 */
export function validatePasswordComplexity(plain: string): PasswordComplexityResult {
  if (typeof plain !== 'string') return { ok: false, error_code: 'password_too_short' };
  if (plain.length < 12) return { ok: false, error_code: 'password_too_short' };
  if (plain.length > 256) return { ok: false, error_code: 'password_too_long' };

  // All-numeric (e.g. '123456789012')
  if (/^\d+$/.test(plain)) return { ok: false, error_code: 'password_too_weak' };

  // All-same-char (e.g. 'aaaaaaaaaaaa')
  if (/^(.)\1+$/.test(plain)) return { ok: false, error_code: 'password_too_weak' };

  // Single character class — must contain at least 2 of: letters, digits, specials.
  const hasLetter = /[a-zA-Z]/.test(plain);
  const hasDigit = /\d/.test(plain);
  const hasSpecial = /[^a-zA-Z0-9]/.test(plain);
  const classCount = Number(hasLetter) + Number(hasDigit) + Number(hasSpecial);
  if (classCount < 2) return { ok: false, error_code: 'password_too_weak' };

  return { ok: true };
}
