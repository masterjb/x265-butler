import crypto from 'node:crypto';
import { settingRepo } from '@/src/lib/db';
import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
import {
  detectEncoders,
  ENCODER_IDS,
  invalidateEncoderCache,
  invalidateOrchestratorDetectionCache,
  recomputePerEncoderLimits,
  type EncoderId,
} from '@/src/lib/encode';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

// 03-03 Plan Task 1 — POST /api/encoders/refresh.
// Operator-confirmed-change hook: Settings UI calls this after a successful
// PUT /api/settings that touched encoder/concurrency/crf_* keys. The endpoint
// triggers fresh detection + slot-limit recompute so the next encoded job
// reflects the operator's new choice WITHOUT a container restart.
//
// Sequence (audit M3 — order matters):
//   1. invalidateEncoderCache()                     — globalThis cache
//   2. invalidateOrchestratorDetectionCache()       — module-local _detectionResult
//   3. await detectEncoders({ force: true })        — re-probe + write fresh globalThis
//   4. recomputePerEncoderLimits()                  — re-read settings.concurrency + cpus
//
// Without step 2 (audit M3), the orchestrator's module-local cache survives
// invalidation and processOne dispatches with stale boot-time detection until
// container restart — defeating the entire refresh UX.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  // 05-01 Plan T3: requireAuth gate.
  const { denied } = await gateAuth(request);
  if (denied) return denied;

  // audit S2 (build guard, mirrors 02-03 + 03-01 pattern): skip detection
  // during `next build` static analysis so the encoder loop is not spawned
  // at build time.
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse({ refreshed: false, reason: 'build-time-skip', requestId: 'build' }, 200);
  }

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/encoders/refresh' });

  try {
    // audit S7: capture previous active encoder BEFORE invalidation so the
    // diff trail can answer "what was it before?" in support tickets.
    const previousActive = settingRepo().get('encoder') ?? 'auto';

    // audit M3 — order matters; see file header.
    invalidateEncoderCache();
    invalidateOrchestratorDetectionCache();
    const det = await detectEncoders({ force: true });
    recomputePerEncoderLimits();

    // Resolve active per the same rule set as GET /api/encoders (03-01 audit
    // S2 + S5 — capacity-aware fallback NOT applied here; that's processOne
    // dispatch responsibility. Refresh just reports settings-level intent vs
    // detection availability.).
    const requestedRaw = settingRepo().get('encoder');
    let requested: EncoderId | 'auto';
    if (requestedRaw === undefined || requestedRaw === 'auto') {
      requested = 'auto';
    } else if ((ENCODER_IDS as readonly string[]).includes(requestedRaw)) {
      requested = requestedRaw as EncoderId;
    } else {
      log.warn({ action: 'encoder_setting_invalid', value: requestedRaw }, 'invalid setting');
      requested = 'auto';
    }

    let active: EncoderId;
    let resolution: 'auto' | 'override' | 'fallback';
    let requestedButUnavailable: EncoderId | undefined;
    if (requested === 'auto') {
      active = det.activeFromAuto;
      resolution = 'auto';
    } else if (det.detected.includes(requested)) {
      active = requested;
      resolution = 'override';
    } else {
      requestedButUnavailable = requested;
      active = 'libx265';
      resolution = 'fallback';
    }

    // audit S7 — diff trail for operator-visible change.
    log.info(
      {
        action: 'encoders_refreshed',
        detected: det.detected,
        active,
        resolution,
        previousActive,
      },
      'encoder cache invalidated + re-probed + perEncoderLimits recomputed',
    );

    // audit S9 — distinct log line ONLY when active actually changed.
    // Distinguishes state transitions from no-op refreshes for grep + alerting.
    if (previousActive !== active) {
      log.info(
        { action: 'encoders_active_changed', from: previousActive, to: active },
        'active encoder changed',
      );
    }

    return jsonResponse(
      {
        refreshed: true,
        detected: det.detected,
        active,
        resolution,
        requestedButUnavailable,
        devicePath: det.vaapiDevice,
        requestId,
      },
      200,
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/encoders/refresh: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
