// 47-01 T3 — POST /api/bench/bulk-delete.
// Bulk equivalent of the 47-01 single-row purge (DELETE /api/bench/[runId]).
// Removes ONLY bench_run rows (FK CASCADE drops their bench_combo rows). `file` rows
// and anything on disk are NEVER touched — this route deliberately does zero FS I/O.
//
// Envelope is a structural mirror of app/api/library/bulk-delete/route.ts:
//   200-always partial-success { successCount, failed[], requestId }; HTTP 500 ONLY when
//   the OUTER transaction throws. Per-id SAVEPOINT / RELEASE / ROLLBACK TO.
// The SEMANTICS are the bench ones: every per-id guard lives in BenchOrchestrator.purgeRun(),
// which is synchronous precisely so it composes inside a SAVEPOINT.
//
// Failed reasons: 'not_found' | 'active_run' | 'active_pass2' | 'internal_error'.

import crypto from 'node:crypto';
import { z } from 'zod';
import { getDb } from '@/src/lib/db';
import { benchOrchestrator } from '@/src/lib/bench/orchestrator';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Library parity. The 500-cap is INDEPENDENT of whatever selection cap the 47-02
// history-table UI picks (decision B2).
const MAX_BULK = 500;

// A worst-case batch holds an exclusive SQLite write lock on the one connection that
// also serves the encode orchestrator, the watcher and the scan walk. Accepted at
// library parity — but measured, not invisible (audit S2).
const SLOW_BULK_MS = 1000;

const bodySchema = z.object({
  ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_BULK)
    .refine((arr) => new Set(arr).size === arr.length, { message: 'duplicate_ids' }),
});

type FailedEntry = {
  id: number;
  reason: 'not_found' | 'active_run' | 'active_pass2' | 'internal_error';
};

// audit M2: purgeRun's `.code` vocabulary and the envelope's `reason` union are NOT the
// same words — it throws 'run_not_found' while the contract says 'not_found'. A
// pass-through (`reason = err.code`) emits an out-of-contract reason; an
// `instanceof`-only check buckets every purge rejection into internal_error and
// AC-7's reason:'not_found' could then never fire. Hence an explicit table.
const REASON_BY_CODE: Record<string, FailedEntry['reason']> = {
  run_not_found: 'not_found',
  active_run: 'active_run',
  active_pass2: 'active_pass2',
};

export async function POST(req: Request): Promise<Response> {
  const { denied, auth } = await gateAuth(req);
  if (denied) return denied;

  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse({ skipped: true, reason: 'build-time-skip', requestId: 'build' }, 200);
  }

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/bench/bulk-delete' });

  // CSRF defense — 415 Content-Type guard (mirror library bulk-delete M4).
  const contentType = (req.headers.get('content-type') ?? '').trim().toLowerCase();
  if (!contentType.startsWith('application/json')) {
    log.warn({ contentType }, 'unsupported content-type');
    return jsonResponse({ error: 'unsupported_media_type', requestId }, 415);
  }

  let body: unknown;
  try {
    const text = await req.text();
    body = text === '' ? {} : JSON.parse(text);
  } catch {
    return jsonResponse({ error: 'invalid_json', requestId }, 400);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: 'invalid_body', details: parsed.error.issues, requestId }, 400);
  }

  const actorId = auth.ok && auth.mode === 'authenticated' ? auth.username : null;
  const ids = parsed.data.ids;

  try {
    const db = getDb();
    // Hyphens are illegal in an unquoted SQLite SAVEPOINT identifier — a raw
    // crypto.randomUUID() contains them → SQL syntax error on EVERY request.
    // Sanitize EXACTLY like the library sibling (its audit-M1 fix); do not regress.
    const spPrefix = `sp_bdel_${requestId.replace(/-/g, '_')}`;
    const tx = db.transaction((batch: number[]) => {
      const successIds: number[] = [];
      const failed: FailedEntry[] = [];
      for (const id of batch) {
        const sp = `${spPrefix}_${id}`;
        db.prepare(`SAVEPOINT ${sp}`).run();
        try {
          benchOrchestrator().purgeRun(id);
          successIds.push(id);
          db.prepare(`RELEASE ${sp}`).run();
        } catch (e) {
          db.prepare(`ROLLBACK TO ${sp}`).run();
          db.prepare(`RELEASE ${sp}`).run();
          const code = (e as { code?: string } | null)?.code;
          // `code ? … : undefined` (not `code && …`) — the && form widens the type to
          // include the empty string when code is '' and does not typecheck.
          const reason: FailedEntry['reason'] =
            (code ? REASON_BY_CODE[code] : undefined) ?? 'internal_error';
          failed.push({ id, reason });
          if (reason === 'internal_error') {
            // An unmapped code is a contract-drift signal, not a silent bucket.
            log.error(
              { err: e instanceof Error ? e.stack : String(e), id, code },
              'bench bulk-delete per-id internal_error',
            );
          }
        }
      }
      return { successIds, failed };
    });

    const startedAt = Date.now();
    const result = tx(ids);
    const durationMs = Date.now() - startedAt;

    const auditPayload = {
      action: 'bench_bulk_purge',
      audit: 'bench_bulk_purge',
      requestId,
      actorId,
      idsRequested: ids.length,
      successCount: result.successIds.length,
      failedCount: result.failed.length,
      failedSample: result.failed.slice(0, 10),
      durationMs,
    };
    if (durationMs > SLOW_BULK_MS) {
      // The exclusive write lock blocked encode-progress / watcher / scan writes for
      // this long. Lever if operators see stalls: lower MAX_BULK (NOT chunk inside the
      // route — that would forfeit the all-or-nothing outer-transaction guarantee).
      log.warn(auditPayload, 'bench_bulk_purge slow');
    } else {
      log.info(auditPayload, 'bench_bulk_purge');
    }

    return jsonResponse(
      { successCount: result.successIds.length, failed: result.failed, requestId },
      200,
    );
  } catch (err) {
    // audit S3: the outer tx rolled back — every per-id `bench_run_purged` audit line
    // emitted inside it is now VOID. Name the ids, or post-incident reconstruction
    // reads deletions that never happened.
    log.error(
      {
        action: 'bench_bulk_purge_rolled_back',
        ids,
        idsRequested: ids.length,
        err: err instanceof Error ? err.stack : String(err),
      },
      '/api/bench/bulk-delete POST: tx-throw — per-id purge audit lines are void',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
