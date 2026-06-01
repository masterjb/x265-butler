import crypto from 'node:crypto';
import { z } from 'zod';
import { settingRepo, shareRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';

// 14-04 (Plan 14-04 Task 6): POST /api/onboarding/complete now translates
// stashed step-2 values into a share create / PATCH-placeholder / 409
// already-customized response per audit-fix M3 (AC-16a/b/c). Final step still
// sets `setting.onboarding_completed='true'`.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 03-05 onboarding default extensions + max_depth — used when wizard does
// not collect them (current 4-step flow only collects scan_root + min_size_mb
// at step 2). Mirrors 0001_initial.sql legacy seed for symmetry.
const ONBOARDING_DEFAULT_EXT_CSV = 'mp4,mkv,avi,mov,m4v,webm,ts,m2ts,wmv';
const ONBOARDING_DEFAULT_MAX_DEPTH = 12;

const completeBodySchema = z
  .object({
    scan_root: z.string().min(1).startsWith('/').max(4096).optional(),
    min_size_mb: z.number().int().min(0).max(102_400).optional(),
    extensions_csv: z.string().min(1).max(512).optional(),
    max_depth: z.number().int().min(0).max(50).nullable().optional(),
  })
  .strict();

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function POST(req: Request): Promise<Response> {
  const __auth = await requireAuth(req);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse({ completed: false, reason: 'build-time-skip', requestId: 'build' }, 200);
  }

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/onboarding/complete' });

  // 14-04: body is now {scan_root?, min_size_mb?, ...}. Tolerate empty body
  // (legacy onboarding-completion-only path) so operator scripts that only
  // toggle the flag stay working.
  const bodyText = await req.text();
  let body: {
    scan_root?: string;
    min_size_mb?: number;
    extensions_csv?: string;
    max_depth?: number | null;
  } = {};
  if (bodyText.length > 0) {
    const trimmed = bodyText.trim();
    if (trimmed !== '' && trimmed !== '{}') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        log.warn({ action: 'onboarding_complete_invalid_json' }, 'rejecting non-JSON body');
        return jsonResponse({ error: 'invalid_body', requestId }, 400);
      }
      const result = completeBodySchema.safeParse(parsed);
      if (!result.success) {
        log.warn(
          { action: 'onboarding_complete_validation_failed', issues: result.error.issues },
          'rejecting non-conforming body',
        );
        return jsonResponse(
          { error: 'invalid_body', details: result.error.issues, requestId },
          400,
        );
      }
      body = result.data;
    }
  }

  try {
    const shares = shareRepo().listAll();
    let shareAction: 'created' | 'updated' | 'none' = 'none';
    let resolvedShareId: number | null = null;

    if (body.scan_root) {
      // Translate stashed step-2 input into share-create / PATCH per AC-16.
      const shareInput = {
        name: 'Library',
        path: body.scan_root,
        min_size_mb: body.min_size_mb ?? 50,
        extensions_csv: body.extensions_csv ?? ONBOARDING_DEFAULT_EXT_CSV,
        max_depth: body.max_depth === undefined ? ONBOARDING_DEFAULT_MAX_DEPTH : body.max_depth,
      };

      if (shares.length === 0) {
        // AC-16a: truly empty — create the first share.
        const created = shareRepo().create(shareInput);
        shareAction = 'created';
        resolvedShareId = created.id;
        log.info(
          { action: 'onboarding_share_created', shareId: created.id },
          'first share created via onboarding',
        );
      } else if (
        shares.length === 1 &&
        shares[0].name === 'Library' &&
        shares[0].path === '/media' &&
        shares[0].created_at === shares[0].updated_at
      ) {
        // AC-16b: 14-01 backfill placeholder — PATCH with operator values.
        const before = shares[0];
        // assertNonNested defensively (no other shares present, so this is a
        // no-op in practice; preserves the invariant if downstream policy
        // changes).
        shareRepo().assertNonNested({ path: shareInput.path, excludeId: before.id });
        const updated = shareRepo().update(before.id, {
          name: shareInput.name,
          path: shareInput.path,
          min_size_mb: shareInput.min_size_mb,
          extensions_csv: shareInput.extensions_csv,
          max_depth: shareInput.max_depth,
        });
        shareAction = 'updated';
        resolvedShareId = before.id;
        log.info(
          {
            action: 'onboarding_share_updated',
            shareId: before.id,
            before,
            after: updated,
          },
          'placeholder share PATCHed via onboarding',
        );
      } else {
        // AC-16c: operator already customized — reject with 409.
        log.warn(
          { action: 'onboarding_already_completed', knownShareCount: shares.length },
          'rejecting re-run of onboarding wizard',
        );
        return jsonResponse(
          {
            error: 'onboarding_already_completed',
            knownShares: shares.map((s) => ({ id: s.id, name: s.name })),
            requestId,
          },
          409,
        );
      }
    }

    settingRepo().set('onboarding_completed', 'true');
    log.info(
      {
        action: 'onboarding_completed',
        timestamp: Math.floor(Date.now() / 1000),
        shareAction,
        shareId: resolvedShareId,
      },
      'first-run wizard completed',
    );

    // 20-01 Task 2-bis (AC-11): server-side audit log discriminating skip-branch
    // (placeholder verbatim match) from override (operator-edited mid-flow).
    // Uses pre-mutation `shares` snapshot so the discriminator reflects the
    // placeholderShare visible at wizard-entry time. Additive — zero functional
    // change to response shape / status / idempotency.
    const preMutationPlaceholder = shares[0];
    const sentScanRoot = body.scan_root;
    const sentMinSizeMb = body.min_size_mb;
    const matchesPlaceholder =
      preMutationPlaceholder !== undefined &&
      sentScanRoot === preMutationPlaceholder.path &&
      Number(sentMinSizeMb) === Number(preMutationPlaceholder.min_size_mb);
    if (matchesPlaceholder) {
      log.info(
        {
          action: 'wizard_completed_via_auto_skip_path',
          share_path: preMutationPlaceholder.path,
          share_id: preMutationPlaceholder.id,
          locale: req.headers.get('accept-language') ?? 'unknown',
        },
        'wizard completed via skip-branch — no path override',
      );
    } else {
      log.info(
        {
          action: 'wizard_completed_with_override',
          payload_scan_root: sentScanRoot ?? null,
          placeholder_path: preMutationPlaceholder?.path ?? null,
        },
        'wizard completed with operator path override',
      );
    }

    return jsonResponse({ completed: true, shareAction, shareId: resolvedShareId, requestId }, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/onboarding/complete: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
