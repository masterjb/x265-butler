// 10-02 C5: assertCachePoolFreeSpace — unit tests for the 2× pre-flight guard.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  assertCachePoolFreeSpace,
  CachePoolConfigError,
  CachePoolPreFlightError,
  CACHE_POOL_SAFETY_MULTIPLIER,
  __forTests_resetCachePoolCooldowns,
} from '@/src/lib/encode/staging';

function makeStatfs(bavail: number) {
  return (_path: string) => ({ bavail: BigInt(bavail), bsize: BigInt(1) });
}

beforeEach(() => {
  __forTests_resetCachePoolCooldowns();
});

describe('assertCachePoolFreeSpace (10-02 C5)', () => {
  it('test_safety_multiplier_is_2', () => {
    expect(CACHE_POOL_SAFETY_MULTIPLIER).toBe(2);
  });

  it('test_when_no_cachePoolPath_then_throws_CachePoolConfigError', () => {
    expect(() => assertCachePoolFreeSpace(1_000_000, {})).toThrow(CachePoolConfigError);
  });

  it('test_when_sufficient_space_then_no_throw', () => {
    expect(() =>
      assertCachePoolFreeSpace(1_000_000, {
        cachePoolPath: '/tmp',
        statfsSync: makeStatfs(5_000_000),
      }),
    ).not.toThrow();
  });

  it('test_when_insufficient_space_then_throws_CachePoolPreFlightError', () => {
    expect(() =>
      assertCachePoolFreeSpace(1_000_000, {
        cachePoolPath: '/tmp',
        statfsSync: makeStatfs(1_000_000),
      }),
    ).toThrow(CachePoolPreFlightError);
  });

  it('test_when_insufficient_space_then_error_carries_available_and_required_bytes', () => {
    let caught: CachePoolPreFlightError | null = null;
    try {
      assertCachePoolFreeSpace(1_000_000, {
        cachePoolPath: '/tmp',
        statfsSync: makeStatfs(500_000),
      });
    } catch (e) {
      caught = e as CachePoolPreFlightError;
    }
    expect(caught).toBeInstanceOf(CachePoolPreFlightError);
    expect(caught!.requiredBytes).toBe(2_000_000);
    expect(caught!.availableBytes).toBe(500_000);
  });

  it('test_cooldown_when_pool_full_then_second_call_skips_statfs', () => {
    let statfsCalls = 0;
    const statfsImpl = (_path: string) => {
      statfsCalls++;
      return { bavail: BigInt(0), bsize: BigInt(1) };
    };

    expect(() =>
      assertCachePoolFreeSpace(1_000_000, {
        cachePoolPath: '/tmp',
        cooldownKey: 'file-1',
        statfsSync: statfsImpl,
      }),
    ).toThrow(CachePoolPreFlightError);

    const callsAfterFirst = statfsCalls;
    expect(() =>
      assertCachePoolFreeSpace(1_000_000, {
        cachePoolPath: '/tmp',
        cooldownKey: 'file-1',
        statfsSync: statfsImpl,
      }),
    ).toThrow(CachePoolPreFlightError);

    // Second call must NOT invoke statfsSync again.
    expect(statfsCalls).toBe(callsAfterFirst);
  });

  it('test_cooldown_cleared_on_success', () => {
    let bavail = 0;
    const statfsImpl = () => ({ bavail: BigInt(bavail), bsize: BigInt(1) });

    // First call fails → sets cooldown.
    expect(() =>
      assertCachePoolFreeSpace(1_000_000, {
        cachePoolPath: '/tmp',
        cooldownKey: 'file-2',
        statfsSync: statfsImpl,
      }),
    ).toThrow(CachePoolPreFlightError);

    // Reset pool and cooldown map.
    bavail = 10_000_000;
    __forTests_resetCachePoolCooldowns();

    // Should succeed now (cooldown cleared).
    expect(() =>
      assertCachePoolFreeSpace(1_000_000, {
        cachePoolPath: '/tmp',
        cooldownKey: 'file-2',
        statfsSync: statfsImpl,
      }),
    ).not.toThrow();
  });

  it('test_no_cooldownKey_then_no_cooldown_tracking_always_calls_statfs', () => {
    let statfsCalls = 0;
    const statfsImpl = () => {
      statfsCalls++;
      return { bavail: BigInt(0), bsize: BigInt(1) };
    };

    expect(() =>
      assertCachePoolFreeSpace(1_000_000, { cachePoolPath: '/tmp', statfsSync: statfsImpl }),
    ).toThrow(CachePoolPreFlightError);
    expect(() =>
      assertCachePoolFreeSpace(1_000_000, { cachePoolPath: '/tmp', statfsSync: statfsImpl }),
    ).toThrow(CachePoolPreFlightError);

    expect(statfsCalls).toBe(2);
  });
});
