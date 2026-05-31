import crypto from 'node:crypto';
import { z } from 'zod';
import { blocklistRepo, fileRepo, getDb } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';
import {
  ENCODE_GUARD_FLIP_RESPONSE_CAP,
  ENCODE_GUARD_WARN_THRESHOLD,
  EncodeGuardScopeCapError,
  flipMatchingFilesToBlocklisted,
  type FlippedFile,
} from '@/src/lib/blocklist/encode-guard';
import { matchPath } from '@/src/lib/db/repos/blocklist';
import type { BlocklistRow } from '@/src/lib/db/schema';
import {
  composeExtensionWarning,
  type ExtensionWarningPayload,
} from '@/src/lib/blocklist/pattern-extension';
// 04-02 Plan Task 2 — POST/DELETE /api/library/[id]/blocklist.
// audit envelope mirrors 03-05 onboarding/complete:
//   - runtime='nodejs', dynamic='force-dynamic', NEXT_PHASE guard
//   - ensureServerInit() before any DB write
//   - Cache-Control: no-store on every response
//   - requestId envelope on every response
//
// audit S1 (body cap 16KB) — Content-Length pre-parse rejection
// audit S2 (entry cap 10000) — count() pre-INSERT rejection
// audit S3 (idempotency mode='pattern') — findByPattern returns existing
// audit S4 (DELETE second-call body flag) — { error, idempotent: true }
// audit M1 (race-safe idempotency) — BlocklistRepo.add catches SQLITE_CONSTRAINT_UNIQUE
// audit M3 (status preservation) — DELETE only flips 'blocklisted' → 'pending'
// audit M4 (ELIGIBLE_STATES) — UI-side guard; not enforced server-side because
//   pinning a queued file is operator's call (server still creates the row + flips status)
// audit S6 (pattern grammar at API layer) — zod check rejects 3+ stars BEFORE repo

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BODY_CAP_BYTES = 16 * 1024;
const BLOCKLIST_MAX_ENTRIES = 10_000;

// 22-03 audit-M2: bound log-payload pattern field. zod accepts up to 4096 chars;
// log lines stay tractable for ring-buffer + downstream ingestion.
const LOG_PATTERN_MAX_CHARS = 256;
function clampPatternForLog(p: string): string {
  return p.length > LOG_PATTERN_MAX_CHARS ? p.slice(0, LOG_PATTERN_MAX_CHARS) + '…' : p;
}

const postBodySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('file') }),
  z.object({
    mode: z.literal('pattern'),
    pathPattern: z.string().min(2).max(4096),
  }),
]);

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  // 05-01 Plan T3: requireAuth gate.
  const __auth = await requireAuth(req);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse({ skipped: true, reason: 'build-time-skip', requestId: 'build' }, 200);
  }

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/library/[id]/blocklist' });

  // audit S1: body size cap.
  const contentLengthRaw = req.headers.get('content-length');
  const contentLength = contentLengthRaw ? parseInt(contentLengthRaw, 10) : 0;
  if (Number.isFinite(contentLength) && contentLength > BODY_CAP_BYTES) {
    log.warn(
      { action: 'blocklist_body_too_large', contentLength, cap: BODY_CAP_BYTES },
      'POST body exceeds size cap',
    );
    return jsonResponse({ error: 'body_too_large', requestId }, 413);
  }

  const params = await ctx.params;
  const fileIdRaw = parseInt(params.id, 10);

  let body: unknown;
  try {
    const text = await req.text();
    body = text === '' ? {} : JSON.parse(text);
  } catch {
    return jsonResponse({ error: 'invalid_json', requestId }, 400);
  }

  const parsed = postBodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: 'invalid_body', details: parsed.error.issues, requestId }, 400);
  }

  // audit S6: pattern grammar — reject 3+ stars at API layer (defense-in-depth;
  // repo also returns false for 3+ stars but explicit rejection is clearer).
  if (parsed.data.mode === 'pattern') {
    const starCount = (parsed.data.pathPattern.match(/\*/g) ?? []).length;
    if (starCount > 2) {
      return jsonResponse({ error: 'pattern_too_complex', requestId }, 400);
    }
  }

  // audit S2: entry-count cap.
  try {
    if (blocklistRepo().count() >= BLOCKLIST_MAX_ENTRIES) {
      log.warn(
        {
          action: 'blocklist_count_cap_reached',
          current: blocklistRepo().count(),
          cap: BLOCKLIST_MAX_ENTRIES,
        },
        'blocklist entry cap reached — rejecting add',
      );
      return jsonResponse({ error: 'blocklist_full', requestId }, 409);
    }

    if (parsed.data.mode === 'file') {
      // mode='file' uses path param :id as file_id.
      if (!Number.isFinite(fileIdRaw) || fileIdRaw <= 0) {
        return jsonResponse({ error: 'invalid_file_id', requestId }, 400);
      }
      const file = fileRepo().getById(fileIdRaw);
      if (!file) {
        return jsonResponse({ error: 'file_not_found', requestId }, 404);
      }

      // audit M1: BlocklistRepo.add catches SQLITE_CONSTRAINT_UNIQUE +
      // returns existing row (idempotent under concurrent POST race).
      const row = blocklistRepo().add({ file_id: file.id, reason: 'operator' });

      // Flip file.status only if currently 'pending' / failed / done-larger /
      // skipped-* (matches audit M4 ELIGIBLE_STATES on the UI side; server
      // tolerates idempotent re-add by NOT re-flipping if already 'blocklisted').
      if (file.status !== 'blocklisted') {
        fileRepo().setStatus(file.id, 'blocklisted', file.version);
      }

      log.info(
        {
          action: 'blocklist_added',
          entryId: row.id,
          fileId: file.id,
          mode: 'file',
          reason: 'operator',
        },
        'blocklist entry added (file-pinned)',
      );

      return jsonResponse(
        {
          id: row.id,
          fileId: row.file_id,
          pathPattern: row.path_pattern,
          reason: row.reason,
          createdAt: row.created_at,
          requestId,
        },
        200,
      );
    } else {
      // mode='pattern' — id path param ignored.
      const { pathPattern } = parsed.data;
      // 13-06 Layer-1: retroactive flip wrapped in atomic TX.
      // audit M2: idempotency check (findByPattern) lives INSIDE the
      //   transaction — concurrent POST race-safety; eliminates duplicate-row
      //   class (SQLite default isolation serializes the whole tx).
      // audit M3 + AC-11: listEligibleForBlocklistFlip throws
      //   EncodeGuardScopeCapError when candidate count > 100_000; route
      //   catches → HTTP 409 blocklist_scope_too_large. TX rolls back
      //   atomically — neither entry NOR flip persists.
      type TxResult =
        | { kind: 'idempotent'; row: BlocklistRow }
        | {
            kind: 'created';
            row: BlocklistRow;
            flippedCount: number;
            flipped: FlippedFile[];
          };
      let txResult: TxResult;
      try {
        txResult = getDb().transaction((): TxResult => {
          const existing = blocklistRepo().findByPattern(pathPattern, 'operator');
          if (existing) {
            return { kind: 'idempotent', row: existing };
          }
          const row = blocklistRepo().add({
            path_pattern: pathPattern,
            reason: 'operator',
          });
          const flip = flipMatchingFilesToBlocklisted({
            pattern: pathPattern,
            fileRepo: fileRepo(),
            matchPath,
          });
          return {
            kind: 'created',
            row,
            flippedCount: flip.flippedCount,
            flipped: flip.flipped,
          };
        })();
      } catch (err) {
        if (err instanceof EncodeGuardScopeCapError) {
          log.warn(
            {
              action: 'blocklist_scope_cap_exceeded',
              pattern: pathPattern,
              scopeCount: err.scopeCount,
              cap: err.cap,
            },
            'pattern matched scope exceeds cap — entry NOT inserted',
          );
          return jsonResponse(
            {
              error: 'blocklist_scope_too_large',
              scopeCount: err.scopeCount,
              cap: err.cap,
              requestId,
            },
            409,
          );
        }
        throw err;
      }

      if (txResult.kind === 'idempotent') {
        // SR3: dedicated audit event for idempotent re-POSTs.
        log.info(
          {
            action: 'blocklist_added_idempotent_noop',
            entryId: txResult.row.id,
            pattern: pathPattern,
          },
          'blocklist pattern re-POST — idempotent noop (no re-flip)',
        );
        return jsonResponse(
          {
            id: txResult.row.id,
            fileId: txResult.row.file_id,
            pathPattern: txResult.row.path_pattern,
            reason: txResult.row.reason,
            createdAt: txResult.row.created_at,
            idempotent: true,
            requestId,
          },
          200,
        );
      }

      log.info(
        {
          action: 'blocklist_added',
          entryId: txResult.row.id,
          mode: 'pattern',
          reason: 'operator',
        },
        'blocklist entry added (pattern)',
      );

      // SR2: per-fileId SOC2 audit-trail for each flipped file.
      for (const f of txResult.flipped) {
        log.info(
          {
            action: 'file_status_changed_by_blocklist_pattern',
            fileId: f.id,
            previousStatus: f.previousStatus,
            newStatus: 'blocklisted',
            entryId: txResult.row.id,
            pattern: pathPattern,
          },
          'file status changed by retroactive blocklist pattern flip',
        );
      }

      // 22-03 T1: compute extension-warning ONCE for both created-branches.
      // audit-M3: try/catch around helper — exception must NOT 500 the POST.
      // audit-M2: clamp pattern in log payloads to LOG_PATTERN_MAX_CHARS.
      let extensionWarning: ExtensionWarningPayload | null = null;
      try {
        extensionWarning = composeExtensionWarning(pathPattern);
      } catch (err) {
        extensionWarning = null;
        log.warn(
          {
            action: 'blocklist_pattern_warn_helper_error',
            error: (err as Error)?.message ?? String(err),
            pattern: clampPatternForLog(pathPattern),
            entryId: txResult.row.id,
          },
          'extension-warning helper threw — suppressing warning',
        );
      }
      if (extensionWarning) {
        log.debug(
          {
            action: 'blocklist_pattern_warn_no_scan_ext',
            entryId: txResult.row.id,
            pattern: clampPatternForLog(pathPattern),
            resolvedExt: extensionWarning.resolvedExt,
            scanExtensions: extensionWarning.scanExtensions,
          },
          'pattern resolves to extension not in any share scan-extensions',
        );
      }

      if (txResult.flippedCount > 0) {
        const fullFlippedIds = txResult.flipped.map((f) => f.id);
        // SR5: warn-level threshold for high-impact ops paging.
        const logFn =
          txResult.flippedCount >= ENCODE_GUARD_WARN_THRESHOLD
            ? log.warn.bind(log)
            : log.info.bind(log);
        logFn(
          {
            action: 'pattern_retroactive_flip',
            entryId: txResult.row.id,
            pattern: pathPattern,
            flippedCount: txResult.flippedCount,
            flippedIds: fullFlippedIds,
          },
          'pattern retroactive flip — eligible files flipped to blocklisted',
        );
        // SR4: bounded response body; full list still in pino.
        const truncated = fullFlippedIds.length > ENCODE_GUARD_FLIP_RESPONSE_CAP;
        const responseFlippedIds = truncated
          ? fullFlippedIds.slice(0, ENCODE_GUARD_FLIP_RESPONSE_CAP)
          : fullFlippedIds;
        return jsonResponse(
          {
            id: txResult.row.id,
            fileId: txResult.row.file_id,
            pathPattern: txResult.row.path_pattern,
            reason: txResult.row.reason,
            createdAt: txResult.row.created_at,
            flippedCount: txResult.flippedCount,
            flippedIds: responseFlippedIds,
            ...(truncated && {
              flippedIdsTruncated: true,
              flippedIdsTotalCount: fullFlippedIds.length,
            }),
            ...(extensionWarning && { extensionWarning }),
            requestId,
          },
          200,
        );
      }

      // flippedCount === 0: entry created, no eligible matches.
      return jsonResponse(
        {
          id: txResult.row.id,
          fileId: txResult.row.file_id,
          pathPattern: txResult.row.path_pattern,
          reason: txResult.row.reason,
          createdAt: txResult.row.created_at,
          flippedCount: 0,
          flippedIds: [],
          ...(extensionWarning && { extensionWarning }),
          requestId,
        },
        200,
      );
    }
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/library/[id]/blocklist POST: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}

export async function DELETE(req: Request, ctx: RouteContext): Promise<Response> {
  // 05-01 Plan T3: requireAuth gate.
  const __auth = await requireAuth(req);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse({ skipped: true, reason: 'build-time-skip', requestId: 'build' }, 200);
  }

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/library/[id]/blocklist' });

  const params = await ctx.params;
  // For DELETE, :id is the blocklist_entry.id (NOT file_id).
  const entryId = parseInt(params.id, 10);
  if (!Number.isFinite(entryId) || entryId <= 0) {
    return jsonResponse({ error: 'invalid_entry_id', requestId }, 400);
  }

  try {
    const entry = blocklistRepo().findById(entryId);
    if (!entry) {
      // audit S4: idempotent flag in 404 body — caller can treat 404+idempotent=true as success.
      return jsonResponse({ error: 'not_found', idempotent: true, requestId }, 404);
    }

    // audit M3: setStatus restoration — only flip 'blocklisted' → 'pending'.
    if (entry.file_id !== null) {
      const file = fileRepo().getById(entry.file_id);
      if (file && file.status === 'blocklisted') {
        fileRepo().setStatus(file.id, 'pending', file.version);
      } else if (file) {
        log.info(
          {
            action: 'status_preserve_on_unblocklist',
            fileId: file.id,
            currentStatus: file.status,
          },
          'file status preserved (not blocklisted) — unblocklist did not flip',
        );
      }
    }

    blocklistRepo().remove(entryId);
    log.info(
      { action: 'blocklist_removed', entryId, fileId: entry.file_id },
      'blocklist entry removed',
    );

    return jsonResponse({ removed: true, requestId }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/library/[id]/blocklist DELETE: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
