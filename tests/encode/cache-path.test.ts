// Cache-path auto-resolver coverage.
//   unset + /mnt/cache writable      → mnt-cache (/mnt/cache/x265-butler)
//   unset + /mnt/cache not writable  → config-fallback (/config/cache)
//   explicit override                → user-override verbatim, NO probe
//   Cached read-surface variant      → ≤1 probe per TTL window; re-probes after TTL
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveEffectiveCachePath,
  resolveEffectiveCachePathCached,
  __resetCachePathMemo,
  MNT_CACHE_DEFAULT,
  CONFIG_CACHE_FALLBACK,
  READ_SURFACE_TTL_MS,
  CACHE_MOUNT_ROOT,
  defaultProbeCacheMount,
  probeCacheMountAt,
} from '@/src/lib/encode/cache-path';

describe('resolveEffectiveCachePath (pure dispatch resolver)', () => {
  it('unset + /mnt/cache writable → mnt-cache', () => {
    const eff = resolveEffectiveCachePath(undefined, () => true);
    expect(eff).toEqual({ effectivePath: MNT_CACHE_DEFAULT, resolution: 'mnt-cache' });
  });

  it('unset + /mnt/cache NOT writable → config-fallback', () => {
    const eff = resolveEffectiveCachePath(undefined, () => false);
    expect(eff).toEqual({ effectivePath: CONFIG_CACHE_FALLBACK, resolution: 'config-fallback' });
  });

  it('empty / whitespace-only setting is treated as unset', () => {
    expect(resolveEffectiveCachePath('', () => false).resolution).toBe('config-fallback');
    expect(resolveEffectiveCachePath('   ', () => false).resolution).toBe('config-fallback');
    expect(resolveEffectiveCachePath('  ', () => true).resolution).toBe('mnt-cache');
  });

  it('explicit override honoured verbatim with NO probe', () => {
    let probed = 0;
    const probe = () => {
      probed += 1;
      return true;
    };
    const eff = resolveEffectiveCachePath('/mnt/disks/nvme/cache', probe);
    expect(eff).toEqual({ effectivePath: '/mnt/disks/nvme/cache', resolution: 'user-override' });
    expect(probed).toBe(0); // probe never called for an explicit override
  });

  it('override is trimmed but otherwise byte-identical', () => {
    const eff = resolveEffectiveCachePath('  /mnt/disks/nvme/cache  ', () => false);
    expect(eff).toEqual({ effectivePath: '/mnt/disks/nvme/cache', resolution: 'user-override' });
  });
});

describe('resolveEffectiveCachePathCached (read-surface rate-bound)', () => {
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

// ── /cache tier (unRAID "Cache Pool" template path) ────────────────
// Order: setting > /cache > /mnt/cache > /config/cache.
describe('/cache tier', () => {
  const on = (v: boolean) => () => v;

  it('a mapped /cache wins over a writable /mnt/cache', () => {
    expect(resolveEffectiveCachePath(undefined, on(true), on(true))).toEqual({
      effectivePath: CACHE_MOUNT_ROOT,
      resolution: 'cache-mount',
    });
  });

  it('no /cache → exactly the behaviour before the /cache tier existed', () => {
    expect(resolveEffectiveCachePath(undefined, on(true), on(false)).resolution).toBe('mnt-cache');
    expect(resolveEffectiveCachePath(undefined, on(false), on(false)).resolution).toBe(
      'config-fallback',
    );
  });

  it('an explicit setting beats /cache, without probing', () => {
    let probed = 0;
    const probe = () => {
      probed += 1;
      return true;
    };
    expect(resolveEffectiveCachePath('/x', on(true), probe).resolution).toBe('user-override');
    expect(probed).toBe(0);
  });

  it('the global test seam keeps the default probe hermetic', () => {
    expect(defaultProbeCacheMount()).toBe(false);
  });
});

// The real write-probe against tmpdir paths, no mocks.
describe('probeCacheMountAt', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'x265-cachemount-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writable directory → true', () => {
    mkdirSync(path.join(dir, 'cache'));
    expect(probeCacheMountAt(path.join(dir, 'cache'))).toBe(true);
  });

  it('absent path → false, nothing created', () => {
    expect(probeCacheMountAt(path.join(dir, 'cache'))).toBe(false);
    expect(existsSync(path.join(dir, 'cache'))).toBe(false);
  });
});
