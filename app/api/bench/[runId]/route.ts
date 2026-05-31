// 11-01: Bench API — GET /api/bench/[runId] (run detail + combos), DELETE /api/bench/[runId] (cancel)
import crypto from 'node:crypto';
import { benchRunRepo, benchComboRepo, fileRepo, OccConflictError } from '@/src/lib/db';
import { benchOrchestrator } from '@/src/lib/bench/orchestrator';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function parseRunId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const __auth = await requireAuth(request);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/bench/[runId]', method: 'GET' });

  const { runId: rawId } = await params;
  const runId = parseRunId(rawId);
  if (!runId) return jsonResponse({ error: 'invalid_run_id', requestId }, 400);

  try {
    const run = benchRunRepo().findById(runId);
    if (!run) return jsonResponse({ error: 'run_not_found', runId, requestId }, 404);

    const combos = benchComboRepo().listByRun(runId);
    const summary = benchComboRepo().summarizeRun(runId);
    // 11-02-FIX-V2 UAT-003: fileSizeMap for projected-full-file-savings math in Top3Cards.
    // Record<fileId, size_bytes> — JSON-serializable (numeric keys coerce to strings in JSON
    // and back via JS implicit lookup; audit M5 RSC/Client bridge safety).
    const files = fileRepo().listByIds(run.fileIds);
    const fileSizeMap: Record<number, number> = Object.fromEntries(
      files.map((f) => [f.id, f.size_bytes]),
    );
    return jsonResponse({ run, combos, summary, fileSizeMap, requestId }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/bench/[runId] GET: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const __auth = await requireAuth(request);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/bench/[runId]', method: 'DELETE' });

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
      '/api/bench/[runId] DELETE: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
