// Limits and parsing for the `stall_timeout_minutes` setting. Kept free of
// imports so the settings form can import the values directly; the watchdog
// itself lives in stall-watchdog.ts, which pulls in the logger.

export const DEFAULT_STALL_TIMEOUT_MINUTES = 10;
export const MIN_STALL_TIMEOUT_MINUTES = 2;
export const MAX_STALL_TIMEOUT_MINUTES = 720;

export const STALL_TIMEOUT_SETTING_KEY = 'stall_timeout_minutes';

/** True for 0 (detection off) and for whole minutes inside the allowed range. */
export function isValidStallTimeoutMinutes(n: number): boolean {
  return (
    Number.isInteger(n) &&
    (n === 0 || (n >= MIN_STALL_TIMEOUT_MINUTES && n <= MAX_STALL_TIMEOUT_MINUTES))
  );
}

/**
 * Stored value to minutes. Anything that is not a valid value falls back to the
 * default rather than being clamped: a clamped value would be a number nobody
 * chose.
 */
export function parseStallTimeoutMinutes(raw: string | null | undefined): number {
  const trimmed = (raw ?? '').trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_STALL_TIMEOUT_MINUTES;
  const n = Number(trimmed);
  return isValidStallTimeoutMinutes(n) ? n : DEFAULT_STALL_TIMEOUT_MINUTES;
}
