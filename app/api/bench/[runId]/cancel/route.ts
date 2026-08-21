// 47-01: POST /api/bench/[runId]/cancel — the pre-47 DELETE /api/bench/[runId] semantics,
// carried over verbatim. DELETE on the parent route is now PURGE (row-delete), so cancel
// needed its own transport. BenchOrchestrator.cancelRun() itself is untouched.
//
// AC-11 (audit M4) — CSRF: moving cancel from DELETE onto a BODY-LESS POST is the one
// transport change that introduces a new attack surface. DELETE is not issuable by an
// HTML form and a cross-origin fetch DELETE always preflights; a body-less POST is
// form-forgeable (<form method="post" action="…/cancel"> ⇒ urlencoded, no preflight,
// cookies attached). The project already treats a Content-Type guard as a CSRF control
// (app/api/library/bulk-delete/route.ts:62-67) — parity is restored below in the
// allow-empty variant so the guard-free fetch(url,{method:'POST'}) call shape survives.
import crypto from 'node:crypto';
import { OccConflictError } from '@/src/lib/db';
import { benchOrchestrator } from '@/src/lib/bench/orchestrator';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseRunId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { denied } = await gateAuth(request);
  if (denied) return denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/bench/[runId]/cancel', method: 'POST' });

  // Reject ONLY the three form-encodable types — those are the CSRF-reachable ones.
  // Absent/empty (the fetch(url,{method:'POST'}) shape used by both UI callsites) and
  // application/json pass. Do NOT tighten this to the library route's
  // startsWith('application/json')-only check: that would 415 the body-less call.
  const contentType = (request.headers.get('content-type') ?? '').trim().toLowerCase();
  if (contentType !== '' && !contentType.startsWith('application/json')) {
    log.warn({ contentType }, 'unsupported content-type');
    return jsonResponse({ error: 'unsupported_media_type', requestId }, 415);
  }

  const { runId: rawId } = await params;
  const runId = parseRunId(rawId);
  if (!runId) return jsonResponse({ error: 'invalid_run_id', requestId }, 400);

  try {
    await benchOrchestrator().cancelRun(runId);
    log.info({ action: 'bench_cancel', runId }, 'bench run cancelled');
    return jsonResponse({ runId, cancelled: true, requestId }, 200);
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      return jsonResponse({ error: 'run_not_found', runId, requestId }, 404);
    }
    if (err instanceof OccConflictError) {
      return jsonResponse({ error: 'occ_conflict', requestId }, 409);
    }
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/bench/[runId]/cancel POST: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
