// 29-02 — node:fs-free leaf so the single-source group-fix predicate can be
// imported by BOTH the server markdown template AND the 'use client'
// diagnostics component without dragging render-device-probe.ts's `node:fs`
// import into the client bundle (next build rejects `node:fs` in client code).
//
// render-device-probe.ts re-exports this so server-side `import { groupFixRelevant }
// from './render-device-probe'` call-sites and unit tests keep resolving. There
// is exactly ONE definition (anti-drift, the 29-01 PROBE_FRAME_SIZE lesson).

import type { RenderDeviceProbe } from './types';

// Is a PGID / --group-add group-membership fix ACTUALLY relevant for this device?
// Only when the node exists AND the kernel is denying R or W. A readable+writable
// node needs no group change regardless of inRenderGroup (rasalf's case: gid 18,
// R+W both pass, not in group → no fix).
export function groupFixRelevant(d: RenderDeviceProbe): boolean {
  return d.exists === true && (d.readable === false || d.writable === false);
}
