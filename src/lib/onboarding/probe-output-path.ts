// Phase 23 Plan 23-03 — onboarding writable-gate output-path probe.
//
// Pure, deps-injectable permission probe for a single output mount. Mirrors the
// R_OK/W_OK + errCode shape of src/lib/diagnostics/mount-probe.ts WITHOUT
// importing it (dedicated onboarding helper — 23-02 render-device-probe
// precedent). Never throws upward: each fs.access call is wrapped in its own
// try/catch so an EACCES/ENOENT on one access can never abort the other.

import { access, constants } from 'node:fs/promises';

export interface OutputPathProbe {
  path: string;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  error?: string;
}

export interface ProbeOutputPathDeps {
  // Injected in tests; defaults to node:fs/promises.access in production.
  access?: typeof access;
}

// Local copy of mount-probe.ts's string-narrowing helper. Deliberately NOT
// exported from mount-probe.ts — onboarding stays decoupled from diagnostics.
function errCode(err: unknown): string {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code?: unknown }).code === 'string'
  ) {
    return (err as { code: string }).code;
  }
  return 'UNKNOWN';
}

export async function probeOutputPath(
  path: string,
  deps: ProbeOutputPathDeps = {},
): Promise<OutputPathProbe> {
  const accessFn = deps.access ?? access;

  let readable = false;
  let readErr: string | undefined;
  try {
    await accessFn(path, constants.R_OK);
    readable = true;
  } catch (err) {
    readErr = errCode(err);
  }

  let writable = false;
  let writeErr: string | undefined;
  try {
    await accessFn(path, constants.W_OK);
    writable = true;
  } catch (err) {
    writeErr = errCode(err);
  }

  // SINGLE canonical existence rule: exists:false ⟺ the R_OK error is exactly
  // 'ENOENT'. A node that exists but denies both R_OK and W_OK (EACCES on both)
  // reports exists:true readable:false writable:false. W_OK's error never feeds
  // `exists` (audit-fix M1).
  const exists = readErr !== 'ENOENT';

  const out: OutputPathProbe = { path, exists, readable, writable };
  // Prefer the write error (more actionable for the operator); else read error.
  const error = writeErr ?? readErr;
  if (error) out.error = error;
  return out;
}
