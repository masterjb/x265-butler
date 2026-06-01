// Phase 21 Plan 21-01 — GET /api/diagnostics — structured JSON diagnostics payload.
// Phase 22 Plan 22-00 IMP-11 audit-fix:SR2 — ?refresh=1 clears container-image
// boot-cache, rate-limited per remote-IP (10s window, 1000-entry soft-cap).
//
// Auth-mirror gate: 401 when setting.auth_enabled='true' + no valid session.

import { authGuard, requireAuth, withRenewCookie } from '@/src/lib/auth/require-auth';
import { assembleDiagnostics } from '@/src/lib/diagnostics/aggregator';
import { clearContainerImageCache } from '@/src/lib/diagnostics/container-image-probe';
import { clearCpuCapabilityCache } from '@/src/lib/diagnostics/cpu-capability';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 22-00 audit-fix:SR2 — module-scope rate-limit state. Map[ip → last-allowed-ts-ms].
// 10s window per IP, 1000-entry soft-cap with FIFO eviction. NOT auth — anti-DDoS
// for self-hosted container-edge trust-boundary (operator-tool semantics).
const REFRESH_RATE_LIMIT_WINDOW_MS = 10_000;
const REFRESH_RATE_LIMIT_MAX_ENTRIES = 1000;
const refreshRateLimit = new Map<string, number>();

/** Test-only: clear the rate-limit map. */
export function _resetRefreshRateLimitForTesting(): void {
  if (process.env.NODE_ENV === 'production' && process.env.VITEST !== 'true') return;
  refreshRateLimit.clear();
}

function extractRemoteIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}

function checkRefreshRateLimit(
  ip: string,
  now: number,
): { allowed: true } | { allowed: false; retryAfter: number } {
  const last = refreshRateLimit.get(ip);
  if (last !== undefined && now - last < REFRESH_RATE_LIMIT_WINDOW_MS) {
    return {
      allowed: false,
      retryAfter: Math.ceil((REFRESH_RATE_LIMIT_WINDOW_MS - (now - last)) / 1000),
    };
  }
  // Soft-cap FIFO eviction (Map preserves insertion order).
  if (refreshRateLimit.size >= REFRESH_RATE_LIMIT_MAX_ENTRIES) {
    const firstKey = refreshRateLimit.keys().next().value;
    if (firstKey !== undefined) refreshRateLimit.delete(firstKey);
  }
  refreshRateLimit.set(ip, now);
  return { allowed: true };
}

export async function GET(request: Request): Promise<Response> {
  ensureServerInit();
  const auth = await requireAuth(request);
  const denied = authGuard(auth);
  if (denied) return denied;

  // 22-00 IMP-11 audit-fix:SR2 — ?refresh=1 boot-cache eviction, rate-limited.
  const url = new URL(request.url);
  if (url.searchParams.get('refresh') === '1') {
    const ip = extractRemoteIp(request);
    const decision = checkRefreshRateLimit(ip, Date.now());
    if (!decision.allowed) {
      return new Response(
        JSON.stringify({ error: 'rate_limited', retryAfter: decision.retryAfter }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Retry-After': String(decision.retryAfter),
          },
        },
      );
    }
    clearContainerImageCache();
    clearCpuCapabilityCache();
  }

  try {
    const payload = await assembleDiagnostics();
    const res = new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
    return withRenewCookie(res, auth);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.stack : String(err), route: '/api/diagnostics' },
      'diagnostics_assemble_failed',
    );
    return new Response(JSON.stringify({ error_code: 'diagnostics_unavailable' }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
}
