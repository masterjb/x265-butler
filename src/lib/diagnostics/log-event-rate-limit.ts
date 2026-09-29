// 22-01 IMP-4 audit-M1: per-IP rate-limit + origin gate for
// /api/diagnostics/log-event.
//
// Closes the unauthenticated ring-buffer-DoS vector that came with the
// webVitalCaptured client-emit (auth is operator-only; pre-auth pages can hit
// /api/diagnostics/log-event in the auth_enabled=false path). RATE_LIMIT_PER_MIN
// rolling-60s-window per source IP. Origin gate accepts same-origin (matched
// against `host` header) OR ALLOWED_ORIGINS env-allowlist. Missing Origin
// header is permitted (legacy non-browser + same-origin fetches).
//
// Module-local in-process Map<ip,bucket>. PM2-cluster mode = per-worker
// buckets (single-container x265-butler scope; persistent SQLite pivot stays
// M3-deferred per [[project_m3_backlog_p21_overflow]]).

export const RATE_LIMIT_PER_MIN = 60;
const WINDOW_MS = 60_000;

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

export function ipFor(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}

export function checkRateLimit(req: Request): { ok: true } | { ok: false; retryAfterSec: number } {
  const ip = ipFor(req);
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    buckets.set(ip, { count: 1, windowStart: now });
    return { ok: true };
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_PER_MIN) {
    return {
      ok: false,
      retryAfterSec: Math.ceil((WINDOW_MS - (now - bucket.windowStart)) / 1000),
    };
  }
  return { ok: true };
}

export function checkOrigin(req: Request): { ok: true } | { ok: false } {
  const origin = req.headers.get('origin');
  if (!origin) return { ok: true };
  const host = req.headers.get('host');
  const allowed = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (host && (origin === `http://${host}` || origin === `https://${host}`)) {
    return { ok: true };
  }
  if (allowed.includes(origin)) return { ok: true };
  return { ok: false };
}

// Test-only escape hatch — clear in-memory buckets between cases.
export function _resetBuckets(): void {
  buckets.clear();
}
