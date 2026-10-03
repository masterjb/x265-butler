// 05-02 T1: centralized 401-redirect interceptor + ?next= validator.
// Phase 5 Plan 05-02 (Auth UI) — audit M1 + AC-2 + AC-10.
//
// 05-02 contract: existing 02-04/03-04/04-02 fetches stay native — they get raw
// 401 JSON. authFetch is opt-in for new 05-02 components only. Carryover to
// global wrap is a 05-03 concern (per `<boundaries>` of 05-02-PLAN).

const ALLOWED_NEXT_PATHS = [
  '/library',
  '/dashboard',
  '/queue',
  '/trash',
  '/blocklist',
  '/logs',
  '/settings',
] as const;

const LOCALE_PREFIX_RE = /^\/(en|de)(?=\/|$)/;

let lastLogoutClickAt = 0;

export class AuthRedirectError extends Error {
  constructor() {
    super('auth_redirect');
    this.name = 'AuthRedirectError';
  }
}

/**
 * audit M1: harden ?next= against open-redirect attacks.
 * Returns the original raw value when whitelist match passes; null otherwise.
 */
export function validateNext(raw: string | string[] | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > 256) return null;
  if (/[\\:]/.test(raw)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f]/.test(raw)) return null;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.includes('..')) return null;
  // Strip locale prefix for whitelist match; preserve for return value.
  const stripped = raw.replace(LOCALE_PREFIX_RE, '') || '/';
  const matches = ALLOWED_NEXT_PATHS.some(
    (allowed) => stripped === allowed || stripped.startsWith(allowed + '/'),
  );
  return matches ? raw : null;
}

/**
 * Mark that the operator just clicked Logout. authFetch skips the 401-redirect
 * for the next 500ms so the deliberate logout flow doesn't bounce back.
 */
export function markLogoutClicked(): void {
  lastLogoutClickAt = Date.now();
}

function shouldSkipInterception(input: RequestInfo | URL): boolean {
  // Compute pathname from input.
  let pathname: string;
  try {
    if (typeof input === 'string') {
      pathname = input.startsWith('http') ? new URL(input).pathname : input;
    } else if (input instanceof URL) {
      pathname = input.pathname;
    } else {
      // Request object
      pathname = new URL(input.url, 'http://localhost').pathname;
    }
  } catch {
    return false;
  }
  // Self-gated paths — their 401 means actual login failure, not session expiry.
  if (pathname === '/api/health') return true;
  if (pathname.startsWith('/api/auth/')) return true;
  // 500ms post-logout grace.
  if (Date.now() - lastLogoutClickAt < 500) return true;
  return false;
}

/**
 * 05-02 audit AC-10 + M1: opt-in fetch wrapper that intercepts 401
 * `auth_required` responses and redirects to /login?expired=1&next=<encoded>.
 * Returns the raw Response when no interception fires.
 */
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const skip = shouldSkipInterception(input);
  const res = await fetch(input, init);
  if (skip) return res;
  if (res.status === 401) {
    // Clone so caller can still read body if interception doesn't fire.
    let errorCode: string | null = null;
    try {
      const cloned = res.clone();
      const body = (await cloned.json()) as { error_code?: string };
      errorCode = body?.error_code ?? null;
    } catch {
      errorCode = null;
    }
    if (errorCode === 'auth_required' && typeof window !== 'undefined') {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.replace(`/login?expired=1&next=${next}`);
      throw new AuthRedirectError();
    }
  }
  return res;
}
