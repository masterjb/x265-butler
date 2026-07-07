import crypto from 'node:crypto';
import { z } from 'zod';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';
import { probeOutputPath } from '@/src/lib/onboarding/probe-output-path';

import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';

// Phase 23 Plan 23-03 — POST /api/onboarding/probe-path.
//
// Minimal boolean permission oracle for the wizard writable-gate. Probes a
// single output mount (scan_root) from the container's point of view and
// returns EXACTLY { path, exists, readable, writable, error?, requestId } — no
// stat/mode/uid/gid/contents/listing keys (SR4). Auth-gated + zod-validated +
// build-time-skip, mirroring app/api/onboarding/complete/route.ts ceremony.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const probeBodySchema = z
  .object({
    path: z.string().min(1).startsWith('/').max(4096),
    acknowledged: z.boolean().optional(),
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
  const { denied } = await gateAuth(req);
  if (denied) return denied;

  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse({ skipped: true, requestId: 'build' }, 200);
  }

  ensureServerInit();
  const requestId = crypto.randomUUID();
  const log = logger.child({ requestId, route: '/api/onboarding/probe-path' });

  // Parse + validate BEFORE any filesystem touch (AC-2: bad input never hits fs).
  const bodyText = await req.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    log.warn({ action: 'onboarding_probe_path_invalid_json' }, 'rejecting non-JSON body');
    return jsonResponse({ error: 'invalid_body', requestId }, 400);
  }
  const result = probeBodySchema.safeParse(parsed);
  if (!result.success) {
    log.warn(
      { action: 'onboarding_probe_path_validation_failed', issues: result.error.issues },
      'rejecting non-conforming body',
    );
    return jsonResponse({ error: 'invalid_body', details: result.error.issues, requestId }, 400);
  }
  const body = result.data;

  try {
    const probe = await probeOutputPath(body.path);

    if (probe.writable === false) {
      // Server-side audit trail of the non-writable surface (operator-side).
      log.warn(
        { action: 'onboarding_output_path_not_writable', path: body.path, error: probe.error },
        'onboarding output path is not writable',
      );
    }

    if (body.acknowledged === true) {
      // Durable server-side record that the operator saw the non-writable
      // warning and chose to proceed (audit-defensible; browser log alone is
      // not). SR1 — onboarding-client.tsx stays untouched.
      log.warn(
        { action: 'onboarding_output_path_override_acknowledged', path: body.path },
        'operator acknowledged non-writable output path override',
      );
    }

    // RESPONSE SHAPE IS EXACTLY these 6 keys (SR4). NEVER add stat()/mode-bits/
    // uid/gid/contents/directory-listing.
    const out: {
      path: string;
      exists: boolean;
      readable: boolean;
      writable: boolean;
      error?: string;
      requestId: string;
    } = {
      path: probe.path,
      exists: probe.exists,
      readable: probe.readable,
      writable: probe.writable,
      requestId,
    };
    if (probe.error) out.error = probe.error;
    return jsonResponse(out, 200);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.stack : String(err) },
      '/api/onboarding/probe-path: unexpected error',
    );
    return jsonResponse({ error: 'internal_error', requestId }, 500);
  }
}
