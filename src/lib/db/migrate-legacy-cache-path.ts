import type pino from 'pino';
import type { SettingRepo } from './repos/setting';
import { MNT_CACHE_DEFAULT } from '../encode/cache-path';

const CACHE_POOL_PATH_KEY = 'cache_pool_path';

export interface LegacyCachePathMigrationResult {
  migrated: boolean;
}

/**
 * 36-03 (b2): one-time-safe boot migration. Pre-24-03 installs persisted the
 * hardcoded DEFAULT_CACHE_POOL_PATH (== MNT_CACHE_DEFAULT) as a cache_pool_path
 * row. 24-03 removed the const and treats any non-empty value as a manual
 * override (verbatim, NO writability probe) → on a host without the CA-template
 * /mnt/cache mapping every dispatch fails cache_pool_unavailable:EACCES.
 * Deleting ONLY the exact legacy-default value lets the row fall through to the
 * DC-B auto-resolver (resolveEffectiveCachePath). EXACT trimmed match —
 * a trailing-slash or any other value is a deliberate custom path → KEPT.
 * Idempotent: after delete, get() returns undefined → no-op on every later boot.
 */
export function migrateLegacyCachePath(
  repo: SettingRepo,
  log: pino.Logger,
): LegacyCachePathMigrationResult {
  const current = repo.get(CACHE_POOL_PATH_KEY);
  if (current === undefined) return { migrated: false };
  if (current.trim() !== MNT_CACHE_DEFAULT) return { migrated: false };
  repo.delete(CACHE_POOL_PATH_KEY);
  log.warn(
    { action: 'legacy_cache_path_migrated', removed: current },
    'deleted legacy default cache_pool_path row → DC-B auto-resolve',
  );
  return { migrated: true };
}
