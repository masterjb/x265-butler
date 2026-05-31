// Phase 21 Plan 21-01 — GET /api/diagnostics-report — markdown diagnostics report.
//
// Forum-paste-ready GitHub-flavored markdown. Same auth-mirror gate as
// /api/diagnostics. Same 500-on-throw fallback.

import { authGuard, requireAuth, withRenewCookie } from '@/src/lib/auth/require-auth';
import { assembleDiagnostics } from '@/src/lib/diagnostics/aggregator';
import { renderDiagnosticsMarkdown } from '@/src/lib/diagnostics/markdown-template';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  ensureServerInit();
  const auth = await requireAuth(request);
  const denied = authGuard(auth);
  if (denied) return denied;

  try {
    const payload = await assembleDiagnostics();
    const markdown = renderDiagnosticsMarkdown(payload);
    const res = new Response(markdown, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
    return withRenewCookie(res, auth);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.stack : String(err), route: '/api/diagnostics-report' },
      'diagnostics_report_assemble_failed',
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
