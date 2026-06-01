// 13-02 Plan T1 — POST /api/trash/bulk-restore.
// Restore up to 500 trash entries (DB restore + FS move back to original_path).
// Per-ID SAVEPOINT inside outer db.transaction() — partial-success safe.
// FS moves run AFTER the transaction commits (audit-locked M3 — better-sqlite3
// is sync-only AND large bulk I/O inside TX would block all readers).
// HTTP 200 always for partial-success (audit-locked M2). HTTP 500 only on tx-throw.
//
// audit M1: per-ID SAVEPOINT pattern.
// audit M2: HTTP 200 only.
// audit M3: FS-ops AFTER COMMIT; moveAcrossFilesystems failure = 'fs_orphan' added
//          to failed[] without DB rollback (DB is source-of-truth per AC-14). The
//          trash row stays marked restored — operator must resolve the FS state manually.
//
// Failed reasons: 'not_found' | 'already_restored' | 'fs_orphan' | 'internal_error'.

import crypto from 'node:crypto';
import { z } from 'zod';
import { fileRepo, getDb, trashRepo } from '@/src/lib/db';
import type { TrashEntryRow } from '@/src/lib/db/schema';
import { moveAcrossFilesystems } from '@/src/lib/fs-helpers';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';

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
  reason: 'not_found' | 'already_restored' | 'fs_orphan' | 'internal_error';
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

class BulkReasonError extends Error {
  constructor(public reason: 'not_found' | 'already_restored' | 'internal_error') {
    super(reason);
  }
}

export async function POST(req: Request): Promise<Response> {
  const __auth = await requireAuth(req);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse({ skipped: true, reason: 'build-time-skip', requestId: 'build' }, 200);
  }

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/trash/bulk-restore' });

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

  const actor = __auth.ok && __auth.mode === 'authenticated' ? __auth.username : null;

  try {
    const db = getDb();
    const spPrefix = `sp_trrs_${requestId.replace(/-/g, '_')}`;
    const tx = db.transaction((ids: number[]) => {
      const successEntries: TrashEntryRow[] = [];
      const failed: FailedEntry[] = [];
      for (const id of ids) {
        const sp = `${spPrefix}_${id}`;
        db.prepare(`SAVEPOINT ${sp}`).run();
        try {
          const entry = trashRepo().findById(id);
          if (!entry) throw new BulkReasonError('not_found');
          if (entry.restored_at !== null) throw new BulkReasonError('already_restored');
          const ok = trashRepo().restore(id);
          if (!ok) throw new BulkReasonError('already_restored'); // race
          // Best-effort: flip file row status back to 'pending' so operator can re-trigger encode.
          if (entry.file_id !== null) {
            const file = fileRepo().getById(entry.file_id);
            if (file) {
              const flipOk = fileRepo().setStatus(entry.file_id, 'pending', file.version);
              if (!flipOk) {
                log.warn(
                  { id, fileId: entry.file_id },
                  'file-status flip returned false; trash restore committed regardless',
                );
              }
            }
          }
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
              'bulk-restore per-id internal_error',
            );
          }
        }
      }
      return { successEntries, failed };
    });
    const result = tx(parsed.data.ids);

    // audit M3: FS moveAcrossFilesystems AFTER commit. Failure = 'fs_orphan' added to failed[];
    // DB row stays restored (source-of-truth). Operator resolves FS state manually.
    const fsFailed: FailedEntry[] = [];
    for (const entry of result.successEntries) {
      try {
        moveAcrossFilesystems(entry.trash_path, entry.original_path);
      } catch (e) {
        const errno = (e as { code?: string }).code ?? 'unknown';
        log.warn(
          {
            audit: 'bulk_trash_restore_orphan_warning',
            id: entry.id,
            fs_path: entry.trash_path,
            original_path: entry.original_path,
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
        audit: 'bulk_trash_restore',
        requestId,
        actorId: actor,
        idsRequested: parsed.data.ids.length,
        successCount,
        failedCount: failed.length,
        failedSample: failed.slice(0, 10),
      },
      'bulk_trash_restore',
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
      '/api/trash/bulk-restore POST: tx-throw',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
