/*
 * 48-02 Task 1 — src/lib/fs/system-paths.ts unit tests.
 *
 * ACs covered: AC-1/AC-2 (list content), AC-3 (segment-exact, '/etcetera' is
 * NOT under '/etc'), AC-4b (aliasing: '//sys', '/sys/', '/proc//1',
 * '/mnt/../sys', NUL), AC-6 ('/' is never a prune prefix), AC-8 (kill-switch),
 * AC-15 (test seam).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockLogInfo, mockLogWarn } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    info: mockLogInfo,
    warn: mockLogWarn,
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: mockLogInfo, warn: mockLogWarn, error: vi.fn(), debug: vi.fn() }),
  },
  default: {},
}));

import {
  FORBIDDEN_SHARE_PREFIXES,
  PRUNE_SYSTEM_PREFIXES,
  isForbiddenSharePath,
  isUnderPruneSystemPrefix,
  isSystemPruneEnabled,
  __setPruneSystemPrefixesForTests,
  __resetSystemPruneMemoForTests,
} from '@/src/lib/fs/system-paths';

const ORIGINAL_ENV = process.env.SCAN_PRUNE_SYSTEM_PATHS;

beforeEach(() => {
  mockLogInfo.mockClear();
  mockLogWarn.mockClear();
  __setPruneSystemPrefixesForTests(null);
  __resetSystemPruneMemoForTests();
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.SCAN_PRUNE_SYSTEM_PATHS;
  else process.env.SCAN_PRUNE_SYSTEM_PATHS = ORIGINAL_ENV;
  __setPruneSystemPrefixesForTests(null);
  __resetSystemPruneMemoForTests();
});

describe('system-paths — list content', () => {
  it('test_lists_when_read_then_validation_list_is_wider_than_prune_list', () => {
    expect([...FORBIDDEN_SHARE_PREFIXES].sort()).toEqual(
      ['/boot', '/dev', '/etc', '/proc', '/run', '/sys'].sort(),
    );
    expect([...PRUNE_SYSTEM_PREFIXES].sort()).toEqual(['/dev', '/proc', '/run', '/sys'].sort());
    // Every prune prefix must also be forbidden to configure — the inverse is
    // deliberately NOT true (/etc + /boot are validated but not pruned).
    for (const p of PRUNE_SYSTEM_PREFIXES) {
      expect(FORBIDDEN_SHARE_PREFIXES).toContain(p);
    }
  });
});

describe('isForbiddenSharePath', () => {
  it('test_when_bare_root_then_forbidden', () => {
    expect(isForbiddenSharePath('/')).toBe(true);
    expect(isForbiddenSharePath('//')).toBe(true);
    expect(isForbiddenSharePath('///')).toBe(true);
  });

  it('test_when_system_prefix_then_forbidden', () => {
    for (const p of ['/sys', '/proc', '/dev', '/etc', '/boot', '/run']) {
      expect(isForbiddenSharePath(p)).toBe(true);
      expect(isForbiddenSharePath(`${p}/kernel`)).toBe(true);
    }
  });

  // AC-4b — the aliasing set. Each of these reaches the guard with a different
  // surface form; a guard that only handles the canonical form is bypassable.
  it('test_when_aliased_forbidden_root_then_still_forbidden', () => {
    expect(isForbiddenSharePath('//sys')).toBe(true);
    expect(isForbiddenSharePath('/sys/')).toBe(true);
    expect(isForbiddenSharePath('/proc//1')).toBe(true);
    expect(isForbiddenSharePath('/mnt/../sys')).toBe(true);
    expect(isForbiddenSharePath('/mnt/user\u0000/Media')).toBe(true); // NUL byte
  });

  // AC-3 — SEGMENT-exact. A naive startsWith would eat both of these.
  it('test_when_legitimate_path_then_allowed', () => {
    for (const p of [
      '/mnt/user/Media',
      '/media',
      '/mnt/cache/x',
      '/etcetera',
      '/development',
      '/devices',
      '/procurement',
      '/runtime-media',
      '/boots',
      '/systemx',
    ]) {
      expect(isForbiddenSharePath(p)).toBe(false);
    }
  });
});

describe('isUnderPruneSystemPrefix', () => {
  it('test_when_under_prune_prefix_then_true', () => {
    expect(isUnderPruneSystemPrefix('/proc')).toBe(true);
    expect(isUnderPruneSystemPrefix('/sys/kernel')).toBe(true);
    expect(isUnderPruneSystemPrefix('/dev/shm')).toBe(true);
    expect(isUnderPruneSystemPrefix('/run/media/usb1')).toBe(true);
    expect(isUnderPruneSystemPrefix('//sys')).toBe(true);
  });

  // AC-6 — '/' must NOT be a prune prefix, otherwise a '/'-rooted share would
  // be root-exempt and the healing behaviour of AC-5 would never engage.
  it('test_when_root_then_not_under_prune_prefix', () => {
    expect(isUnderPruneSystemPrefix('/')).toBe(false);
    expect(isUnderPruneSystemPrefix('//')).toBe(false);
  });

  it('test_when_etc_or_boot_then_not_pruned_at_runtime', () => {
    // Validated but NOT pruned — deliberate asymmetry, see module header.
    expect(isUnderPruneSystemPrefix('/etc')).toBe(false);
    expect(isUnderPruneSystemPrefix('/boot/config')).toBe(false);
  });

  it('test_when_segment_looks_similar_then_not_pruned', () => {
    expect(isUnderPruneSystemPrefix('/development')).toBe(false);
    expect(isUnderPruneSystemPrefix('/procurement')).toBe(false);
    expect(isUnderPruneSystemPrefix('/mnt/user/Media')).toBe(false);
  });

  // AC-15 — the seam. Without it no fixture tree under os.tmpdir() could ever
  // match an ABSOLUTE production prefix.
  it('test_when_test_seam_set_then_override_list_is_used_and_null_restores', () => {
    __setPruneSystemPrefixesForTests(['/tmp/fixture/proc', '/tmp/fixture/sys']);
    expect(isUnderPruneSystemPrefix('/tmp/fixture/sys/kernel')).toBe(true);
    expect(isUnderPruneSystemPrefix('/proc')).toBe(false); // production list is OFF
    __setPruneSystemPrefixesForTests(null);
    expect(isUnderPruneSystemPrefix('/proc')).toBe(true);
    expect(isUnderPruneSystemPrefix('/tmp/fixture/sys/kernel')).toBe(false);
  });
});

describe('isSystemPruneEnabled — AC-8 kill-switch', () => {
  it('test_when_env_unset_then_enabled_and_logged_once_at_info', () => {
    delete process.env.SCAN_PRUNE_SYSTEM_PATHS;
    expect(isSystemPruneEnabled()).toBe(true);
    expect(isSystemPruneEnabled()).toBe(true); // memoized
    const lines = mockLogInfo.mock.calls
      .map((c) => c[0] as { action?: string; enabled?: boolean; source?: string })
      .filter((c) => c.action === 'scan_prune_system_paths_resolved');
    expect(lines).toHaveLength(1);
    expect(lines[0].enabled).toBe(true);
    expect(lines[0].source).toBe('default');
  });

  it('test_when_env_is_zero_then_disabled_with_source_env', () => {
    process.env.SCAN_PRUNE_SYSTEM_PATHS = '0';
    expect(isSystemPruneEnabled()).toBe(false);
    const line = mockLogInfo.mock.calls
      .map((c) => c[0] as { action?: string; enabled?: boolean; source?: string })
      .find((c) => c.action === 'scan_prune_system_paths_resolved');
    expect(line?.enabled).toBe(false);
    expect(line?.source).toBe('env');
  });

  it('test_when_env_is_any_other_value_then_enabled', () => {
    for (const raw of ['1', 'true', '', 'yes', 'off']) {
      __resetSystemPruneMemoForTests();
      process.env.SCAN_PRUNE_SYSTEM_PATHS = raw;
      expect(isSystemPruneEnabled()).toBe(true);
    }
  });

  it('test_when_kill_switch_off_then_validation_guard_is_unaffected', () => {
    process.env.SCAN_PRUNE_SYSTEM_PATHS = '0';
    expect(isSystemPruneEnabled()).toBe(false);
    // Bundle A never consults the switch.
    expect(isForbiddenSharePath('/sys')).toBe(true);
    expect(isForbiddenSharePath('/')).toBe(true);
  });
});
