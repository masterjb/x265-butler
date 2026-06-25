/*
 * 36-03 (b2): boot migration deleting the Pre-24-03 legacy-default
 * cache_pool_path row so upgraders fall through to the DC-B auto-resolver.
 *
 * Pins (AC-1..AC-5 + AC-7):
 *   - exact trimmed MNT_CACHE_DEFAULT → deleted + breadcrumb + migrated:true
 *   - surrounding whitespace tolerated (trim) → migrated
 *   - custom path / trailing-slash variant / empty / unset → KEPT, no breadcrumb
 *   - idempotent across boots
 *   - AC-7: post-delete the dispatch resolver still yields the byte-identical
 *     /mnt/cache/x265-butler path on a writable host
 */

import { describe, it, expect, vi } from 'vitest';
import type pino from 'pino';
import { migrateLegacyCachePath } from '@/src/lib/db/migrate-legacy-cache-path';
import type { SettingRepo } from '@/src/lib/db/repos/setting';
import { MNT_CACHE_DEFAULT, resolveEffectiveCachePath } from '@/src/lib/encode/cache-path';

const KEY = 'cache_pool_path';

/** Map-backed in-memory fake — get/set/delete/getAll only (function is pure). */
function fakeRepo(initial?: Record<string, string>): SettingRepo {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    get: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
    delete: (key) => void map.delete(key),
    getAll: () => Object.fromEntries(map),
  };
}

/** Minimal pino-shaped spy logger. */
function spyLog(): pino.Logger {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as pino.Logger;
}

describe('migrateLegacyCachePath', () => {
  it('AC-1: deletes the exact legacy default + emits one breadcrumb', () => {
    const repo = fakeRepo({ [KEY]: MNT_CACHE_DEFAULT });
    const log = spyLog();

    const result = migrateLegacyCachePath(repo, log);

    expect(result).toEqual({ migrated: true });
    expect(repo.get(KEY)).toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      { action: 'legacy_cache_path_migrated', removed: MNT_CACHE_DEFAULT },
      expect.any(String),
    );
  });

  it('AC-1b: tolerates surrounding whitespace (trim → match)', () => {
    const repo = fakeRepo({ [KEY]: `  ${MNT_CACHE_DEFAULT}  ` });
    const log = spyLog();

    const result = migrateLegacyCachePath(repo, log);

    expect(result).toEqual({ migrated: true });
    expect(repo.get(KEY)).toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('AC-2: preserves a custom override (no delete, no breadcrumb)', () => {
    const repo = fakeRepo({ [KEY]: '/mnt/user/media/cache' });
    const log = spyLog();

    const result = migrateLegacyCachePath(repo, log);

    expect(result).toEqual({ migrated: false });
    expect(repo.get(KEY)).toBe('/mnt/user/media/cache');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('AC-3: preserves the trailing-slash near-miss variant', () => {
    const repo = fakeRepo({ [KEY]: `${MNT_CACHE_DEFAULT}/` });
    const log = spyLog();

    const result = migrateLegacyCachePath(repo, log);

    expect(result).toEqual({ migrated: false });
    expect(repo.get(KEY)).toBe(`${MNT_CACHE_DEFAULT}/`);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('AC-4: unset / fresh-install is a no-op', () => {
    const repo = fakeRepo();
    const delSpy = vi.spyOn(repo, 'delete');
    const log = spyLog();

    const result = migrateLegacyCachePath(repo, log);

    expect(result).toEqual({ migrated: false });
    expect(delSpy).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('empty-string row is a no-op (already auto-resolves)', () => {
    const repo = fakeRepo({ [KEY]: '' });
    const log = spyLog();

    const result = migrateLegacyCachePath(repo, log);

    expect(result).toEqual({ migrated: false });
    expect(repo.get(KEY)).toBe('');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('AC-5: idempotent across boots (second run is a clean no-op)', () => {
    const repo = fakeRepo({ [KEY]: MNT_CACHE_DEFAULT });
    const log = spyLog();

    const first = migrateLegacyCachePath(repo, log);
    const second = migrateLegacyCachePath(repo, log);

    expect(first).toEqual({ migrated: true });
    expect(second).toEqual({ migrated: false });
    expect(log.warn).toHaveBeenCalledTimes(1); // no second breadcrumb
  });

  it('AC-7: post-delete the dispatch resolver yields the byte-identical /mnt/cache path on a writable host', () => {
    const repo = fakeRepo({ [KEY]: MNT_CACHE_DEFAULT });
    const log = spyLog();

    migrateLegacyCachePath(repo, log);

    // Writable-probe stub → proves the encode/dispatch path is unchanged.
    const resolved = resolveEffectiveCachePath(repo.get(KEY), () => true);
    expect(resolved).toEqual({
      effectivePath: MNT_CACHE_DEFAULT,
      resolution: 'mnt-cache',
    });
  });
});
