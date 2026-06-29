// 43-02: pure ETA helpers for the per-job running view. Framework-free
// (no React/i18n imports) so they stay node-testable — mirrors the sibling
// job-path.ts pure-helper + co-located *.test.ts convention.
//
// ETA is derived from ffmpeg's native `speed` multiplier already on the
// progress stream: remaining wall-clock = (durationSec − elapsedSec) / speed.
// Every input must be present & sane or we return null (caller hides the
// field — never NaN/Infinity/negative).

/**
 * Seconds of wall-clock remaining for a running encode, or null when not derivable.
 *
 * @param durationSeconds source media duration (must be > 0)
 * @param outTimeMs encoded position from ffmpeg progress, in ms (must be non-null)
 * @param speed ffmpeg speed multiplier, e.g. 1.23 (must be > 0)
 */
export function computeEtaSeconds(
  durationSeconds: number | null,
  outTimeMs: number | null,
  speed: number | null,
): number | null {
  if (durationSeconds === null || durationSeconds <= 0) return null;
  if (outTimeMs === null) return null;
  if (speed === null || speed <= 0) return null;
  const remainingSec = durationSeconds - outTimeMs / 1000;
  return Math.max(0, remainingSec / speed); // clamp ≥ 0 (outTime can exceed duration)
}

/**
 * Human-short formatting of a remaining-seconds value:
 *   45 → "45s", 754 → "12m 34s", 5025 → "1h 23m". null → null (caller hides).
 */
export function formatEtaShort(seconds: number | null): string | null {
  if (seconds === null) return null;
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}h ${m}m`;
}
