// 13-02 Plan T1 — POST /api/trash/bulk-delete.
// Permanently delete up to 500 trash entries (DB row + FS unlink).
// Per-ID SAVEPOINT inside outer db.transaction() — partial-success safe.
// FS unlinks run AFTER the transaction commits (audit-locked M3 — better-sqlite3
// is sync-only AND large bulk I/O inside TX would block all readers).
// HTTP 200 always for partial-success (audit-locked M2). HTTP 500 only on tx-throw.
//
// audit M1: per-ID SAVEPOINT pattern.
// audit M2: HTTP 200 only.
// audit M3: FS-ops AFTER COMMIT; ENOENT = soft-degrade success (file already gone is desired
//          state); EACCES/EIO/etc. = 'fs_orphan' added to failed[] without DB rollback (DB is
//          source-of-truth per AC-14).
//
// Failed reasons: 'not_found' | 'not_eligible' | 'fs_orphan' | 'internal_error'.

import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import { z } from 'zod';
import { getDb, trashRepo } from '@/src/lib/db';
import type { TrashEntryRow } from '@/src/lib/db/schema';
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
  reason: 'not_found' | 'not_eligible' | 'fs_orphan' | 'internal_error';
};

class BulkReasonError extends Error {
  constructor(public reason: 'not_found' | 'not_eligible' | 'internal_error') {
    super(reason);
  }
}

function isEnoentError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code === 'ENOENT';
}

export async function POST(req: Request): Promise<Response> {
  const { denied, auth } = await gateAuth(req);
  if (denied) return denied;

  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse({ skipped: true, reason: 'build-time-skip', requestId: 'build' }, 200);
  }

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/trash/bulk-delete' });

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
    const spPrefix = `sp_trdl_${requestId.replace(/-/g, '_')}`;
    const tx = db.transaction((ids: number[]) => {
      const successEntries: TrashEntryRow[] = [];
      const failed: FailedEntry[] = [];
      for (const id of ids) {
        const sp = `${spPrefix}_${id}`;
        db.prepare(`SAVEPOINT ${sp}`).run();
        try {
          const entry = trashRepo().findById(id);
          if (!entry) throw new BulkReasonError('not_found');
          // restored_at !== null → entry was already restored from trash; can't permanently delete.
          if (entry.restored_at !== null) throw new BulkReasonError('not_eligible');
          const removed = trashRepo().deleteRow(id);
          if (!removed) throw new BulkReasonError('not_found'); // race
          successEntries.push(entry);
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
      return { successEntries, failed };
    });
    const result = tx(parsed.data.ids);

    // audit M3: FS unlink AFTER commit. ENOENT = soft-degrade success (file already gone).
    // EACCES/EIO/etc. = 'fs_orphan' added to failed[]; DB row stays deleted (source-of-truth).
    const fsFailed: FailedEntry[] = [];
    for (const entry of result.successEntries) {
      try {
        await fsPromises.unlink(entry.trash_path);
      } catch (e) {
        if (isEnoentError(e)) {
          // soft-degrade: file already gone, this is the desired end state.
          continue;
        }
        const errno = (e as { code?: string }).code ?? 'unknown';
        log.warn(
          {
            audit: 'bulk_trash_delete_orphan_warning',
            id: entry.id,
            fs_path: entry.trash_path,
            errno,
            err: e instanceof Error ? e.message : String(e),
          },
          'fs-op failed post-commit',
        );
        fsFailed.push({ id: entry.id, reason: 'fs_orphan' });
      }
    }

    const failed = [...result.failed, ...fsFailed];
    const successCount = result.successEntries.length - fsFailed.length;

    log.info(
      {
        audit: 'bulk_trash_delete',
        requestId,
        actorId: actor,
        idsRequested: parsed.data.ids.length,
        successCount,
        failedCount: failed.length,
        failedSample: failed.slice(0, 10),
      },
      'bulk_trash_delete',
    );

    return jsonResponse(
      {
        successCount,
        failed,
        requestId,
      },
      200,
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/trash/bulk-delete POST: tx-throw',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
