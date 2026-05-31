import crypto from 'node:crypto';
import { fileRepo, jobRepo, getDb } from '@/src/lib/db';
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

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // 05-01 Plan T3: requireAuth gate.
  const __auth = await requireAuth(request);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/library/:id' });

  const { id: rawId } = await context.params;
  if (!/^\d+$/.test(rawId)) {
    return jsonResponse({ error: 'invalid_id', requestId }, 400);
  }
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) {
    return jsonResponse({ error: 'invalid_id', requestId }, 400);
  }

  try {
    const file = fileRepo().getById(id);
    if (!file) {
      return jsonResponse({ error: 'not_found', requestId }, 404);
    }
    // 12-03 inline-extend Route-1: surface latest job (REGARDLESS of status)
    // so the FileDetailPanel can display encoder + crf + preset_used for the
    // most recent attempt — including failed/cancelled. Operator-facing
    // audit-trail: a pinned preset that didn't make it through still surfaces
    // so the operator can diagnose "why is preset_used '—'?".
    const lastJob = jobRepo().findLatestByFileId(id) ?? null;
    return jsonResponse({ file, lastJob, requestId }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/library/:id: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}

// 24-04 F6: DELETE /api/library/[id] — row-only "forget" of a library entry.
// Removes ONLY the `file` DB row (FK CASCADE drops job + blocklist_entry;
// trash_entry.file_id SET NULL). The physical file is NEVER touched (D1 = A).
// Guards: active-job (D3, file.status authoritative) → 409, bench-reference
// (D2 soft-guard + defensive FK catch) → 409. Idempotent 404 / invalid 400.
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const __auth = await requireAuth(request);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse({ skipped: true, reason: 'build-time-skip', requestId: 'build' }, 200);
  }

  ensureServerInit();

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/library/[id]', method: 'DELETE' });

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return jsonResponse({ error: 'invalid_file_id', requestId }, 400);
  }

  try {
    const file = fileRepo().getById(id);
    if (!file) {
      return jsonResponse({ error: 'file_not_found', idempotent: true, requestId }, 404);
    }

    // D3 active-job guard: file.status is the SINGLE authoritative source
    // (NOT a second job-table read that can drift). AC-6 visibility + D4
    // eligibility gate on the same field.
    if (file.status === 'queued' || file.status === 'encoding') {
      return jsonResponse(
        { error: 'delete_rejected_active_job', currentStatus: file.status, requestId },
        409,
      );
    }

    // D2 bench soft-guard: pre-check before the FK exception can fire.
    if (fileRepo().isReferencedByBench(id)) {
      return jsonResponse({ error: 'delete_blocked_bench_reference', requestId }, 409);
    }

    const previousStatus = file.status;

    // AC-3b: active-guard RE-CHECK + delete inside ONE synchronous
    // better-sqlite3 transaction so no scheduler tick can promote a 'pending'
    // row to 'queued'/'encoding' between the guard and the CASCADE delete
    // (which would orphan a running encoder against a deleted row).
    let txnResult: { kind: 'deleted' } | { kind: 'gone' } | { kind: 'active'; status: string };
    try {
      txnResult = getDb().transaction(() => {
        const fresh = fileRepo().getById(id);
        if (!fresh) return { kind: 'gone' as const };
        if (fresh.status === 'queued' || fresh.status === 'encoding') {
          return { kind: 'active' as const, status: fresh.status };
        }
        fileRepo().deleteById(id);
        return { kind: 'deleted' as const };
      })();
    } catch (err) {
      // Defense-in-depth: bench reference snuck past the pre-check (race) →
      // the FK NO-ACTION constraint raises here; map to the same 409.
      if ((err as { code?: string } | null)?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        return jsonResponse({ error: 'delete_blocked_bench_reference', requestId }, 409);
      }
      throw err;
    }

    if (txnResult.kind === 'gone') {
      return jsonResponse({ error: 'file_not_found', idempotent: true, requestId }, 404);
    }
    if (txnResult.kind === 'active') {
      return jsonResponse(
        { error: 'delete_rejected_active_job', currentStatus: txnResult.status, requestId },
        409,
      );
    }

    log.info(
      { action: 'library_entry_deleted', fileId: id, previousStatus, path: file.path },
      'library entry deleted (row-only)',
    );
    return jsonResponse({ deleted: true, fileId: id, previousStatus, requestId }, 200);
  } catch (err) {
    // audit-SR2: no silent failure — forensic record with requestId.
    log.error(
      { err: err instanceof Error ? err.stack : String(err), fileId: id },
      'library delete failed',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
