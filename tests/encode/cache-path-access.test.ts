// ISS-002 (2026-09-06): the single accessor that turns the stored
// `cache_pool_path` setting into a path callers may actually use.
//
// The behaviour under test is the one both ISS-001 and ISS-002 got wrong: an
// UNSET setting is a RESOLVABLE state (DC-B auto-resolution, 24-03), never a
// "no path configured" branch.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSetting = {
  store: new Map<string, string>(),
  get(k: string): string | undefined {
    return this.store.get(k);
  },
};

vi.mock('@/src/lib/db', () => ({
  settingRepo: () => mockSetting,
}));

import {
  readEffectiveCachePathCached,
  readEffectiveCachePathFresh,
} from '@/src/lib/encode/cache-path-access';
import {
  CONFIG_CACHE_FALLBACK,
  MNT_CACHE_DEFAULT,
  __resetCachePathMemo,
} from '@/src/lib/encode/cache-path';

const probeTrue = (): boolean => true;
const probeFalse = (): boolean => false;

beforeEach(() => {
  mockSetting.store.clear();
  __resetCachePathMemo();
});

describe('readEffectiveCachePathFresh', () => {
  it('honours an explicit operator override verbatim, without probing', () => {
    mockSetting.store.set('cache_pool_path', '/mnt/user/appdata/x265');
    const probe = vi.fn(() => true);
    const res = readEffectiveCachePathFresh(probe);
    expect(res).toEqual({ effectivePath: '/mnt/user/appdata/x265', resolution: 'user-override' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('resolves an UNSET setting to /mnt/cache when writable — NOT to empty', () => {
    // The ISS-001/ISS-002 shape: this is the DEFAULT state since 24-03, and the
    // state of every upgrader after the 36-03 legacy-row migration.
    expect(readEffectiveCachePathFresh(probeTrue)).toEqual({
      effectivePath: MNT_CACHE_DEFAULT,
      resolution: 'mnt-cache',
    });
  });

  it('falls back to /config/cache when /mnt/cache is not writable', () => {
    expect(readEffectiveCachePathFresh(probeFalse)).toEqual({
      effectivePath: CONFIG_CACHE_FALLBACK,
      resolution: 'config-fallback',
    });
  });

  it('never returns an empty path for any setting shape', () => {
    for (const stored of ['', '   ', undefined]) {
      mockSetting.store.clear();
      if (stored !== undefined) mockSetting.store.set('cache_pool_path', stored);
      expect(readEffectiveCachePathFresh(probeFalse).effectivePath).not.toBe('');
    }
  });

  it('is uncached — a late-mounting /mnt/cache is honoured on the next call', () => {
    let writable = false;
    const probe = (): boolean => writable;
    expect(readEffectiveCachePathFresh(probe).resolution).toBe('config-fallback');
    writable = true;
    expect(readEffectiveCachePathFresh(probe).resolution).toBe('mnt-cache');
  });
});

describe('readEffectiveCachePathCached', () => {
  it('resolves an UNSET setting the same way the fresh variant does', () => {
    expect(readEffectiveCachePathCached(1000, probeFalse)).toEqual({
      effectivePath: CONFIG_CACHE_FALLBACK,
      resolution: 'config-fallback',
    });
  });

  it('collapses repeat calls inside the TTL to one probe (no probe storm)', () => {
    const probe = vi.fn(() => false);
    readEffectiveCachePathCached(1000, probe);
    readEffectiveCachePathCached(1500, probe);
    readEffectiveCachePathCached(9000, probe);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('re-probes once the TTL has elapsed', () => {
    const probe = vi.fn(() => false);
    readEffectiveCachePathCached(1000, probe);
    readEffectiveCachePathCached(1000 + 10_001, probe);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
