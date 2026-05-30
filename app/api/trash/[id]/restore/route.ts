import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';
// POST /api/trash/[id]/restore — resolve 02-03 deferral D6.
// Moves the trashed file back to its original path and marks restored_at in DB.
// 8 outcome paths per AC-1: 200 / 404 / 400 / 415 / 409×3 / 410 / 500.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { fileRepo, trashRepo } from '@/src/lib/db';
import { moveAcrossFilesystems } from '@/src/lib/fs-helpers';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

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

const bodySchema = z.object({}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // 05-01 Plan T3: requireAuth gate.
  const __auth = await requireAuth(request);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/trash/[id]/restore' });

  // Strict Content-Type check (per 02-03 envelope pattern).
  const contentType = (request.headers.get('content-type') ?? '').trim().toLowerCase();
  if (!contentType.startsWith('application/json')) {
    log.warn({ contentType }, 'unsupported content-type');
    return jsonResponse({ error: 'unsupported_media_type', requestId }, 415);
  }

  // Parse + validate path param.
  const { id: idStr } = await context.params;
  const idNum = Number.parseInt(idStr, 10);
  if (!Number.isFinite(idNum) || idNum <= 0 || String(idNum) !== idStr) {
    log.warn({ idStr }, 'invalid trash id');
    return jsonResponse({ error: 'invalid_trash_id', requestId }, 400);
  }

  // Parse body — must be empty object (or absent).
  try {
    const text = await request.text();
    if (text.trim().length > 0) {
      const parsed = bodySchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        return jsonResponse(
          { error: 'invalid_body', details: parsed.error.issues, requestId },
          400,
        );
      }
    }
  } catch {
    return jsonResponse({ error: 'invalid_body', details: 'malformed JSON', requestId }, 400);
  }

  try {
    const repo = trashRepo();

    const entry = repo.findById(idNum);
    if (!entry) {
      log.warn({ trashId: idNum }, 'trash_entry_not_found');
      return jsonResponse({ error: 'trash_entry_not_found', trashId: idNum, requestId }, 404);
    }

    if (entry.restored_at !== null) {
      log.info({ trashId: idNum, restoredAt: entry.restored_at }, 'already_restored');
      return jsonResponse(
        { error: 'already_restored', restoredAt: entry.restored_at, requestId },
        409,
      );
    }

    // 410: trash file missing on disk — operator must investigate FS.
    if (!fs.existsSync(entry.trash_path)) {
      log.warn({ trashId: idNum, trashPath: entry.trash_path }, 'trash_file_missing');
      return jsonResponse(
        { error: 'trash_file_missing', trashPath: entry.trash_path, requestId },
        410,
      );
    }

    // 409: original path already occupied — do NOT clobber.
    if (fs.existsSync(entry.original_path)) {
      log.warn(
        { trashId: idNum, originalPath: entry.original_path },
        'original_path_exists — refusing clobber',
      );
      return jsonResponse(
        { error: 'original_path_exists', originalPath: entry.original_path, requestId },
        409,
      );
    }

    // Move the file. Falls back to copy+fsync+rename+unlink on EXDEV.
    // audit-added S4: if unlink(trash_path) fails AFTER copy+rename to original_path,
    // do NOT call trashRepo.restore — entry stays unrestored to flag the inconsistency.
    try {
      moveAcrossFilesystems(entry.trash_path, entry.original_path);
    } catch (mvErr) {
      // Check if the file now exists at original_path (partial success before throw).
      // For cross-FS path: moveAcrossFilesystems internal unlink failure surfaces here.
      const atOriginal = fs.existsSync(entry.original_path);
      const stillAtTrash = fs.existsSync(entry.trash_path);
      if (atOriginal && stillAtTrash) {
        // File copied to original_path but unlink of trash_path failed — partial failure.
        log.error(
          {
            action: 'restore_partial_failure',
            trashId: idNum,
            originalPath: entry.original_path,
            trashPath: entry.trash_path,
            err: mvErr instanceof Error ? mvErr.message : String(mvErr),
          },
          'restore_partial_failure: file at both paths — operator must investigate',
        );
        return jsonResponse(
          {
            error: 'restore_partial_failure',
            detail: 'file copied to original_path but unlink of trash_path failed',
            requestId,
          },
          500,
        );
      }
      throw mvErr;
    }

    // Best-effort: flip file status back to pending so operator can re-trigger encode.
    if (entry.file_id !== null) {
      const file = fileRepo().getById(entry.file_id);
      if (file) {
        const ok = fileRepo().setStatus(entry.file_id, 'pending', file.version);
        if (!ok) {
          log.warn(
            { trashId: idNum, fileId: entry.file_id },
            'setStatus returned false — file version conflict; continuing',
          );
        }
      }
    }

    // Mark restored in DB.
    const restored = repo.restore(idNum);
    if (!restored) {
      // Race: another writer already marked restored_at between our findById and now.
      log.warn({ trashId: idNum }, 'trashRepo.restore returned false — race condition');
      return jsonResponse({ error: 'already_restored', requestId }, 409);
    }

    // Re-read the updated row to include restored_at.
    const updatedEntry = repo.findById(idNum);

    log.info(
      {
        action: 'trash_restore',
        trashId: idNum,
        originalPath: entry.original_path,
        fileId: entry.file_id,
      },
      'trash entry restored',
    );

    return jsonResponse({ trashEntry: updatedEntry ?? entry, requestId }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/trash/[id]/restore: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
