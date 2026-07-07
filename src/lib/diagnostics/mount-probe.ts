// Phase 21 Plan 21-01 — V1 mount-permission probe (R+W) over static + dynamic paths.
//
// Never throws upward. Each fs.access is wrapped in try/catch. Dynamic set
// pulled via shareRepo().listAll(); failure of the DB call drops back to
// static-only probing without aborting the diagnostics request.

import { access, constants } from 'node:fs/promises';
import { shareRepo } from '@/src/lib/db';
import type { MountProbeResult } from './types';

const STATIC_PATHS = ['/media', '/cache', '/config'] as const;

export async function probeMounts(): Promise<MountProbeResult[]> {
  const dynamicPaths: string[] = [];
  try {
    const shares = shareRepo().listAll();
    for (const s of shares) {
      if (typeof s.path === 'string' && s.path.length > 0) {
        dynamicPaths.push(s.path);
      }
    }
  } catch {
    // dynamic set stays empty; static probes still run.
  }

  const unique = Array.from(new Set<string>([...STATIC_PATHS, ...dynamicPaths]));
  return Promise.all(unique.map((p) => probePath(p)));
}

async function probePath(p: string): Promise<MountProbeResult> {
  let readable = false;
  let readErr: string | undefined;
  try {
    await access(p, constants.R_OK);
    readable = true;
  } catch (err) {
    readErr = errCode(err);
  }
  let writable = false;
  let writeErr: string | undefined;
  try {
    await access(p, constants.W_OK);
    writable = true;
  } catch (err) {
    writeErr = errCode(err);
  }
  const out: MountProbeResult = { path: p, readable, writable };
  // Prefer the write error (more actionable for operator); else the read error.
  const error = writeErr ?? readErr;
  if (error) out.error = error;
  return out;
}

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
