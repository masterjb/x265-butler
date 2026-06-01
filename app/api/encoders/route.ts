import crypto from 'node:crypto';
import { settingRepo } from '@/src/lib/db';
import { detectEncoders, ENCODER_IDS, type EncoderId } from '@/src/lib/encode';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

import { authGuard, requireAuth } from '@/src/lib/auth/require-auth';
// 03-01 Plan Task 3 — GET /api/encoders.
// Mirrors 02-03 Route Handler envelope (runtime='nodejs', force-dynamic,
// ensureServerInit, no-store, requestId). Audit additions land here:
//   S2  ENCODER_IDS validation against tampered settings.encoder values.
//   S2  NEXT_PHASE='phase-production-build' short-circuit (per 02-03 S2).
//   S5  resolution: 'auto'|'override'|'fallback' so UI distinguishes
//       auto-resolve from operator-pin from unavailable-fallback.
//   S6  devicePath echoed back so the future Settings UI can show the
//       VAAPI device that will actually be used.

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

export async function GET(request: Request): Promise<Response> {
  // 05-01 Plan T3: requireAuth gate.
  const __auth = await requireAuth(request);
  const __denied = authGuard(__auth);
  if (__denied) return __denied;

  // audit S2 (build guard): skip detection during `next build` static analysis
  // so the encoder loop is not spawned at build time.
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse(
      { detected: ['libx265'], active: 'libx265', resolution: 'auto', requestId: 'build' },
      200,
    );
  }

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/encoders' });

  try {
    const det = await detectEncoders();
    const requestedRaw = settingRepo().get('encoder');

    // audit S2: validate against ENCODER_IDS tuple before EncoderId cast.
    let requested: EncoderId | 'auto';
    if (requestedRaw === undefined || requestedRaw === 'auto') {
      requested = 'auto';
    } else if ((ENCODER_IDS as readonly string[]).includes(requestedRaw)) {
      requested = requestedRaw as EncoderId;
    } else {
      log.warn(
        { action: 'encoder_setting_invalid', value: requestedRaw },
        'invalid settings.encoder — defaulting to auto resolution',
      );
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

    return jsonResponse(
      {
        detected: det.detected,
        active,
        resolution,
        requestedButUnavailable,
        devicePath: det.vaapiDevice,
        // Phase 18 Plan 18-01 Task 4: AC-4 stable-shape passthrough — ALWAYS
        // emitted, NEVER omitted. Empty array when no warnings.
        warnings: det.warnings,
        requestId,
      },
      200,
    );
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/encoders: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
