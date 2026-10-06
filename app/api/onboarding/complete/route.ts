import crypto from 'node:crypto';
import { z } from 'zod';
import { settingRepo, shareRepo } from '@/src/lib/db';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { AUTO_ENCODE_KEY } from '@/src/lib/queue/auto-encode';
import { triggerAutoEncodeSweep } from '@/src/lib/watch';

import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
import { pathSchema } from '@/src/lib/api/shares-zod';

// POST /api/onboarding/complete translates stashed step-2 values into a share
// create / PATCH-placeholder / 409 already-customized response. Final step
// still sets `setting.onboarding_completed='true'`.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Onboarding default extensions + max_depth — used when wizard does
// not collect them (current 4-step flow only collects scan_root + min_size_mb
// at step 2). Mirrors 0001_initial.sql legacy seed for symmetry.
const ONBOARDING_DEFAULT_EXT_CSV = 'mp4,mkv,avi,mov,m4v,webm,ts,m2ts,wmv';
const ONBOARDING_DEFAULT_MAX_DEPTH = 12;

// Re-exported so `src/lib/scan/media-eligibility.ts` can be held against the
// LIVING default instead of a fifth typed copy of the list. This route is the
// source a fresh install actually writes into `shares.extensions_csv`, so it is
// the anchor that notices drift.
export { ONBOARDING_DEFAULT_EXT_CSV };

// `scan_root` used to be
// `z.string().min(1).startsWith('/').max(4096)` — no `..`-reject, no NUL-reject,
// no double-slash collapse. Bolting a prefix refine onto THAT string would have
// been bypassable three ways ('//sys', '/mnt/../sys', a NUL byte), so the field
// now reuses the EXPORTED `pathSchema` from shares-zod: absolute-check,
// traversal-reject, NUL-reject, collapse AND the forbidden-prefix guard in one
// object, from the same source the shares API validates against.
//
// Deliberate side effect: this route now also rejects `..` and NUL, which it
// previously accepted — a hardening. The wizard never produced such a value.
// The 400 SHAPE is unchanged (`invalid_body` + `details`), NOT converted to
// `validation_failed`.
const completeBodySchema = z
  .object({
    scan_root: pathSchema.optional(),
    min_size_mb: z.number().int().min(0).max(102_400).optional(),
    extensions_csv: z.string().min(1).max(512).optional(),
    max_depth: z.number().int().min(0).max(50).nullable().optional(),
    // The wizard's "Automatisch encodieren" choice. Optional so
    // flag-only operator scripts keep working (absent → value untouched).
    auto_encode: z.boolean().optional(),
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
  const { denied } = await gateAuth(req);
  if (denied) return denied;

  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse({ completed: false, reason: 'build-time-skip', requestId: 'build' }, 200);
  }

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/onboarding/complete' });

  // Body is {scan_root?, min_size_mb?, ...}. Tolerate empty body
  // (legacy onboarding-completion-only path) so operator scripts that only
  // toggle the flag stay working.
  const bodyText = await req.text();
  let body: {
    scan_root?: string;
    min_size_mb?: number;
    extensions_csv?: string;
    max_depth?: number | null;
    auto_encode?: boolean;
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
      // Translate stashed step-2 input into share-create / PATCH / 409.
      const shareInput = {
        name: 'Library',
        path: body.scan_root,
        min_size_mb: body.min_size_mb ?? 50,
        extensions_csv: body.extensions_csv ?? ONBOARDING_DEFAULT_EXT_CSV,
        max_depth: body.max_depth === undefined ? ONBOARDING_DEFAULT_MAX_DEPTH : body.max_depth,
      };

      if (shares.length === 0) {
        // Truly empty — create the first share.
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
        // Backfilled placeholder share — PATCH with operator values.
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
        // Operator already customized — reject with 409.
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

    // Written only here, after every 400/409 return of the
    // share handling above, so a rejected wizard run changes nothing. Same
    // settings_change line as the settings PUT for the audit trail. The sweep
    // runs after the share is final, so it only picks up files the operator
    // actually configured.
    if (body.auto_encode !== undefined) {
      const newValue = body.auto_encode ? 'true' : 'false';
      const oldValue = settingRepo().get(AUTO_ENCODE_KEY) ?? null;
      log.info(
        { requestId, key: AUTO_ENCODE_KEY, oldValue, newValue, action: 'settings_change' },
        'settings_change',
      );
      settingRepo().set(AUTO_ENCODE_KEY, newValue);
      if (newValue === 'true' && oldValue !== 'true') {
        log.info(
          { action: 'auto_encode_enabled' },
          'auto-encode switched on — sweeping pending files',
        );
        triggerAutoEncodeSweep(log);
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

    // Server-side audit log discriminating skip-branch
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
