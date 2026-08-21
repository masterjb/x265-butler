// 11-01: Bench API — GET /api/bench/[runId] (run detail + combos).
// 47-01: DELETE /api/bench/[runId] is PURGE (row-delete + bench_combo CASCADE), NOT cancel.
//        Cancel moved verbatim to POST /api/bench/[runId]/cancel.
//        Stale-client safety: the cancel affordance is status-gated to pending/running
//        (run-detail-client.tsx:114) — exactly the states purge rejects with 409 — so a
//        pre-47 browser tab issuing DELETE-intending-cancel gets a failed cancel, never
//        data loss.
import crypto from 'node:crypto';
import { benchRunRepo, benchComboRepo, fileRepo } from '@/src/lib/db';
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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { denied } = await gateAuth(request);
  if (denied) return denied;

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

// 47-01 AC-1/AC-2/AC-3/AC-4: purge — deletes the bench_run row and CASCADEs its
// bench_combo rows. NEVER touches `file` rows or anything on disk. Guards live in
// BenchOrchestrator.purgeRun(); this handler only maps error codes onto HTTP.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  const { denied, auth } = await gateAuth(request);
  if (denied) return denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/bench/[runId]', method: 'DELETE' });

  const { runId: rawId } = await params;
  const runId = parseRunId(rawId);
  if (!runId) return jsonResponse({ error: 'invalid_run_id', requestId }, 400);

  try {
    const { combosDeleted } = benchOrchestrator().purgeRun(runId);
    // audit M5: actorId is added HERE — the orchestrator has no auth context. `null` in
    // unauthenticated-mode deployments is the honest value and is itself the evidence
    // that no actor could be attributed. Idiom from app/api/library/bulk-delete/route.ts:82.
    const actorId = auth.ok && auth.mode === 'authenticated' ? auth.username : null;
    log.info({ action: 'bench_purge', runId, combosDeleted, actorId }, 'bench run purged');
    return jsonResponse({ runId, deleted: true, combosDeleted, requestId }, 200);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'run_not_found') {
      return jsonResponse({ error: 'run_not_found', runId, requestId }, 404);
    }
    if (code === 'active_run') {
      return jsonResponse(
        {
          error: 'delete_rejected_active_run',
          currentStatus: (err as { currentStatus?: string }).currentStatus,
          requestId,
        },
        409,
      );
    }
    if (code === 'active_pass2') {
      return jsonResponse({ error: 'delete_rejected_active_pass2', requestId }, 409);
    }
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/bench/[runId] DELETE: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
