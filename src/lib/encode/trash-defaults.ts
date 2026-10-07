// Limits and parsing for the `trash_retention_days` setting. Kept free of
// imports so the settings form can import the values directly.

export const DEFAULT_TRASH_RETENTION_DAYS = 30;
export const MIN_TRASH_RETENTION_DAYS = 1;
export const MAX_TRASH_RETENTION_DAYS = 3650;

export const TRASH_RETENTION_SETTING_KEY = 'trash_retention_days';

/** True for whole days inside the allowed range. */
export function isValidTrashRetentionDays(n: number): boolean {
  return Number.isInteger(n) && n >= MIN_TRASH_RETENTION_DAYS && n <= MAX_TRASH_RETENTION_DAYS;
}

/**
 * Stored value to days. Anything that is not a valid value falls back to the
 * default rather than being clamped: a broken stored value must not stop every
 * encode from moving its original to the trash, and a clamped value would be a
 * number nobody chose.
 */
export function parseTrashRetentionDays(raw: string | null | undefined): number {
  const trimmed = (raw ?? '').trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_TRASH_RETENTION_DAYS;
  const n = Number(trimmed);
  return isValidTrashRetentionDays(n) ? n : DEFAULT_TRASH_RETENTION_DAYS;
}

// Trash on/off. Missing or unknown values keep the trash on: only an explicit
// 'false' lets an original be deleted or replaced without a way back.
export const TRASH_ENABLED_SETTING_KEY = 'trash_enabled';

export function parseTrashEnabled(raw: string | null | undefined): boolean {
  return raw !== 'false';
}

// Where the trash lives when no explicit trash_path is set. 'share' puts it in
// a hidden folder inside the share of the file (a rename, no copy); 'cache'
// keeps the old place under the cache path. Missing or unknown values mean
// 'cache', which is what every install did before the setting existed.
export const TRASH_LOCATION_SETTING_KEY = 'trash_location';
export const TRASH_LOCATIONS = ['share', 'cache'] as const;
export type TrashLocation = (typeof TRASH_LOCATIONS)[number];
export const DEFAULT_TRASH_LOCATION: TrashLocation = 'cache';

// Dot prefix: the scanner and the file watcher skip it, so trashed originals
// are never picked up again.
export const SHARE_TRASH_DIR = '.x265-butler-trash';

export function isTrashLocation(v: unknown): v is TrashLocation {
  return typeof v === 'string' && (TRASH_LOCATIONS as readonly string[]).includes(v);
}

export function parseTrashLocation(raw: string | null | undefined): TrashLocation {
  return isTrashLocation(raw) ? raw : DEFAULT_TRASH_LOCATION;
}
