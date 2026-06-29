import { gateAuth } from '@/src/lib/api/auth-gate';
import { jsonResponse } from '@/src/lib/api/json-response';
import { probeRenderDevices } from '@/src/lib/diagnostics/render-device-probe';
import type { RenderDeviceOption } from '@/src/lib/api/settings-serialize';
import { logger } from '@/src/lib/logger';

// 34-02 Plan Task 1 — GET /api/encoders/render-devices.
// Shared lightweight probe-list endpoint for the GPU device-picker. The Settings
// page is server-probed (D1=A, zero client fetch), but the onboarding HW-accel
// step is a client component (D2=B) and needs an endpoint to fetch the live
// render-node list. Mirrors the other app/api/encoders/* route ergonomics:
// gateAuth first → NEXT_PHASE build-skip → probe.
//
// Contract (audit SR-2): NEVER 500. probeRenderDevices already returns [] on no
// /dev/dri, but the map + response assembly CAN throw — the whole probe+map is
// try/catch-hardened to 200 [] so a picker fetch can never error the wizard.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  // Auth gate FIRST (mirror /api/encoders/refresh ordering exactly).
  const { denied } = await gateAuth(request);
  if (denied) return denied;

  // Build guard: skip the device probe during `next build` static analysis.
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return jsonResponse([], 200);
  }

  const log = logger.child({ route: '/api/encoders/render-devices' });
  try {
    const probes = await probeRenderDevices();
    const out: RenderDeviceOption[] = probes.map((p) => ({
      path: p.path,
      node: p.path.split('/').pop() ?? p.path,
      exists: p.exists,
      readable: p.readable,
      writable: p.writable,
      groupName: p.groupName,
      inRenderGroup: p.inRenderGroup,
    }));
    return jsonResponse(out, 200);
  } catch (err) {
    // audit SR-2: any throw in probe/map/assembly → 200 [] (NOT 500). The picker
    // degrades to Auto-only, which is the byte-identical pre-34 default.
    log.warn(
      { err: err instanceof Error ? err.stack : String(err) },
      'render-devices probe failed — returning empty list',
    );
    return jsonResponse([], 200);
  }
}
