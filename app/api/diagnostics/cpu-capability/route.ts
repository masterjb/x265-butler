// 23-05: GET /api/diagnostics/cpu-capability — lean auth-gated read-only sibling
// of the diagnostics surface. Returns the boot-cached CpuCapability so the
// onboarding CpuCapabilityAdvisory can decide whether to surface a libx265
// recommendation for a pre-Skylake iGPU. NO behavior on the encode/detection
// path — this is a dedicated diagnostics route (D2=A), NOT a DetectionPayload
// extension.
//
// Contract (mirrors /api/bench/recommendation + /api/diagnostics envelope):
//   200 { cpu: CpuCapability, requestId }   no-store
//   401 { error_code: 'auth_required' }      (shared requireAuth/authGuard)
//   500 { error: 'internal_error', requestId }

import crypto from 'node:crypto';
import { withRenewCookie } from '@/src/lib/auth/require-auth';
import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
import { getCpuCapability } from '@/src/lib/diagnostics/cpu-capability';
import { logger } from '@/src/lib/logger';
import { ensureServerInit } from '@/src/lib/server-init';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const { denied, auth } = await gateAuth(request);
  if (denied) return denied;

  ensureServerInit();
  const requestId = crypto.randomUUID();

  try {
    const cpu = await getCpuCapability();
    return withRenewCookie(jsonResponse({ cpu, requestId }, 200), auth);
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.stack : String(err),
        route: '/api/diagnostics/cpu-capability',
      },
      'cpu_capability_route_failed',
    );
    return withRenewCookie(jsonResponse({ error: 'internal_error', requestId }, 500), auth);
  }
}
