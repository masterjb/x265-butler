// 14-04 Task 3: /api/shares/[id] — PATCH update + DELETE remove.
//
// audit-fix M1 (audit): scan-lock check rejects mutations during
// an active scan with 409 share_mutating_during_scan. See AC-22 + AC-23.
//   Rationale: a share rename / re-path / delete mid-scan would race the
//   per-share dispatch loop in src/lib/scan/orchestrator.ts (14-02) and
//   produce drifting byShare counters or orphan-files-mid-iteration.
// audit-fix SR4: PATCH logs before/after delta; DELETE logs full pre-delete
// snapshot + orphanedFileCount. Both lines carry actor + requestId.
// AC-5 path-change: when PATCH includes a `path` field AND the new path
// differs from current, response includes `warnings: ['rescan_recommended']`
// surfaced by ShareEditForm as a sonner info-toast in Task 4 (R7 mitigation).
//
// FK ON DELETE SET NULL (migration 0026): shareRepo.remove(id) does NOT touch
// file rows; SQLite handles the SET NULL cascade. We capture orphanedFileCount
// via fileRepo.countByQuery({ shareId: id }) BEFORE the DELETE so the log
// line carries a definitive number (post-delete the rows have share_id=NULL
// and {shareId:id} returns 0).

import crypto from 'node:crypto';
import { getDb, shareRepo, fileRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';
import { isScanInProgress } from '@/src/lib/scan/scan-progress-flag';
import {
  shareUpdateSchema,
  idParamSchema,
  fieldErrorsFromZod,
  mapShareRepoErrorToHttp,
} from '@/src/lib/api/shares-zod';

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

function actorFromAuth(auth: {
  ok: true;
  mode: 'disabled' | 'authenticated';
  username: string | null;
}): string {
  return auth.mode === 'authenticated' && auth.username ? auth.username : 'anonymous';
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } };

async function resolveId(ctx: RouteContext): Promise<{ id: number } | { error: Response }> {
  const rawParams = await Promise.resolve(ctx.params);
  const parsedId = idParamSchema.safeParse(rawParams.id);
  if (!parsedId.success) {
    return { error: jsonResponse({ error: 'share_not_found' }, 404) };
  }
  return { id: parsedId.data };
}

export async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth.ok) return authGuard(auth) as Response;

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/shares/[id]' });
  const actor = actorFromAuth(auth);

  const idResolution = await resolveId(ctx);
  if ('error' in idResolution) return idResolution.error;
  const { id } = idResolution;

  // audit-fix M1: scan-lock gate before any other side-effect-bearing step.
  if (isScanInProgress()) {
    log.warn(
      { action: 'share_patch_rejected_scan_active', shareId: id, actor },
      'PATCH rejected during active scan',
    );
    return jsonResponse(
      {
        error: 'share_mutating_during_scan',
        scanInProgress: true,
        requestId,
      },
      409,
    );
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return jsonResponse({ error: 'unsupported_media_type', requestId }, 415);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json', requestId }, 400);
  }

  const parsed = shareUpdateSchema.safeParse(body);
  if (!parsed.success) {
    const fieldErrors = fieldErrorsFromZod(parsed.error);
    log.warn(
      { action: 'share_update_rejected_validation', shareId: id, fieldErrors, actor },
      'PATCH zod rejected',
    );
    return jsonResponse(
      {
        error: 'validation_failed',
        fieldErrors,
        requestId,
      },
      400,
    );
  }

  const patch = parsed.data;
  const before = shareRepo().getById(id);
  if (!before) {
    return jsonResponse({ error: 'share_not_found', requestId }, 404);
  }

  try {
    // audit-fix M1: assertNonNested (path patches only) + update wrapped in TX.
    // Mirrors POST pattern; SQLite's default isolation closes the TOCTOU window
    // against any external race.
    const updated = getDb().transaction(() => {
      if (patch.path !== undefined) {
        shareRepo().assertNonNested({ path: patch.path, excludeId: id });
      }
      return shareRepo().update(id, patch);
    })();

    if (!updated) {
      // Race: row vanished between getById and update. Treat as 404 + warn.
      log.warn({ action: 'share_update_lost_row', shareId: id, actor }, 'row gone mid-PATCH');
      return jsonResponse({ error: 'share_not_found', requestId }, 404);
    }

    const warnings: string[] = [];
    if (patch.path !== undefined && before.path !== updated.path) {
      warnings.push('rescan_recommended');
    }

    log.info(
      {
        action: 'share_updated',
        shareId: id,
        before,
        after: updated,
        actor,
      },
      'share updated',
    );

    return jsonResponse({ share: updated, warnings, requestId }, 200);
  } catch (err) {
    const mapped = mapShareRepoErrorToHttp(err);
    if (mapped) {
      log.warn(
        {
          action: 'share_update_rejected',
          shareId: id,
          error: mapped.body.error,
          actor,
        },
        'share update rejected',
      );
      return jsonResponse({ ...mapped.body, requestId }, mapped.status);
    }
    log.error(
      { err: err instanceof Error ? err.stack : String(err), shareId: id, actor },
      '/api/shares/[id] PATCH: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}

export async function DELETE(request: Request, ctx: RouteContext): Promise<Response> {
  const auth = await requireAuth(request);
  if (!auth.ok) return authGuard(auth) as Response;

  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/shares/[id]' });
  const actor = actorFromAuth(auth);

  const idResolution = await resolveId(ctx);
  if ('error' in idResolution) return idResolution.error;
  const { id } = idResolution;

  if (isScanInProgress()) {
    log.warn(
      { action: 'share_delete_rejected_scan_active', shareId: id, actor },
      'DELETE rejected during active scan',
    );
    return jsonResponse(
      {
        error: 'share_mutating_during_scan',
        scanInProgress: true,
        requestId,
      },
      409,
    );
  }

  const snapshot = shareRepo().getById(id);
  if (!snapshot) {
    return jsonResponse({ error: 'share_not_found', requestId }, 404);
  }

  // Count BEFORE the DELETE: post-DELETE the FK SET NULL cascade has fired and
  // {shareId: id} matches zero rows. Counting here is the only way to produce
  // a stable orphanedFileCount for the audit-log line + API response.
  const orphanedFileCount = fileRepo().countByQuery({
    page: 1,
    size: 1,
    sort: 'scanned',
    dir: 'desc',
    status: 'all',
    shareId: id,
  });

  try {
    const removed = shareRepo().remove(id);
    if (!removed) {
      log.warn({ action: 'share_delete_lost_row', shareId: id, actor }, 'row gone mid-DELETE');
      return jsonResponse({ error: 'share_not_found', requestId }, 404);
    }

    log.info(
      {
        action: 'share_deleted',
        shareId: id,
        snapshot,
        orphanedFileCount,
        actor,
      },
      'share deleted',
    );

    return jsonResponse({ deleted: true, orphanedFileCount, requestId }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err), shareId: id, actor },
      '/api/shares/[id] DELETE: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
