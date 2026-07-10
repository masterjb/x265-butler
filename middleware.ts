import createMiddleware from 'next-intl/middleware';
import type { NextRequest } from 'next/server';
import { routing } from './i18n/routing';

const handleI18nRouting = createMiddleware(routing);

// Phase 21 Plan 21-03 audit-M1: x-pathname header injection.
// The not-found Server Component needs the originally-requested pathname to
// classify the failure (locale-missing / locale-unknown / route-unknown).
// Next.js does NOT propagate the URL into App Router Server Components, and
// `referer` is missing on direct URL hits — so middleware must echo the
// pathname back into request headers, then the response, for downstream
// `headers().get('x-pathname')` reads.
//
// Phase 22 Plan 22-01 IMP-1: Server-Timing header. DevTools-Network-Panel-readable
// i18n-routing duration. Single `dur` value, NOT per-stage — matcher excludes /api,
// _next, _vercel, .static, so coverage is just the i18n redirect path.
export default function middleware(req: NextRequest): ReturnType<typeof handleI18nRouting> {
  const t0 = performance.now();
  const pathname = req.nextUrl.pathname;
  const response = handleI18nRouting(req);
  const dur = performance.now() - t0;
  response.headers.set('x-pathname', pathname);
  response.headers.set('x-original-pathname', pathname);
  response.headers.set('Server-Timing', `i18n;dur=${dur.toFixed(1)}`);
  return response;
}

// CRITICAL: exclude `api` so /api/health does NOT get prefix-redirected to /en/api/health.
// This preserves the migration parity from Plan 01-01 (audit AC-1).
export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
