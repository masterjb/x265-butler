// 29-03 T1 — POST /api/library/bulk-delete.
// Bulk equivalent of the 24-04 single-entry row-only "forget" (DELETE /api/library/[id]).
// Removes ONLY the `file` DB rows (FK CASCADE drops job + blocklist_entry;
// trash_entry.file_id SET NULL). The physical file on disk is NEVER touched.
// Per-ID SAVEPOINT inside outer db.transaction() — partial-success safe.
//
// AC-1: zero filesystem I/O — this route deliberately imports NEITHER 'node:fs'
//       NOR 'node:fs/promises' (the one thing distinguishing it from the adjacent
//       trash bulk-delete that DOES unlink). Pinned by an executable static test.
// AC-2: per-id guards mirror single-delete — not_found / active_job / active_bench.
// AC-3: 415 Content-Type guard, 400 invalid_json / invalid_body, 500 only on tx-throw.
// AC-6: TOCTOU — active re-check + deleteById inside ONE synchronous SAVEPOINT.
// 47-03 AC-8: the bench guard re-checks inside the SAVEPOINT as well; after
//       migration 0029 (bench_combo.file_id ON DELETE SET NULL) the FK can no
//       longer raise, so the re-check is the only remaining race guard.
//
// Failed reasons: 'not_found' | 'active_job' | 'active_bench' | 'internal_error'.
// Mirrors bulk-blocklist envelope (200-always partial-success, HTTP 500 only on tx-throw).

import crypto from 'node:crypto';
import { z } from 'zod';
import { fileRepo, getDb } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BULK = 500;

const bodySchema = z.object({
  ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_BULK)
    .refine((arr) => new Set(arr).size === arr.length, { message: 'duplicate_ids' }),
});

type FailedEntry = {
  id: number;
  reason: 'not_found' | 'active_job' | 'active_bench' | 'internal_error';
};

class BulkReasonError extends Error {
  constructor(public reason: FailedEntry['reason']) {
    super(reason);
  }
}

export async function POST(req: Request): Promise<Response> {
  const { denied, auth } = await gateAuth(req);
  if (denied) return denied;

  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse({ skipped: true, reason: 'build-time-skip', requestId: 'build' }, 200);
  }

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/library/bulk-delete' });

  // CSRF defense — 415 Content-Type guard (mirror bulk-blocklist M4).
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

  const actor = auth.ok && auth.mode === 'authenticated' ? auth.username : null;

  try {
    const db = getDb();
    // M1 (audit): hyphens are illegal in an unquoted SQLite SAVEPOINT identifier —
    // a raw crypto.randomUUID() contains them → SQL syntax error on EVERY request.
    // Sanitize EXACTLY like the bulk-blocklist sibling.
    const spPrefix = `sp_lbdel_${requestId.replace(/-/g, '_')}`;
    const tx = db.transaction((ids: number[]) => {
      const successIds: number[] = [];
      const failed: FailedEntry[] = [];
      // 47-03 AC-14: summed over the successfully deleted ids.
      let benchRefsSevered = 0;
      for (const id of ids) {
        const sp = `${spPrefix}_${id}`;
        db.prepare(`SAVEPOINT ${sp}`).run();
        try {
          // Pre-checks mirror the 24-04 single-DELETE guards.
          const file = fileRepo().getById(id);
          if (!file) throw new BulkReasonError('not_found');
          if (file.status === 'queued' || file.status === 'encoding') {
            throw new BulkReasonError('active_job');
          }
          // 47-03: only an ACTIVE run ('pending'|'running') blocks; a terminal
          // one lets the delete through and keeps its measurements (0029).
          if (fileRepo().isReferencedByActiveBench(id)) {
            throw new BulkReasonError('active_bench');
          }
          // AC-6 TOCTOU: re-read fresh inside the SAVEPOINT + delete in one sync
          // txn so no scheduler tick can promote 'pending'→'queued'/'encoding'
          // between the guard and the CASCADE delete.
          const fresh = fileRepo().getById(id);
          if (!fresh) throw new BulkReasonError('not_found');
          if (fresh.status === 'queued' || fresh.status === 'encoding') {
            throw new BulkReasonError('active_job');
          }
          // 47-03 AC-8: bench re-check inside the SAVEPOINT — mirrors the
          // single-DELETE route. The FK catch below cannot cover this any more.
          if (fileRepo().isReferencedByActiveBench(id)) {
            throw new BulkReasonError('active_bench');
          }
          // AC-14: count BEFORE the delete; afterwards the rows read NULL.
          const severed = fileRepo().countBenchRefs(id);
          try {
            fileRepo().deleteById(id);
          } catch (delErr) {
            // Generic 500-avoider, NOT the bench race guard. Since 0029 the
            // bench FK is ON DELETE SET NULL and can no longer raise here; the
            // race is handled by the re-check above. Kept only so a future FK
            // on `file` surfaces as a reason instead of an internal_error.
            if ((delErr as { code?: string } | null)?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
              throw new BulkReasonError('active_bench');
            }
            throw delErr;
          }
          benchRefsSevered += severed;
          successIds.push(id);
          db.prepare(`RELEASE ${sp}`).run();
        } catch (e) {
          db.prepare(`ROLLBACK TO ${sp}`).run();
          db.prepare(`RELEASE ${sp}`).run();
          if (e instanceof BulkReasonError) {
            failed.push({ id, reason: e.reason });
          } else {
            failed.push({ id, reason: 'internal_error' });
            log.error(
              { err: e instanceof Error ? e.stack : String(e), id },
              'bulk-delete per-id internal_error',
            );
          }
        }
      }
      return { successIds, failed, benchRefsSevered };
    });
    const result = tx(parsed.data.ids);

    log.info(
      {
        audit: 'bulk_library_delete',
        requestId,
        actorId: actor,
        idsRequested: parsed.data.ids.length,
        successCount: result.successIds.length,
        failedCount: result.failed.length,
        failedSample: result.failed.slice(0, 10),
        // 47-03 AC-14: bench_combo references severed by ON DELETE SET NULL,
        // summed over the successfully deleted ids. Always emitted, 0 included.
        benchRefsSevered: result.benchRefsSevered,
      },
      'bulk_library_delete',
    );

    return jsonResponse(
      {
        successCount: result.successIds.length,
        failed: result.failed,
        requestId,
      },
      200,
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/library/bulk-delete POST: tx-throw',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
