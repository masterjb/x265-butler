// Mount-permission probe (R+W) over static + dynamic paths.
//
// Never throws upward. Each fs.access is wrapped in try/catch. Dynamic set
// pulled via shareRepo().listAll(); failure of the DB call drops back to
// static-only probing without aborting the diagnostics request.
//
// Only MAPPED paths are probed. Static /media is gone: every configured
// share is probed dynamically, and an unmapped /media without a share is no
// fault (it used to be a root-owned anonymous VOLUME → false EACCES). /cache is
// optional: probed only when it exists; mapped-but-broken
// stays an error because the resolver silently falls back to /config/cache.

import { access, constants } from 'node:fs/promises';
import { shareRepo } from '@/src/lib/db';
import type { MountProbeResult } from './types';

const STATIC_PATHS = ['/config'] as const;
const OPTIONAL_PATHS = ['/cache'] as const;

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

  const optionalPaths: string[] = [];
  for (const p of OPTIONAL_PATHS) {
    if (await existsOrUnknown(p)) optionalPaths.push(p);
  }

  const unique = Array.from(new Set<string>([...STATIC_PATHS, ...optionalPaths, ...dynamicPaths]));
  return Promise.all(unique.map((p) => probePath(p)));
}

// false only on a definite ENOENT; any other F_OK failure keeps the path in the
// probe so the real error surfaces.
async function existsOrUnknown(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch (err) {
    return errCode(err) !== 'ENOENT';
  }
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
