import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

// audit-added G7: security headers (defense in depth, even on LAN)
const isDev = process.env.NODE_ENV !== 'production';

// Strict CSP — `connect-src 'self'` blocks browser-extension fetches to
// external endpoints (cloudfront analytics, posthog injectors, crypto
// price-feeds) so they fail at the page-policy layer instead of leaking
// CORS / connection errors into the operator's console during UAT.
//
// Dev needs:
//   - 'unsafe-eval' / 'unsafe-inline' for Next.js Fast Refresh + react-refresh runtime
//   - ws://localhost:* for HMR websocket
// Production keeps the minimum surface ('self' only, no eval, no inline scripts).
const cspDirectives = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  // shadcn primitives + Tailwind utility classes ship inline styles
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? ' ws://localhost:* wss://localhost:*' : ''}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'Content-Security-Policy', value: cspDirectives },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  // audit-added M1 (01-03): pin the tracing root to this project so the
  // standalone bundle is flat (`.next/standalone/server.js`) regardless of
  // whether a parent `package.json` exists. Without this, Next.js auto-detects
  // a workspace root above the project (e.g. when this repo lives inside a
  // shared `gitlab/` workspace dir) and produces a nested
  // `.next/standalone/apps/<name>/...` layout that breaks the Dockerfile and
  // the start script.
  outputFileTracingRoot: import.meta.dirname,
  // audit-added M1 (01-03): keep migrations/*.sql in the standalone bundle.
  // Without this, `next build --output=standalone` does not copy the
  // migrations directory into `.next/standalone/`, and the runtime container
  // crashes on first DB access. See 01-03-AUDIT.md §G1.
  outputFileTracingIncludes: {
    '/api/scan': ['./migrations/**/*.sql'],
    '/api/health': ['./migrations/**/*.sql'],
    '/': ['./migrations/**/*.sql'],
  },
  // 01-03 CONTEXT.md §9.2: better-sqlite3 native binding must NOT be bundled
  // by Webpack — instructs Next.js to copy it verbatim into the standalone
  // output instead.
  serverExternalPackages: ['better-sqlite3'],
  env: {
    NEXT_PUBLIC_APP_VERSION:
      process.env.NEXT_PUBLIC_APP_VERSION ?? require('./package.json').version,
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  // The bench orchestrator writes sample / encoded `.mkv` files under
  // `<cwd>/.data/bench-scratch/...` during a run. Without an explicit ignore,
  // the Next.js dev watcher reacts to every write with a Fast Refresh
  // rebuild, which terminates the SSE connection mid-run and freezes the
  // bench UI at "queued/running 0/N".
  webpack: (config) => {
    const existing = config.watchOptions?.ignored;
    const ignored = [
      ...(Array.isArray(existing) ? existing : typeof existing === 'string' ? [existing] : []),
      '**/.data/**',
      '**/bench-scratch/**',
    ];
    config.watchOptions = { ...(config.watchOptions ?? {}), ignored };
    return config;
  },
};

export default withNextIntl(nextConfig);
