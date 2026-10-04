// 13-02 Plan T1 — POST /api/library/bulk-retry.
// Bulk reset up to 500 file IDs to status='pending' for re-encoding.
// Per-ID SAVEPOINT inside outer db.transaction() — partial-success safe.
// HTTP 200 always for partial-success (audit-locked M2). HTTP 500 only on tx-throw.
//
// audit M1: per-ID SAVEPOINT pattern (rollback isolated to one ID).
// audit M2: HTTP 200 only — body discriminates via successCount / failed[].
//
// Failed reasons: 'not_found' | 'not_eligible' | 'internal_error'.
// ELIGIBLE_STATES = 04-03 + 05-13 extension: failed | interrupted | done-larger | done-not-worth.
// Defensive: cancels any active job row (queued/encoding) for the file before flipping status.
// Standard retry path only (no forceContainer; mirrors 10-02 single-endpoint byte-identical semantics).

import crypto from 'node:crypto';
import { z } from 'zod';
import { blocklistRepo, fileRepo, getDb, jobRepo } from '@/src/lib/db';
import type { FileRow, FileStatus } from '@/src/lib/db/schema';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
import { matchPathInList } from '@/src/lib/db/repos/blocklist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BULK = 500;

const ELIGIBLE_STATES: ReadonlySet<FileStatus> = new Set<FileStatus>([
  'failed',
  'interrupted',
  'done-larger',
  'done-not-worth',
]);

const bodySchema = z.object({
  ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_BULK)
    .refine((arr) => new Set(arr).size === arr.length, { message: 'duplicate_ids' }),
});

type FailedEntry = {
  id: number;
  reason: 'not_found' | 'not_eligible' | 'blocklisted' | 'internal_error';
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
  const log = logger.child({ requestId, route: '/api/library/bulk-retry' });

  // CSRF defense — 415 Content-Type guard.
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
    // 13-06 SR1: hoist pattern cache + file-pinned helper OUTSIDE per-ID
    // SAVEPOINT loop. Single SQL read for whole bulk request; per-ID loop
    // uses in-memory matchPathInList. File-pinned check stays per-ID via
    // findByFileId (cheap indexed lookup; one SQL per ID acceptable).
    const blocklistRepoInstance = blocklistRepo();
    const cachedPatterns = blocklistRepoInstance.listAllPatterns();
    function isBlocklistedForBulk(file: FileRow): boolean {
      if (blocklistRepoInstance.findByFileId(file.id) !== undefined) return true;
      return matchPathInList(file.path, cachedPatterns);
    }
    const spPrefix = `sp_blrt_${requestId.replace(/-/g, '_')}`;
    const tx = db.transaction((ids: number[]) => {
      const successIds: number[] = [];
      const failed: FailedEntry[] = [];
      for (const id of ids) {
        const sp = `${spPrefix}_${id}`;
        db.prepare(`SAVEPOINT ${sp}`).run();
        try {
          const file = fileRepo().getById(id);
          if (!file) throw new BulkReasonError('not_found');
          if (!ELIGIBLE_STATES.has(file.status)) throw new BulkReasonError('not_eligible');

          // 13-06 Layer-2 per-ID guard — reject blocklisted before any state change.
          if (isBlocklistedForBulk(file)) {
            throw new BulkReasonError('blocklisted');
          }

          // Defensive: cancel any active job row (orphan races).
          const activeJob = jobRepo().findByFileId(id);
          if (activeJob && (activeJob.status === 'queued' || activeJob.status === 'encoding')) {
            jobRepo().markCancelled(activeJob.id);
          }

          const ok = fileRepo().setStatus(id, 'pending', file.version);
          if (!ok) throw new BulkReasonError('not_eligible'); // OCC-mismatch

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
              'bulk-retry per-id internal_error',
            );
          }
        }
      }
      return { successIds, failed };
    });
    const result = tx(parsed.data.ids);

    log.info(
      {
        audit: 'bulk_library_retry',
        requestId,
        actorId: actor,
        idsRequested: parsed.data.ids.length,
        successCount: result.successIds.length,
        failedCount: result.failed.length,
        failedSample: result.failed.slice(0, 10),
      },
      'bulk_library_retry',
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
      '/api/library/bulk-retry POST: tx-throw',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
