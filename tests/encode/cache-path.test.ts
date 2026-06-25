// 24-03 (F2): DC-B cache-path resolver coverage.
//   AC-1  unset + /mnt/cache writable      → mnt-cache (/mnt/cache/x265-butler)
//   AC-2  unset + /mnt/cache not writable   → config-fallback (/config/cache)
//   AC-3  explicit override                 → user-override verbatim, NO probe
//   AC-10 Cached read-surface variant       → ≤1 probe per TTL window; re-probes after TTL
import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveEffectiveCachePath,
  resolveEffectiveCachePathCached,
  __resetCachePathMemo,
  MNT_CACHE_DEFAULT,
  CONFIG_CACHE_FALLBACK,
  READ_SURFACE_TTL_MS,
} from '@/src/lib/encode/cache-path';

describe('resolveEffectiveCachePath (pure dispatch resolver)', () => {
  it('AC-1: unset + /mnt/cache writable → mnt-cache', () => {
    const eff = resolveEffectiveCachePath(undefined, () => true);
    expect(eff).toEqual({ effectivePath: MNT_CACHE_DEFAULT, resolution: 'mnt-cache' });
  });

  it('AC-2: unset + /mnt/cache NOT writable → config-fallback', () => {
    const eff = resolveEffectiveCachePath(undefined, () => false);
    expect(eff).toEqual({ effectivePath: CONFIG_CACHE_FALLBACK, resolution: 'config-fallback' });
  });

  it('AC-2: empty / whitespace-only setting is treated as unset', () => {
    expect(resolveEffectiveCachePath('', () => false).resolution).toBe('config-fallback');
    expect(resolveEffectiveCachePath('   ', () => false).resolution).toBe('config-fallback');
    expect(resolveEffectiveCachePath('  ', () => true).resolution).toBe('mnt-cache');
  });

  it('AC-3: explicit override honoured verbatim with NO probe', () => {
    let probed = 0;
    const probe = () => {
      probed += 1;
      return true;
    };
    const eff = resolveEffectiveCachePath('/mnt/disks/nvme/cache', probe);
    expect(eff).toEqual({ effectivePath: '/mnt/disks/nvme/cache', resolution: 'user-override' });
    expect(probed).toBe(0); // probe never called for an explicit override
  });

  it('AC-3: override is trimmed but otherwise byte-identical', () => {
    const eff = resolveEffectiveCachePath('  /mnt/disks/nvme/cache  ', () => false);
    expect(eff).toEqual({ effectivePath: '/mnt/disks/nvme/cache', resolution: 'user-override' });
  });
});

describe('resolveEffectiveCachePathCached (AC-10 read-surface rate-bound)', () => {
  beforeEach(() => __resetCachePathMemo());

  it('probes at most ONCE across many calls within the TTL window', () => {
    let probed = 0;
    const probe = () => {
      probed += 1;
      return true;
    };
    const now = 1_000_000;
    for (let i = 0; i < 25; i += 1) {
      const eff = resolveEffectiveCachePathCached(undefined, now + i, probe);
      expect(eff.resolution).toBe('mnt-cache');
    }
    expect(probed).toBe(1); // memo collapsed the per-call write-storm
  });

  it('re-probes after the TTL window elapses', () => {
    let probed = 0;
    const probe = () => {
      probed += 1;
      return true;
    };
    const t0 = 1_000_000;
    resolveEffectiveCachePathCached(undefined, t0, probe);
    // still within TTL → no re-probe
    resolveEffectiveCachePathCached(undefined, t0 + READ_SURFACE_TTL_MS - 1, probe);
    expect(probed).toBe(1);
    // TTL elapsed → re-probe
    resolveEffectiveCachePathCached(undefined, t0 + READ_SURFACE_TTL_MS, probe);
    expect(probed).toBe(2);
  });

  it('__resetCachePathMemo forces a fresh probe (hermetic specs)', () => {
    let probed = 0;
    const probe = () => {
      probed += 1;
      return false;
    };
    resolveEffectiveCachePathCached(undefined, 5_000, probe);
    __resetCachePathMemo();
    resolveEffectiveCachePathCached(undefined, 5_001, probe);
    expect(probed).toBe(2);
  });
});
