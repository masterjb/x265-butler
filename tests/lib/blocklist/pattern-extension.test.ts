import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockListAll, mockLoggerWarn } = vi.hoisted(() => ({
  mockListAll: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('@/src/lib/db', () => ({
  shareRepo: () => ({ listAll: mockListAll }),
  default: {},
}));

vi.mock('@/src/lib/logger', () => ({
  logger: {
    warn: mockLoggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({
      warn: mockLoggerWarn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
  default: {},
}));

import {
  derivePatternExtension,
  getCurrentScanExtensions,
  composeExtensionWarning,
} from '@/src/lib/blocklist/pattern-extension';

beforeEach(() => {
  mockListAll.mockReset();
  mockLoggerWarn.mockReset();
});

function fakeShare(
  id: number,
  name: string,
  path: string,
  extensions_csv: string,
): {
  id: number;
  name: string;
  path: string;
  min_size_mb: number;
  extensions_csv: string;
  max_depth: number | null;
  created_at: number;
  updated_at: number;
} {
  return {
    id,
    name,
    path,
    min_size_mb: 0,
    extensions_csv,
    max_depth: null,
    created_at: 0,
    updated_at: 0,
  };
}

describe('derivePatternExtension', () => {
  it('test_derive_AC1_simple_star_dot_srt_returns_srt', () => {
    expect(derivePatternExtension('*.srt')).toBe('srt');
  });

  it('test_derive_AC1_upper_case_normalizes_to_lowercase', () => {
    expect(derivePatternExtension('*.SRT')).toBe('srt');
  });

  it('test_derive_AC1_mixed_case_final_segment_normalizes', () => {
    // audit-M-S4: lower() BEFORE last-dot split — `*.MKV.BAK` → "bak".
    expect(derivePatternExtension('*.MKV.BAK')).toBe('bak');
  });

  it('test_derive_AC1_mid_path_pattern_returns_null', () => {
    expect(derivePatternExtension('*/Extras/*')).toBeNull();
  });

  it('test_derive_AC1_no_star_exact_path_returns_null', () => {
    expect(derivePatternExtension('/exact/path.srt')).toBeNull();
  });

  it('test_derive_AC1_word_with_star_no_trailing_ext_returns_null', () => {
    expect(derivePatternExtension('*Trailer*')).toBeNull();
  });

  it('test_derive_AC1_double_segment_returns_final_segment', () => {
    expect(derivePatternExtension('*.tar.gz')).toBe('gz');
    expect(derivePatternExtension('*.mkv.bak')).toBe('bak');
  });

  it('test_derive_when_ext_too_long_then_null', () => {
    // VALID_EXT_REGEX caps at 8 chars.
    expect(derivePatternExtension('*.toolongextension')).toBeNull();
  });

  it('test_derive_when_ext_has_non_alphanumeric_then_null', () => {
    expect(derivePatternExtension('*.s_rt')).toBeNull();
    expect(derivePatternExtension('*.s-rt')).toBeNull();
  });
});

describe('getCurrentScanExtensions', () => {
  it('test_AC2_union_two_shares_lower_dedup_no_dot', () => {
    mockListAll.mockReturnValue([
      fakeShare(1, 'movies', '/movies', 'mkv,mp4'),
      fakeShare(2, 'tv', '/tv', 'mp4,avi'),
    ]);
    const set = getCurrentScanExtensions();
    expect([...set].sort()).toEqual(['avi', 'mkv', 'mp4']);
  });

  it('test_AC2_trims_whitespace_and_lowercases_and_strips_leading_dot', () => {
    mockListAll.mockReturnValue([fakeShare(1, 'mix', '/m', '  .MKV ,  Mp4 ,  .Avi  ')]);
    const set = getCurrentScanExtensions();
    expect([...set].sort()).toEqual(['avi', 'mkv', 'mp4']);
  });

  it('test_AC2_dedup_across_shares', () => {
    mockListAll.mockReturnValue([
      fakeShare(1, 'a', '/a', 'mkv,mkv,mp4'),
      fakeShare(2, 'b', '/b', 'mkv,mp4'),
    ]);
    const set = getCurrentScanExtensions();
    expect(set.size).toBe(2);
  });

  it('test_AC2_when_repo_throws_then_returns_empty_set_AND_pino_WARN_emitted', () => {
    mockListAll.mockImplementation(() => {
      throw new Error('db unavailable');
    });
    const set = getCurrentScanExtensions();
    expect(set.size).toBe(0);
    // audit-S3: WARN not DEBUG.
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'scan_extensions_lookup_failed',
        error: 'db unavailable',
      }),
      expect.any(String),
    );
  });
});

describe('composeExtensionWarning', () => {
  it('test_warn_yes_when_resolved_ext_not_in_scan_set', () => {
    mockListAll.mockReturnValue([fakeShare(1, 'm', '/m', 'mkv,mp4')]);
    const w = composeExtensionWarning('*.srt');
    expect(w).toEqual({ resolvedExt: 'srt', scanExtensions: ['mkv', 'mp4'] });
  });

  it('test_warn_no_when_resolved_ext_covered_by_share', () => {
    mockListAll.mockReturnValue([fakeShare(1, 'm', '/m', 'mkv,mp4')]);
    expect(composeExtensionWarning('*.mkv')).toBeNull();
  });

  it('test_warn_no_when_pattern_is_not_extension_shape', () => {
    mockListAll.mockReturnValue([fakeShare(1, 'm', '/m', 'mkv,mp4')]);
    expect(composeExtensionWarning('*/Extras/*')).toBeNull();
  });

  it('test_warn_no_when_scan_set_empty_DB_failure_path', () => {
    mockListAll.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(composeExtensionWarning('*.srt')).toBeNull();
  });

  it('test_warn_scanExtensions_sorted_ascending_in_output', () => {
    mockListAll.mockReturnValue([fakeShare(1, 'm', '/m', 'mp4,mkv,avi')]);
    const w = composeExtensionWarning('*.srt');
    expect(w?.scanExtensions).toEqual(['avi', 'mkv', 'mp4']);
  });
});
