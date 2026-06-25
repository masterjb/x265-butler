import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildCodecBlock,
  buildEncodeArgs,
  PROFILE_BUILDERS,
  ENCODER_IDS,
  DEFAULT_PRESET_BY_ENCODER,
  resolveX265Pools,
  X265_POOLS_CEILING,
  __forTests_resetX265PoolsCache,
  type EncoderId,
} from '@/src/lib/encode/profiles';
import { logger } from '@/src/lib/logger';
import { buildTestEncodeArgs } from '@/src/lib/diagnostics/test-encode';
import { __forTests_buildProbeEncodeArgs } from '@/src/lib/encode/detection';

// 37-01: the libx265 block now appends `-x265-params pools=<min(cpuCount,16)>` by
// default — non-deterministic across CI hosts. Pin the whole pre-existing suite to
// the X265_POOLS=0 native path (pools=null → NO arg = the frozen pre-37 output) so
// every legacy byte-identical libx265 assertion stays exact. The dedicated 37-01
// describe block below overrides the env per-test to exercise the cap itself.
const _origX265Pools = process.env.X265_POOLS;
beforeEach(() => {
  process.env.X265_POOLS = '0';
  __forTests_resetX265PoolsCache();
});
afterEach(() => {
  if (_origX265Pools === undefined) delete process.env.X265_POOLS;
  else process.env.X265_POOLS = _origX265Pools;
  __forTests_resetX265PoolsCache();
});

describe('buildCodecBlock — per-encoder shape (default preset, AC-12 byte-identical for libx265/nvenc/qsv)', () => {
  it('test_buildCodecBlock_when_libx265_with_default_preset_then_returns_pre_03_01_codec_block_byte_identical', () => {
    expect(buildCodecBlock({ encoder: 'libx265', crf: 23, preset: 'medium' })).toEqual([
      '-c:v',
      'libx265',
      '-preset',
      'medium',
      '-crf',
      '23',
    ]);
  });

  // 2026-04-27 hotfix: ffmpeg expects `hevc_nvenc`, NOT `h265_nvenc`.
  it('test_buildCodecBlock_when_nvenc_with_default_preset_then_includes_hevc_nvenc_constqp_qp_arg', () => {
    expect(buildCodecBlock({ encoder: 'nvenc', crf: 23, preset: 'p5' })).toEqual([
      '-c:v',
      'hevc_nvenc',
      '-preset',
      'p5',
      '-tune',
      'hq',
      '-rc',
      'constqp',
      '-qp',
      '23',
      '-b:v',
      '0',
    ]);
  });

  it('test_buildCodecBlock_when_any_encoder_then_codec_name_NEVER_h265_nvenc', () => {
    for (const enc of ['nvenc', 'qsv', 'vaapi', 'libx265'] as const) {
      const args = buildCodecBlock({
        encoder: enc,
        crf: 23,
        preset: DEFAULT_PRESET_BY_ENCODER[enc],
        devicePath: '/dev/dri/renderD128',
      });
      expect(args).not.toContain('h265_nvenc');
    }
  });

  it('test_buildCodecBlock_when_qsv_with_default_preset_then_includes_hevc_qsv_global_quality_low_power_0_NO_lookahead', () => {
    // 30-01: default (no qsvRateControl) = ICQ-full variant — `-global_quality`
    // path-pinned with `-low_power 0` so ICQ negotiates on the full-encode path.
    const block = buildCodecBlock({ encoder: 'qsv', crf: 22, preset: 'slow' });
    expect(block).toEqual([
      '-c:v',
      'hevc_qsv',
      '-preset',
      'slow',
      '-global_quality',
      '22',
      '-low_power',
      '0',
    ]);
    // 25-02: look_ahead family removed (libvpl/oneVPL rejects MSDK-only options).
    expect(block).not.toContain('-look_ahead');
    expect(block).not.toContain('-look_ahead_depth');
  });

  it('test_buildCodecBlock_when_qsv_cqp_variant_then_uses_q_v_no_global_quality_no_low_power', () => {
    // 30-01 AC-2: the CQP fallback — `-q:v <crf>`, NO `-global_quality`/`-low_power`.
    const block = buildCodecBlock({
      encoder: 'qsv',
      crf: 28,
      preset: 'slow',
      qsvRateControl: 'cqp',
    });
    expect(block).toEqual(['-c:v', 'hevc_qsv', '-preset', 'slow', '-q:v', '28']);
    expect(block).not.toContain('-global_quality');
    expect(block).not.toContain('-low_power');
  });

  it('test_buildCodecBlock_when_qsv_icq_full_explicit_then_matches_default', () => {
    // 30-01 AC-1: explicit 'icq-full' === the default block.
    const explicit = buildCodecBlock({
      encoder: 'qsv',
      crf: 28,
      preset: 'slow',
      qsvRateControl: 'icq-full',
    });
    expect(explicit).toEqual([
      '-c:v',
      'hevc_qsv',
      '-preset',
      'slow',
      '-global_quality',
      '28',
      '-low_power',
      '0',
    ]);
  });

  it('test_buildCodecBlock_when_vaapi_with_devicePath_then_includes_provided_path', () => {
    const block = buildCodecBlock({
      encoder: 'vaapi',
      crf: 22,
      preset: 'slow',
      devicePath: '/dev/dri/renderD129',
    });
    expect(block).toContain('/dev/dri/renderD129');
    expect(block).toContain('-vaapi_device');
    expect(block).toContain('-vf');
    expect(block).toContain('format=nv12,hwupload');
    expect(block).toContain('hevc_vaapi');
    expect(block).toContain('CQP');
  });

  it('test_buildCodecBlock_when_vaapi_without_devicePath_then_falls_back_to_renderD128', () => {
    const block = buildCodecBlock({ encoder: 'vaapi', crf: 22, preset: 'slow' });
    expect(block).toContain('/dev/dri/renderD128');
  });
});

describe('buildCodecBlock — 34-01 qsv device binding (-init_hw_device)', () => {
  it('test_buildCodecBlock_when_qsv_icq_with_devicePath_then_init_hw_device_prepended_before_codec', () => {
    const block = buildCodecBlock({
      encoder: 'qsv',
      crf: 22,
      preset: 'slow',
      devicePath: '/dev/dri/renderD129',
    });
    // SHIPPED FORM (SR-3): B-minus-filter = `-init_hw_device` only, NO `-filter_hw_device`.
    expect(block.slice(0, 2)).toEqual(['-init_hw_device', 'qsv=hw:/dev/dri/renderD129']);
    expect(block).not.toContain('-filter_hw_device');
    // device-init lands BEFORE the encoder selector.
    expect(block.indexOf('-init_hw_device')).toBeLessThan(block.indexOf('hevc_qsv'));
    // the existing ICQ-full body is preserved AFTER the device-init.
    expect(block).toContain('-global_quality');
    expect(block).toContain('-low_power');
  });

  it('test_buildCodecBlock_when_qsv_cqp_with_devicePath_then_full_argv_matches', () => {
    const block = buildCodecBlock({
      encoder: 'qsv',
      crf: 28,
      preset: 'slow',
      devicePath: '/dev/dri/renderD129',
      qsvRateControl: 'cqp',
    });
    expect(block).toEqual([
      '-init_hw_device',
      'qsv=hw:/dev/dri/renderD129',
      '-c:v',
      'hevc_qsv',
      '-preset',
      'slow',
      '-q:v',
      '28',
    ]);
  });

  it('test_buildCodecBlock_when_qsv_without_devicePath_then_no_device_tokens_byte_identical', () => {
    const block = buildCodecBlock({ encoder: 'qsv', crf: 22, preset: 'slow' });
    expect(block).not.toContain('-init_hw_device');
    expect(block).not.toContain('-filter_hw_device');
    // byte-identical to the pre-34 ICQ-full default block (AC-1).
    expect(block).toEqual([
      '-c:v',
      'hevc_qsv',
      '-preset',
      'slow',
      '-global_quality',
      '22',
      '-low_power',
      '0',
    ]);
  });

  it('test_buildCodecBlock_when_qsv_empty_devicePath_then_no_device_tokens', () => {
    const block = buildCodecBlock({ encoder: 'qsv', crf: 22, preset: 'slow', devicePath: '' });
    expect(block).not.toContain('-init_hw_device');
  });
});

describe('buildCodecBlock — error path + invariants', () => {
  it('test_buildCodecBlock_when_unknown_encoder_then_throws_TypeError', () => {
    expect(() =>
      buildCodecBlock({ encoder: 'av1_nvenc' as EncoderId, crf: 23, preset: 'medium' }),
    ).toThrow(TypeError);
  });

  it('test_buildCodecBlock_when_crf_passed_then_value_appears_at_correct_index_per_profile', () => {
    // libx265: index 5 (after -c:v libx265 -preset medium -crf)
    expect(buildCodecBlock({ encoder: 'libx265', crf: 28, preset: 'medium' })[5]).toBe('28');
    // nvenc: index 9 (after ... -qp)
    expect(buildCodecBlock({ encoder: 'nvenc', crf: 28, preset: 'p5' })[9]).toBe('28');
    // qsv: index 5 (after -c:v hevc_qsv -preset slow -global_quality)
    expect(buildCodecBlock({ encoder: 'qsv', crf: 28, preset: 'slow' })[5]).toBe('28');
    // vaapi: index 11 (12-03: +2 from inserted -preset <value> after hevc_vaapi)
    expect(buildCodecBlock({ encoder: 'vaapi', crf: 28, preset: 'slow' })[11]).toBe('28');
  });

  it('test_PROFILE_BUILDERS_when_inspected_then_covers_all_ENCODER_IDS', () => {
    for (const id of ENCODER_IDS) {
      expect(PROFILE_BUILDERS[id]).toBeTypeOf('function');
    }
  });
});

describe('buildEncodeArgs — full envelope composition', () => {
  it('test_buildEncodeArgs_when_called_then_returns_envelope_head_codecblock_envelope_tail', () => {
    const args = buildEncodeArgs({
      encoder: 'libx265',
      crf: 23,
      preset: 'medium',
      input: '/in.mp4',
      output: '/out.x265.mkv',
    });
    expect(args.slice(0, 5)).toEqual(['-hide_banner', '-nostats', '-y', '-i', '/in.mp4']);
    // Codec block follows envelope head.
    expect(args.slice(5, 11)).toEqual(['-c:v', 'libx265', '-preset', 'medium', '-crf', '23']);
    // Envelope tail closes with -progress pipe:1 <output>.
    expect(args[args.length - 3]).toBe('-progress');
    expect(args[args.length - 2]).toBe('pipe:1');
    expect(args[args.length - 1]).toBe('/out.x265.mkv');
  });

  it('test_buildEncodeArgs_when_called_then_args_are_array_no_shell_interpolation', () => {
    const args = buildEncodeArgs({
      encoder: 'nvenc',
      crf: 23,
      preset: 'p5',
      input: '/path with spaces/input file.mkv',
      output: '/out.mkv',
    });
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain('/path with spaces/input file.mkv');
  });

  it('test_buildEncodeArgs_when_called_then_output_is_last_arg', () => {
    const args = buildEncodeArgs({
      encoder: 'qsv',
      crf: 22,
      preset: 'slow',
      input: '/i',
      output: '/last.mkv',
    });
    expect(args[args.length - 1]).toBe('/last.mkv');
  });

  it('test_buildEncodeArgs_when_called_then_progress_pipe_1_immediately_precedes_output', () => {
    const args = buildEncodeArgs({
      encoder: 'vaapi',
      crf: 22,
      preset: 'slow',
      input: '/i',
      output: '/o',
      devicePath: '/dev/dri/renderD128',
    });
    const pipeIdx = args.indexOf('pipe:1');
    expect(pipeIdx).toBe(args.length - 2);
    expect(args[pipeIdx - 1]).toBe('-progress');
  });

  it('test_buildEncodeArgs_when_libx265_with_default_preset_then_full_array_matches_pre_03_01_buildArgs_byte_identical', () => {
    const args = buildEncodeArgs({
      encoder: 'libx265',
      crf: 23,
      preset: 'medium',
      input: '/in.mp4',
      output: '/out.x265.mkv',
    });
    // AC-12 byte-identical regression gate (Phase-2 8926→8185 bytes baseline).
    expect(args).toEqual([
      '-hide_banner',
      '-nostats',
      '-y',
      '-i',
      '/in.mp4',
      '-c:v',
      'libx265',
      '-preset',
      'medium',
      '-crf',
      '23',
      '-c:a',
      'copy',
      '-c:s',
      'copy',
      '-map',
      '0',
      '-map_metadata',
      '0',
      '-movflags',
      '+faststart',
      '-progress',
      'pipe:1',
      '/out.x265.mkv',
    ]);
  });
});

describe('buildEncodeArgs — invariants across all 4 profiles', () => {
  it.each(ENCODER_IDS)(
    'test_buildEncodeArgs_when_encoder_%s_then_audio_subtitle_copy_preserved',
    (encoder) => {
      const args = buildEncodeArgs({
        encoder,
        crf: 23,
        preset: DEFAULT_PRESET_BY_ENCODER[encoder],
        input: '/i',
        output: '/o',
      });
      const aIdx = args.indexOf('-c:a');
      expect(aIdx).toBeGreaterThan(0);
      expect(args[aIdx + 1]).toBe('copy');
      const sIdx = args.indexOf('-c:s');
      expect(sIdx).toBeGreaterThan(0);
      expect(args[sIdx + 1]).toBe('copy');
    },
  );

  it.each(ENCODER_IDS)(
    'test_buildEncodeArgs_when_encoder_%s_then_map_metadata_zero_preserved',
    (encoder) => {
      const args = buildEncodeArgs({
        encoder,
        crf: 23,
        preset: DEFAULT_PRESET_BY_ENCODER[encoder],
        input: '/i',
        output: '/o',
      });
      const idx = args.indexOf('-map_metadata');
      expect(idx).toBeGreaterThan(0);
      expect(args[idx + 1]).toBe('0');
    },
  );
});

// 12-03: preset-override + Catalog-validator-fallback + per-encoder SR1
// byte-identical non-preset flags + AC-3 VAAPI both-flags coexistence.
describe('buildCodecBlock — 12-03 preset override + Catalog-validator-fallback', () => {
  it('test_buildCodecBlock_when_libx265_with_slow_preset_then_argv_threads_preset_slow', () => {
    const args = buildCodecBlock({ encoder: 'libx265', crf: 23, preset: 'slow' });
    expect(args).toContain('-preset');
    expect(args[args.indexOf('-preset') + 1]).toBe('slow');
    expect(args[args.indexOf('-crf') + 1]).toBe('23');
  });

  it('test_buildCodecBlock_when_libx265_with_invalid_preset_then_falls_back_to_DEFAULT_medium', () => {
    const args = buildCodecBlock({ encoder: 'libx265', crf: 23, preset: 'turbo' });
    expect(args[args.indexOf('-preset') + 1]).toBe('medium');
  });

  it('test_buildCodecBlock_when_nvenc_with_p7_preset_then_argv_threads_p7_AND_non_preset_flags_byte_identical', () => {
    // AC-3 SR1: non-preset flags must remain byte-identical pre-12-03.
    expect(buildCodecBlock({ encoder: 'nvenc', crf: 22, preset: 'p7' })).toEqual([
      '-c:v',
      'hevc_nvenc',
      '-preset',
      'p7',
      '-tune',
      'hq',
      '-rc',
      'constqp',
      '-qp',
      '22',
      '-b:v',
      '0',
    ]);
  });

  it('test_buildCodecBlock_when_nvenc_with_invalid_preset_then_falls_back_to_DEFAULT_p5', () => {
    const args = buildCodecBlock({ encoder: 'nvenc', crf: 22, preset: 'lightspeed' });
    expect(args[args.indexOf('-preset') + 1]).toBe('p5');
  });

  it('test_buildCodecBlock_when_qsv_with_veryslow_preset_then_argv_threads_veryslow_AND_global_quality_low_power_0_NO_lookahead', () => {
    // 25-02 SR1: qsv block = global_quality + preset; look_ahead REMOVED (libvpl-compat).
    // 30-01: ICQ-full default now pins `-low_power 0`.
    expect(buildCodecBlock({ encoder: 'qsv', crf: 22, preset: 'veryslow' })).toEqual([
      '-c:v',
      'hevc_qsv',
      '-preset',
      'veryslow',
      '-global_quality',
      '22',
      '-low_power',
      '0',
    ]);
  });

  // 30-01 AC-3: non-qsv encoders are byte-identical even when a qsvRateControl is
  // present in input (the param is qsv-only; the other builders ignore it).
  it.each(['libx265', 'nvenc', 'vaapi'] as const)(
    'test_buildCodecBlock_when_%s_with_qsvRateControl_present_then_byte_identical_to_absent',
    (encoder) => {
      const base = { encoder, crf: 23, preset: DEFAULT_PRESET_BY_ENCODER[encoder] };
      const withCqp = buildCodecBlock({ ...base, qsvRateControl: 'cqp' });
      const withIcq = buildCodecBlock({ ...base, qsvRateControl: 'icq-full' });
      const without = buildCodecBlock(base);
      expect(withCqp).toEqual(without);
      expect(withIcq).toEqual(without);
      expect(without).not.toContain('-q:v');
    },
  );

  it('test_buildCodecBlock_when_qsv_with_invalid_preset_then_falls_back_to_DEFAULT_slow', () => {
    const args = buildCodecBlock({ encoder: 'qsv', crf: 22, preset: 'placebo' });
    expect(args[args.indexOf('-preset') + 1]).toBe('slow');
  });

  it('test_buildCodecBlock_when_vaapi_with_fast_preset_then_argv_contains_BOTH_preset_AND_compression_level_1_M5', () => {
    // AC-3 M5: VAAPI must carry BOTH `-preset <value>` AND `-compression_level 1`
    // (preset informational; compression_level is authoritative driver knob).
    const args = buildCodecBlock({
      encoder: 'vaapi',
      crf: 22,
      preset: 'fast',
      devicePath: '/dev/dri/renderD128',
    });
    expect(args).toContain('-preset');
    expect(args[args.indexOf('-preset') + 1]).toBe('fast');
    const clIdx = args.indexOf('-compression_level');
    expect(clIdx).toBeGreaterThan(0);
    expect(args[clIdx + 1]).toBe('1');
  });

  it('test_buildCodecBlock_when_vaapi_relative_order_then_rc_mode_CQP_then_qp_then_compression_level_AC3', () => {
    // AC-3 explicit relative-order: -rc_mode CQP → -qp <crf> → -compression_level 1.
    const args = buildCodecBlock({ encoder: 'vaapi', crf: 22, preset: 'slow' });
    const rcModeIdx = args.indexOf('-rc_mode');
    const qpIdx = args.indexOf('-qp');
    const clIdx = args.indexOf('-compression_level');
    expect(rcModeIdx).toBeGreaterThan(-1);
    expect(qpIdx).toBeGreaterThan(rcModeIdx);
    expect(clIdx).toBeGreaterThan(qpIdx);
    expect(args[rcModeIdx + 1]).toBe('CQP');
    expect(args[qpIdx + 1]).toBe('22');
    expect(args[clIdx + 1]).toBe('1');
  });

  it('test_buildCodecBlock_when_vaapi_with_invalid_preset_then_falls_back_to_DEFAULT_slow', () => {
    const args = buildCodecBlock({ encoder: 'vaapi', crf: 22, preset: 'whatever' });
    expect(args[args.indexOf('-preset') + 1]).toBe('slow');
  });
});

// 35-01 — auto-crop CPU-crop filter composition (D3 uniform).
describe('buildCodecBlock — 35-01 CPU-crop composition', () => {
  const CROP = '1920:800:0:140';

  it('libx265: prepends -vf crop=W:H:X:Y before the codec block', () => {
    expect(buildCodecBlock({ encoder: 'libx265', crf: 23, preset: 'medium', crop: CROP })).toEqual([
      '-vf',
      `crop=${CROP}`,
      '-c:v',
      'libx265',
      '-preset',
      'medium',
      '-crf',
      '23',
    ]);
  });

  it('nvenc: prepends -vf crop=W:H:X:Y before the codec block', () => {
    const block = buildCodecBlock({ encoder: 'nvenc', crf: 23, preset: 'p5', crop: CROP });
    expect(block.slice(0, 3)).toEqual(['-vf', `crop=${CROP}`, '-c:v']);
    expect(block[3]).toBe('hevc_nvenc');
  });

  it('qsv: crop -vf follows the 34-01 -init_hw_device tokens, before -c:v (AC-2)', () => {
    const block = buildCodecBlock({
      encoder: 'qsv',
      crf: 22,
      preset: 'slow',
      devicePath: '/dev/dri/renderD129',
      crop: CROP,
    });
    expect(block.slice(0, 5)).toEqual([
      '-init_hw_device',
      'qsv=hw:/dev/dri/renderD129',
      '-vf',
      `crop=${CROP}`,
      '-c:v',
    ]);
  });

  it('qsv: crop -vf precedes -c:v even with no devicePath', () => {
    const block = buildCodecBlock({ encoder: 'qsv', crf: 22, preset: 'slow', crop: CROP });
    expect(block.slice(0, 3)).toEqual(['-vf', `crop=${CROP}`, '-c:v']);
  });

  it('vaapi: merges crop INTO the existing filter chain before hwupload', () => {
    const block = buildCodecBlock({ encoder: 'vaapi', crf: 22, preset: 'slow', crop: CROP });
    const vfIdx = block.indexOf('-vf');
    expect(block[vfIdx + 1]).toBe(`crop=${CROP},format=nv12,hwupload`);
  });

  it.each([...ENCODER_IDS])('crop undefined → byte-identical to pre-35 (%s)', (enc) => {
    const withUndef = buildCodecBlock({
      encoder: enc,
      crf: 23,
      preset: DEFAULT_PRESET_BY_ENCODER[enc],
    });
    const explicit = buildCodecBlock({
      encoder: enc,
      crf: 23,
      preset: DEFAULT_PRESET_BY_ENCODER[enc],
      crop: undefined,
    });
    expect(withUndef).toEqual(explicit);
    // No crop token leaks when undefined.
    expect(withUndef.join(' ')).not.toContain('crop=');
  });
});

// 37-01 — libx265 x265 thread-pool cap (`-x265-params pools=<N>`).
describe('resolveX265Pools — pure cap resolver (AC-1..AC-5, S2)', () => {
  it('caps small host at its own cpuCount (AC-2)', () => {
    expect(resolveX265Pools(4, undefined)).toBe(4);
  });
  it('caps high-core host at the ceiling 16 (AC-1)', () => {
    expect(resolveX265Pools(128, undefined)).toBe(16);
  });
  it('cpuCount exactly at ceiling → ceiling', () => {
    expect(resolveX265Pools(16, undefined)).toBe(16);
  });
  it('invalid cpuCount (0 / NaN) → ceiling fallback', () => {
    expect(resolveX265Pools(0, undefined)).toBe(X265_POOLS_CEILING);
    expect(resolveX265Pools(NaN, undefined)).toBe(X265_POOLS_CEILING);
  });
  it('exact operator override below ceiling (AC-3)', () => {
    expect(resolveX265Pools(128, '8')).toBe(8);
  });
  it('operator override is UNCLAMPED above the ceiling BY DESIGN (S2)', () => {
    // big-host escape hatch — operators on a genuine large box may pin pools>16.
    expect(resolveX265Pools(8, '64')).toBe(64);
  });
  it('"0" → null = native revert (AC-4)', () => {
    expect(resolveX265Pools(128, '0')).toBeNull();
  });
  it('"auto"/"AUTO" → null, case-insensitive (AC-4)', () => {
    expect(resolveX265Pools(128, 'auto')).toBeNull();
    expect(resolveX265Pools(128, 'AUTO')).toBeNull();
  });
  it('unparseable / empty / negative / float → ignored, computed cap used (AC-5)', () => {
    expect(resolveX265Pools(128, 'abc')).toBe(16);
    expect(resolveX265Pools(128, '')).toBe(16);
    expect(resolveX265Pools(128, '-4')).toBe(16);
    expect(resolveX265Pools(128, '3.5')).toBe(16);
  });
});

describe('libx265 builder — x265Pools() integration (AC-1..AC-9)', () => {
  // these tests drive the memoized getter, so each sets env + resets the cache.
  const setEnv = (v: string | undefined) => {
    if (v === undefined) delete process.env.X265_POOLS;
    else process.env.X265_POOLS = v;
    __forTests_resetX265PoolsCache();
  };

  it('env unset → libx265 block carries -x265-params pools=<computed> (AC-9 default behavior change)', () => {
    setEnv(undefined);
    const block = buildCodecBlock({ encoder: 'libx265', crf: 23, preset: 'medium' });
    const idx = block.indexOf('-x265-params');
    expect(idx).toBeGreaterThan(-1);
    expect(block[idx + 1]).toMatch(/^pools=\d+$/);
  });

  it('X265_POOLS=8 → exact pools=8 in the libx265 block (AC-3)', () => {
    setEnv('8');
    const block = buildCodecBlock({ encoder: 'libx265', crf: 23, preset: 'medium' });
    expect(block).toContain('-x265-params');
    expect(block[block.indexOf('-x265-params') + 1]).toBe('pools=8');
    // appended AFTER -crf <value>, so the index-5 crf invariant is preserved.
    expect(block[block.indexOf('-crf') + 1]).toBe('23');
  });

  it('X265_POOLS=0 → NO -x265-params token, byte-identical to pre-37 native (AC-4)', () => {
    setEnv('0');
    const block = buildCodecBlock({ encoder: 'libx265', crf: 23, preset: 'medium' });
    expect(block).not.toContain('-x265-params');
    expect(block).toEqual(['-c:v', 'libx265', '-preset', 'medium', '-crf', '23']);
  });

  it.each(['nvenc', 'qsv', 'vaapi'] as const)(
    'encoder %s → NO -x265-params / pools= token even with X265_POOLS=8 (AC-6)',
    (encoder) => {
      setEnv('8');
      const block = buildCodecBlock({
        encoder,
        crf: 23,
        preset: DEFAULT_PRESET_BY_ENCODER[encoder],
        devicePath: '/dev/dri/renderD128',
      });
      expect(block).not.toContain('-x265-params');
      expect(block.join(' ')).not.toContain('pools=');
    },
  );

  it('single-site reach: production + test-encode + detection-probe libx265 argv ALL carry pools=8 (AC-7)', () => {
    setEnv('8');
    const prod = buildCodecBlock({ encoder: 'libx265', crf: 23, preset: 'medium' });
    const test = buildTestEncodeArgs('libx265');
    const probe = __forTests_buildProbeEncodeArgs('libx265');
    for (const argv of [prod, test, probe]) {
      const idx = argv.indexOf('-x265-params');
      expect(idx).toBeGreaterThan(-1);
      expect(argv[idx + 1]).toBe('pools=8');
    }
  });
});

describe('x265Pools() once-log — audit evidence (AC-8)', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
  });
  afterEach(() => {
    infoSpy.mockRestore();
  });

  const resetEnv = (v: string | undefined) => {
    if (v === undefined) delete process.env.X265_POOLS;
    else process.env.X265_POOLS = v;
    __forTests_resetX265PoolsCache();
  };

  it('logs exactly once across two builds, payload carries resolvedPools+source+cpuCount', () => {
    resetEnv(undefined);
    buildCodecBlock({ encoder: 'libx265', crf: 23, preset: 'medium' });
    buildCodecBlock({ encoder: 'libx265', crf: 23, preset: 'medium' });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [payload, msg] = infoSpy.mock.calls[0];
    expect(msg).toBe('x265: libx265 thread-pool cap resolved');
    expect(payload).toMatchObject({
      source: 'computed-cap',
      resolvedPools: expect.any(Number),
      cpuCount: expect.any(Number),
    });
  });

  it('source=operator-override when X265_POOLS=8', () => {
    resetEnv('8');
    buildCodecBlock({ encoder: 'libx265', crf: 23, preset: 'medium' });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][0]).toMatchObject({
      source: 'operator-override',
      resolvedPools: 8,
    });
  });

  it('source=native-revert with resolvedPools null when X265_POOLS=0', () => {
    resetEnv('0');
    buildCodecBlock({ encoder: 'libx265', crf: 23, preset: 'medium' });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0][0]).toMatchObject({
      source: 'native-revert',
      resolvedPools: null,
    });
  });
});
