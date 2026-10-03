// Phase 35 Plan 35-02 — dep-free crop-geometry validator.
//
// Extracted VERBATIM from cropdetect.ts (35-01) so BOTH the server route zod AND
// the client settings formSchema can import the SAME validator without bundling
// cropdetect.ts's `node:child_process` import into the client (AC-5 single source,
// zero client/server drift). This module imports NOTHING from node:* — keep it
// that way so it stays client-safe.
//
// parseCropGeometry validates 4 integer fields, positive even W/H, non-negative
// even X/Y (HEVC 4:2:0 needs even luma dims; odd-but-parseable geometry would make
// the ffmpeg crop filter / x265 encode FAIL at runtime → job dies → so odd dims
// are rejected here, audit SR-2).

/**
 * Normalize a `W:H:X:Y` crop geometry (also tolerating a leading `crop=`).
 * Returns the normalized `"W:H:X:Y"` string (NO `crop=` prefix — the per-encoder
 * builders add `crop=`), or null for anything malformed / out-of-range / odd.
 *
 * Shared by the override path (orchestrator), detectCrop's stderr parse, the
 * server route zod (PUT /api/settings) and the client settings formSchema.
 */
export function parseCropGeometry(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let s = raw.trim();
  if (s === '') return null;
  if (s.startsWith('crop=')) s = s.slice('crop='.length);

  const parts = s.split(':');
  if (parts.length !== 4) return null;

  const nums = parts.map((p) => {
    const t = p.trim();
    // Strict integer (allow a leading minus so we can reject it below with a
    // clear range check rather than silently NaN-ing). No decimals/hex/units.
    return /^-?\d+$/.test(t) ? parseInt(t, 10) : NaN;
  });
  const [w, h, x, y] = nums;
  if (!nums.every((n) => Number.isInteger(n))) return null;

  // Range: positive dims, non-negative offsets.
  if (w <= 0 || h <= 0 || x < 0 || y < 0) return null;
  // audit SR-2: even-dimension requirement (HEVC 4:2:0). Reject odd W/H (would
  // fail the encode at runtime) and odd X/Y (chroma-offset alignment safety).
  if ((w & 1) === 1 || (h & 1) === 1 || (x & 1) === 1 || (y & 1) === 1) return null;

  return `${w}:${h}:${x}:${y}`;
}
