// 13-02 Plan T1 — POST /api/library/bulk-blocklist.
// Bulk add up to 500 file IDs to operator blocklist + flip file.status to 'blocklisted'.
// Per-ID SAVEPOINT inside outer db.transaction() — partial-success safe.
// HTTP 200 always for partial-success (audit-locked M2). HTTP 500 only on tx-throw.
//
// audit M1: per-ID SAVEPOINT pattern (rollback isolated to one ID on internal error).
// audit M2: HTTP 200 only — body discriminates via successCount / failed[].
// audit M5: blocklist reason='operator' literal-string verbatim with single-endpoint.
//
// Failed reasons: 'not_found' | 'not_eligible' | 'already_blocked' | 'internal_error'.
// CSRF defense: 415 Content-Type guard (mirror 05-02 disable-and-delete M4 pattern).

import crypto from 'node:crypto';
import { z } from 'zod';
import { blocklistRepo, fileRepo, getDb } from '@/src/lib/db';
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
  reason: 'not_found' | 'not_eligible' | 'already_blocked' | 'internal_error';
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
  const log = logger.child({ requestId, route: '/api/library/bulk-blocklist' });

  // CSRF defense — 415 Content-Type guard (audit M4 mirror).
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
    const spPrefix = `sp_blbl_${requestId.replace(/-/g, '_')}`;
    const tx = db.transaction((ids: number[]) => {
      const successIds: number[] = [];
      const failed: FailedEntry[] = [];
      for (const id of ids) {
        const sp = `${spPrefix}_${id}`;
        db.prepare(`SAVEPOINT ${sp}`).run();
        try {
          const file = fileRepo().getById(id);
          if (!file) throw new BulkReasonError('not_found');
          // mirror 04-02 ELIGIBLE_STATES UI exclusion: queued/encoding rows can't pin.
          if (file.status === 'queued' || file.status === 'encoding') {
            throw new BulkReasonError('not_eligible');
          }
          // pre-check existing entry (mirrors single-endpoint idempotency contract).
          const existing = blocklistRepo().findByFileId(id);
          if (existing) throw new BulkReasonError('already_blocked');
          // audit M5: reason='operator' literal-string verbatim with single-endpoint.
          blocklistRepo().add({ file_id: id, reason: 'operator' });
          if (file.status !== 'blocklisted') {
            fileRepo().setStatus(id, 'blocklisted', file.version);
          }
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
              'bulk-blocklist per-id internal_error',
            );
          }
        }
      }
      return { successIds, failed };
    });
    const result = tx(parsed.data.ids);

    log.info(
      {
        audit: 'bulk_library_blocklist',
        requestId,
        actorId: actor,
        idsRequested: parsed.data.ids.length,
        successCount: result.successIds.length,
        failedCount: result.failed.length,
        failedSample: result.failed.slice(0, 10),
      },
      'bulk_library_blocklist',
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
      '/api/library/bulk-blocklist POST: tx-throw',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
