// 05-14: output-container helper coverage. Pure-module tests covering:
//   - isOutputContainer predicate (accepts 'mkv'/'mp4', rejects everything else)
//   - extensionFor exhaustive mapping
//   - muxerArgsFor frozen-array references
//   - isX265OutputPath suffix gate (positive + negative + defensive)

import { describe, it, expect } from 'vitest';

import {
  OUTPUT_CONTAINERS,
  OUTPUT_CONTAINER_SETTINGS,
  X265_OUTPUT_EXTENSIONS,
  extensionFor,
  isOutputContainer,
  isOutputContainerSetting,
  isX265OutputPath,
  muxerArgsFor,
  resolveContainerFromSource,
  type OutputContainer,
} from '@/src/lib/encode/output-container';

describe('isOutputContainer', () => {
  it('test_isOutputContainer_when_mkv_then_true', () => {
    expect(isOutputContainer('mkv')).toBe(true);
  });

  it('test_isOutputContainer_when_mp4_then_true', () => {
    expect(isOutputContainer('mp4')).toBe(true);
  });

  it.each(['webm', 'avi', '', 'MKV', 'MP4', 'mp4 ', ' mp4', 'mkv\0'])(
    'test_isOutputContainer_when_invalid_string_%j_then_false',
    (v) => {
      expect(isOutputContainer(v)).toBe(false);
    },
  );

  it.each([null, undefined, 0, 1, true, false, [], {}, ['mkv'], { container: 'mp4' }])(
    'test_isOutputContainer_when_non_string_%j_then_false',
    (v) => {
      expect(isOutputContainer(v)).toBe(false);
    },
  );

  it('test_OUTPUT_CONTAINERS_literal_union_is_exactly_mkv_and_mp4', () => {
    expect([...OUTPUT_CONTAINERS]).toEqual(['mkv', 'mp4']);
  });
});

describe('extensionFor', () => {
  it('test_extensionFor_when_mkv_then_dot_x265_mkv', () => {
    expect(extensionFor('mkv')).toBe('.x265.mkv');
  });

  it('test_extensionFor_when_mp4_then_dot_x265_mp4', () => {
    expect(extensionFor('mp4')).toBe('.x265.mp4');
  });

  it('test_extensionFor_total_function_matrix', () => {
    const matrix: Record<OutputContainer, string> = {
      mkv: extensionFor('mkv'),
      mp4: extensionFor('mp4'),
    };
    expect(matrix).toEqual({ mkv: '.x265.mkv', mp4: '.x265.mp4' });
  });
});

describe('muxerArgsFor', () => {
  it('test_muxerArgsFor_when_mkv_then_empty_frozen_array', () => {
    const args = muxerArgsFor('mkv');
    expect(args).toEqual([]);
    expect(Object.isFrozen(args)).toBe(true);
  });

  it('test_muxerArgsFor_when_mp4_then_movflags_faststart_and_hvc1_frozen', () => {
    const args = muxerArgsFor('mp4');
    expect(args).toEqual(['-movflags', '+faststart', '-tag:v', 'hvc1']);
    expect(Object.isFrozen(args)).toBe(true);
  });

  it('test_muxerArgsFor_when_mp4_then_carries_single_hvc1_fourcc_tag', () => {
    // 31-01 AC-1: the mp4 muxer recipe carries the Apple-compat HEVC fourcc as
    // an adjacent '-tag:v' 'hvc1' pair, exactly once (anti-double-emit guard).
    const args = muxerArgsFor('mp4');
    const tagIdx = args.indexOf('-tag:v');
    expect(tagIdx).toBeGreaterThan(-1);
    expect(args[tagIdx + 1]).toBe('hvc1');
    expect(args.filter((a) => a === '-tag:v')).toHaveLength(1);
    expect(args).toContain('-movflags');
    expect(args).toContain('+faststart');
  });

  it('test_muxerArgsFor_when_mkv_then_no_fourcc_tag', () => {
    // 31-01 AC-2: mkv stays byte-identical — Matroska ignores the codec fourcc.
    const args = muxerArgsFor('mkv');
    expect(args.indexOf('-tag:v')).toBe(-1);
    expect(args.indexOf('hvc1')).toBe(-1);
  });

  it('test_muxerArgsFor_returns_referentially_stable_arrays_per_container', () => {
    expect(muxerArgsFor('mkv')).toBe(muxerArgsFor('mkv'));
    expect(muxerArgsFor('mp4')).toBe(muxerArgsFor('mp4'));
  });
});

describe('isX265OutputPath', () => {
  it.each([
    '/abs/path.x265.mkv',
    '/abs/path.x265.mp4',
    'rel/path.x265.mp4',
    'rel/path.x265.mkv',
    'C:\\Users\\Foo.x265.mp4',
    './nested/dir/movie.x265.mkv',
  ])('test_isX265OutputPath_positive_%s_then_true', (p) => {
    expect(isX265OutputPath(p)).toBe(true);
  });

  it.each([
    '/x.mkv',
    '/x.mp4',
    'x265.mkv',
    'x265.mp4',
    '',
    '/movies/X.X265.MKV',
    '/movies/X.X265.MP4',
    '/movies/foo.x265.webm',
    '/movies/foo.x265.avi',
    '/movies/foo.x265.mkv.bak',
  ])('test_isX265OutputPath_negative_%s_then_false', (p) => {
    expect(isX265OutputPath(p)).toBe(false);
  });

  it('test_isX265OutputPath_when_NUL_laced_input_then_false', () => {
    expect(isX265OutputPath('foo\0.x265.mkv')).toBe(false);
    expect(isX265OutputPath('/abs/.x265.mp4\0')).toBe(false);
  });

  it.each([null, undefined, 0, 1, [], {}, true, false])(
    'test_isX265OutputPath_when_non_string_%j_then_false',
    (v) => {
      expect(isX265OutputPath(v)).toBe(false);
    },
  );

  it('test_X265_OUTPUT_EXTENSIONS_literal_union_is_exactly_two_entries', () => {
    expect([...X265_OUTPUT_EXTENSIONS]).toEqual(['.x265.mkv', '.x265.mp4']);
  });
});

describe('isOutputContainerSetting', () => {
  it.each(['mkv', 'mp4', 'match-source'])(
    'test_isOutputContainerSetting_when_%s_then_true',
    (v) => {
      expect(isOutputContainerSetting(v)).toBe(true);
    },
  );

  it.each(['', 'foo', 'MP4', 'MKV', 'match_source', 'matchSource', 'webm', 'avi'])(
    'test_isOutputContainerSetting_when_invalid_string_%j_then_false',
    (v) => {
      expect(isOutputContainerSetting(v)).toBe(false);
    },
  );

  it.each([null, undefined, 0, 1, true, false, [], {}, ['mkv'], { container: 'match-source' }])(
    'test_isOutputContainerSetting_when_non_string_%j_then_false',
    (v) => {
      expect(isOutputContainerSetting(v)).toBe(false);
    },
  );

  it('test_OUTPUT_CONTAINER_SETTINGS_literal_tuple_is_exactly_mkv_mp4_match_source_in_order', () => {
    expect([...OUTPUT_CONTAINER_SETTINGS]).toEqual(['mkv', 'mp4', 'match-source']);
  });
});

describe('resolveContainerFromSource', () => {
  it.each([
    '/abs/foo.mp4',
    '/abs/foo.MP4',
    '/abs/foo.Mp4',
    'rel/foo.mp4',
    'foo.mp4',
    '/abs/foo.m4v',
    '/abs/foo.M4V',
    '/abs/foo.M4v',
  ])('test_resolveContainerFromSource_when_mp4_class_%s_then_mp4', (p) => {
    expect(resolveContainerFromSource(p)).toBe('mp4');
  });

  it.each([
    '/abs/foo.mkv',
    '/abs/foo.MKV',
    '/abs/foo.webm',
    '/abs/foo.WebM',
    '/abs/foo.avi',
    '/abs/foo.mov',
    '/abs/foo.MOV',
    '/abs/foo.ts',
    '/abs/foo.flv',
    '/abs/foo.wmv',
    '/abs/foo',
    '/abs/foo.',
    'foo.mp4.bak',
    'foo.m4v.tmp',
    '/abs/.mp4hidden.mkv',
  ])('test_resolveContainerFromSource_when_non_mp4_class_%s_then_mkv', (p) => {
    expect(resolveContainerFromSource(p)).toBe('mkv');
  });

  it('test_resolveContainerFromSource_when_empty_string_then_mkv', () => {
    expect(resolveContainerFromSource('')).toBe('mkv');
  });

  it.each([null, undefined, 0, 1, true, false, [], {}])(
    'test_resolveContainerFromSource_when_non_string_%j_then_mkv',
    (v) => {
      expect(resolveContainerFromSource(v)).toBe('mkv');
    },
  );

  it.each(['foo\0.mp4', '/abs/foo.mp4\0', 'foo.m4v\0bar'])(
    'test_resolveContainerFromSource_when_NUL_laced_%j_then_mkv',
    (v) => {
      expect(resolveContainerFromSource(v)).toBe('mkv');
    },
  );

  it('test_resolveContainerFromSource_does_not_throw_on_any_input', () => {
    const inputs: unknown[] = [
      null,
      undefined,
      '',
      'foo',
      'foo.mp4',
      'foo.MP4',
      'foo\0.mp4',
      0,
      [],
      {},
      Symbol('s'),
    ];
    for (const v of inputs) {
      expect(() => resolveContainerFromSource(v)).not.toThrow();
    }
  });
});
