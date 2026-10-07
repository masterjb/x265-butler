// Hash-free recognition of a file a sidecar already describes. A side matches
// only when size AND mtime are recorded and equal to the file on disk: the same
// trust the scan's unchanged fast path places in a known row. Anything less
// (older sidecars carry no mtime) returns null and the caller hashes.
import type { SidecarPayload } from '../encode/sidecar';

type SideKey = { hash: string; size: number; mtime?: number };

// Compact on purpose: a first scan of a large processed library holds one of
// these per file until the verify phase runs, the full payload would not fit.
export type SidecarVerifyKeys = { output: SideKey | null; source: SideKey | null };

function sideKey(
  side: { contentHash?: unknown; sizeBytes?: unknown; mtime?: number } | undefined,
): SideKey | null {
  if (!side || typeof side.contentHash !== 'string' || typeof side.sizeBytes !== 'number') {
    return null;
  }
  return { hash: side.contentHash.toLowerCase(), size: side.sizeBytes, mtime: side.mtime };
}

export function toVerifyKeys(payload: SidecarPayload): SidecarVerifyKeys {
  return { output: sideKey(payload.output), source: sideKey(payload.source) };
}

// An absent mtime never equals a number, so older sidecars fall through.
// Output first: after an encode the file on disk is far more often the output.
export function matchSidecar(
  keys: SidecarVerifyKeys,
  disk: { size: number; mtime: number },
): string | null {
  for (const key of [keys.output, keys.source]) {
    if (key && key.size === disk.size && key.mtime === disk.mtime) {
      return key.hash;
    }
  }
  return null;
}
