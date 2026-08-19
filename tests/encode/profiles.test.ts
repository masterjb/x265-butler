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

// 43-01 — force-10bit (tenBit) per-encoder codec args. OFF (omitted/false) is
// byte-identical to pre-43 for all four encoders (AC-1); ON emits the per-encoder
// Main10 tokens (AC-2/3/4/5). X265_POOLS=0 (suite beforeEach) keeps libx265 on the
// native path so the byte-identical assertions stay exact.
describe('buildCodecBlock — 43-01 force-10bit (tenBit)', () => {
  const CROP = '1920:800:0:140';

  // AC-1: tenBit omitted OR false ⇒ byte-identical to the no-tenBit block.
  it.each([...ENCODER_IDS])('tenBit omitted/false → byte-identical to pre-43 (%s)', (enc) => {
    const base = { encoder: enc, crf: 23, preset: DEFAULT_PRESET_BY_ENCODER[enc] };
    const omitted = buildCodecBlock(base);
    const explicitFalse = buildCodecBlock({ ...base, tenBit: false });
    expect(explicitFalse).toEqual(omitted);
    // No 10-bit token leaks when OFF.
    const joined = omitted.join(' ');
    expect(joined).not.toContain('main10');
    expect(joined).not.toContain('yuv420p10le');
    expect(joined).not.toContain('p010le');
  });

  // AC-2: libx265 10-bit — tokens appended AFTER -crf, ahead of any -x265-params tail.
  it('libx265: tenBit appends -pix_fmt yuv420p10le -profile:v main10 after -crf', () => {
    expect(
      buildCodecBlock({ encoder: 'libx265', crf: 23, preset: 'medium', tenBit: true }),
    ).toEqual([
      '-c:v',
      'libx265',
      '-preset',
      'medium',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p10le',
      '-profile:v',
      'main10',
    ]);
  });

  // AC-2 ordering: 10-bit tokens precede the -x265-params pools tail when the cap is active.
  it('libx265: tenBit tokens sit BEFORE the -x265-params pools tail', () => {
    process.env.X265_POOLS = '8';
    __forTests_resetX265PoolsCache();
    const block = buildCodecBlock({ encoder: 'libx265', crf: 23, preset: 'medium', tenBit: true });
    expect(block).toEqual([
      '-c:v',
      'libx265',
      '-preset',
      'medium',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p10le',
      '-profile:v',
      'main10',
      '-x265-params',
      'pools=8',
    ]);
  });

  // AC-3: nvenc 10-bit.
  it('nvenc: tenBit appends -pix_fmt p010le -profile:v main10 after -b:v 0', () => {
    expect(buildCodecBlock({ encoder: 'nvenc', crf: 23, preset: 'p5', tenBit: true })).toEqual([
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
      '-pix_fmt',
      'p010le',
      '-profile:v',
      'main10',
    ]);
  });

  // AC-4: qsv 10-bit — BOTH ratecontrol branches.
  it('qsv icq-full: tenBit appends -pix_fmt p010le -profile:v main10', () => {
    expect(buildCodecBlock({ encoder: 'qsv', crf: 22, preset: 'slow', tenBit: true })).toEqual([
      '-c:v',
      'hevc_qsv',
      '-preset',
      'slow',
      '-global_quality',
      '22',
      '-low_power',
      '0',
      '-pix_fmt',
      'p010le',
      '-profile:v',
      'main10',
    ]);
  });

  it('qsv cqp: tenBit appends -pix_fmt p010le -profile:v main10', () => {
    expect(
      buildCodecBlock({
        encoder: 'qsv',
        crf: 22,
        preset: 'slow',
        qsvRateControl: 'cqp',
        tenBit: true,
      }),
    ).toEqual([
      '-c:v',
      'hevc_qsv',
      '-preset',
      'slow',
      '-q:v',
      '22',
      '-pix_fmt',
      'p010le',
      '-profile:v',
      'main10',
    ]);
  });

  // AC-5: vaapi 10-bit — filter format swap nv12→p010le (MH-1: canonical pix_fmt,
  // NOT bare 'p010') + -profile:v main10.
  it('vaapi: tenBit swaps filter format to p010le and appends -profile:v main10', () => {
    const block = buildCodecBlock({ encoder: 'vaapi', crf: 22, preset: 'slow', tenBit: true });
    const vfIdx = block.indexOf('-vf');
    expect(block[vfIdx + 1]).toBe('format=p010le,hwupload');
    // MH-1: bare 'p010' must NOT appear; nv12 must be gone.
    expect(block[vfIdx + 1]).not.toContain('nv12');
    expect(block.join(' ')).not.toMatch(/format=p010\b(?!le)/);
    expect(block).toContain('-profile:v');
    expect(block).toContain('main10');
  });

  // AC-5 + SR-3: vaapi 4-cell tenBit×crop matrix.
  it('vaapi: 4-cell tenBit×crop matrix (OFF cells byte-identical, ON cells p010le)', () => {
    const at = (tenBit: boolean, crop?: string) => {
      const block = buildCodecBlock({ encoder: 'vaapi', crf: 22, preset: 'slow', crop, tenBit });
      return block[block.indexOf('-vf') + 1];
    };
    // OFF cells — byte-identical to pre-43.
    expect(at(false, undefined)).toBe('format=nv12,hwupload');
    expect(at(false, CROP)).toBe(`crop=${CROP},format=nv12,hwupload`);
    // ON cells — p010le, composing with crop.
    expect(at(true, undefined)).toBe('format=p010le,hwupload');
    expect(at(true, CROP)).toBe(`crop=${CROP},format=p010le,hwupload`);
  });

  // SR-4: detection-probe + test-encode arg-builders build their OWN args and
  // never receive tenBit → 8-bit by construction (NO 10-bit token can leak).
  it('SR-4: probe + test-encode args carry NO 10-bit token (8-bit by construction)', () => {
    for (const enc of ENCODER_IDS) {
      const probe = __forTests_buildProbeEncodeArgs(enc, '/dev/dri/renderD128').join(' ');
      const test = buildTestEncodeArgs(enc, '/dev/dri/renderD128').join(' ');
      for (const joined of [probe, test]) {
        expect(joined).not.toContain('main10');
        expect(joined).not.toContain('yuv420p10le');
        expect(joined).not.toContain('p010le');
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 49-01 (AC-13): video-filter narrowing. A bare `-vf` matches EVERY video output
// stream — including one carrying `-c:v:N copy` — and ffmpeg then refuses to open
// the output ("Filtering and streamcopy cannot be used together"). When encoded
// video ordinals are supplied, every filter gets a per-ordinal specifier.
// ─────────────────────────────────────────────────────────────────────────────
describe('49-01 videoFilterOrdinals — filter specifier narrowing', () => {
  const CROP49 = '1920:800:0:140';

  const block = (encoder: EncoderId, ordinals?: ReadonlyArray<number>, crop?: string) =>
    buildCodecBlock({
      encoder,
      crf: 24,
      preset: DEFAULT_PRESET_BY_ENCODER[encoder],
      crop,
      videoFilterOrdinals: ordinals,
    });

  it('undefined ordinals ⇒ bare -vf for every encoder (byte-identical default)', () => {
    for (const enc of ENCODER_IDS) {
      const withOrdinals = block(enc, undefined, CROP49);
      const baseline = buildCodecBlock({
        encoder: enc,
        crf: 24,
        preset: DEFAULT_PRESET_BY_ENCODER[enc],
        crop: CROP49,
      });
      expect(withOrdinals).toEqual(baseline);
      expect(withOrdinals).toContain('-vf');
      expect(withOrdinals.some((t) => t.startsWith('-filter:v:'))).toBe(false);
    }
  });

  it('empty ordinals array ⇒ bare -vf (same default contract)', () => {
    for (const enc of ENCODER_IDS) {
      const args = block(enc, [], CROP49);
      expect(args).toContain('-vf');
      expect(args.some((t) => t.startsWith('-filter:v:'))).toBe(false);
    }
  });

  it('[0] ⇒ -filter:v:0 and NO bare -vf, for every encoder that emits a filter', () => {
    for (const enc of ENCODER_IDS) {
      const args = block(enc, [0], CROP49);
      expect(args).not.toContain('-vf');
      expect(args).toContain('-filter:v:0');
      // the chain itself is unchanged — only the specifier moved
      const idx = args.indexOf('-filter:v:0');
      expect(args[idx + 1]).toContain(`crop=${CROP49}`);
    }
  });

  it('[0,1] ⇒ one pair per encoded ordinal with an identical chain', () => {
    const args = block('libx265', [0, 1], CROP49);
    expect(args.slice(0, 4)).toEqual([
      '-filter:v:0',
      `crop=${CROP49}`,
      '-filter:v:1',
      `crop=${CROP49}`,
    ]);
    expect(args).not.toContain('-vf');
  });

  it('vaapi narrows its UNCONDITIONAL chain — the case that makes this mandatory', () => {
    // vaapi emits format=…,hwupload whether or not a crop resolved, so without
    // narrowing a cover stream breaks EVERY vaapi job, not just cropped ones.
    const noCrop = block('vaapi', [0]);
    expect(noCrop).not.toContain('-vf');
    expect(noCrop).toContain('-filter:v:0');
    expect(noCrop[noCrop.indexOf('-filter:v:0') + 1]).toBe('format=nv12,hwupload');

    const cropped = block('vaapi', [0], CROP49);
    expect(cropped[cropped.indexOf('-filter:v:0') + 1]).toBe(`crop=${CROP49},format=nv12,hwupload`);
  });

  it('the codec token stays GLOBAL — -c:v is never narrowed to -c:v:0 (D2 variant A stays rejected)', () => {
    for (const enc of ENCODER_IDS) {
      const args = block(enc, [0], CROP49);
      expect(args).toContain('-c:v');
      expect(args).not.toContain('-c:v:0');
    }
  });

  it('libx265/nvenc/qsv emit no filter at all without a crop, ordinals or not', () => {
    for (const enc of ['libx265', 'nvenc', 'qsv'] as EncoderId[]) {
      const args = block(enc, [0]);
      expect(args).not.toContain('-vf');
      expect(args.some((t) => t.startsWith('-filter:v:'))).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 49-02 (AC-5 / AC-6): the closed-GOP IDR pin. `-force_key_frames` alone forces
// keyframes at the right TIMES but they come out as open CRA frames (measured,
// M2) — CRA + RASL leading pictures is exactly the "block garbage over the
// picture" the N100 reporter saw. The pin is a SECOND, independent knob.
//
// Token forms are taken VERBATIM from `ffmpeg -h encoder=…` (M3/M5d):
//   hevc_qsv   -forced_idr   <boolean>  (default false)   ← UNDERSCORE
//   hevc_nvenc -forced-idr   <boolean>  (default false)   ← HYPHEN
//   hevc_vaapi -idr_interval <int>      (default 0)       ← no forced_idr at all
// ─────────────────────────────────────────────────────────────────────────────
describe('49-02 forceIdr — per-encoder IDR pin (AC-5)', () => {
  const block = (encoder: EncoderId, forceIdr?: boolean, extra: Record<string, unknown> = {}) =>
    buildCodecBlock({
      encoder,
      crf: 24,
      preset: DEFAULT_PRESET_BY_ENCODER[encoder],
      forceIdr,
      ...extra,
    } as Parameters<typeof buildCodecBlock>[0]);

  it('AC-5 default contract: undefined and false are byte-identical for every encoder', () => {
    for (const enc of ENCODER_IDS) {
      const omitted = buildCodecBlock({
        encoder: enc,
        crf: 24,
        preset: DEFAULT_PRESET_BY_ENCODER[enc],
      });
      expect(block(enc, undefined)).toEqual(omitted);
      expect(block(enc, false)).toEqual(omitted);
      // and no IDR token leaks into the default block
      expect(omitted).not.toContain('-forced_idr');
      expect(omitted).not.toContain('-forced-idr');
      expect(omitted.join(' ')).not.toContain('open-gop');
    }
  });

  it('AC-5 libx265: open-gop=0 lands in the single -x265-params token', () => {
    const args = block('libx265', true);
    const idx = args.indexOf('-x265-params');
    expect(idx).toBeGreaterThanOrEqual(0);
    // X265_POOLS=0 via the suite beforeEach ⇒ no pools= prefix, no hdr10 ⇒ exact
    expect(args[idx + 1]).toBe('open-gop=0');
    expect(args.filter((t) => t === '-x265-params')).toHaveLength(1);
  });

  it('AC-5 qsv: -forced_idr 1 in BOTH ratecontrol branches (UNDERSCORE)', () => {
    for (const qsvRateControl of ['cqp', 'icq-full'] as const) {
      const args = block('qsv', true, { qsvRateControl });
      expect(args).toContain('-forced_idr');
      expect(args[args.indexOf('-forced_idr') + 1]).toBe('1');
      // never the nvenc spelling
      expect(args).not.toContain('-forced-idr');
      // …and it is the LAST pair in the block
      expect(args.slice(-2)).toEqual(['-forced_idr', '1']);
    }
  });

  it('AC-5 qsv: composes with tenBit — IDR pin comes AFTER the 10-bit tokens', () => {
    for (const qsvRateControl of ['cqp', 'icq-full'] as const) {
      const args = block('qsv', true, { qsvRateControl, tenBit: true });
      expect(args.indexOf('-forced_idr')).toBeGreaterThan(args.indexOf('-profile:v'));
      expect(args.slice(-2)).toEqual(['-forced_idr', '1']);
    }
  });

  it('AC-5 nvenc: -forced-idr 1 (HYPHEN, per the binary option table)', () => {
    const args = block('nvenc', true);
    expect(args).toContain('-forced-idr');
    expect(args[args.indexOf('-forced-idr') + 1]).toBe('1');
    expect(args).not.toContain('-forced_idr');
    expect(args.slice(-2)).toEqual(['-forced-idr', '1']);
  });

  it('AC-5 vaapi: emits NO IDR token at all, by design', () => {
    const args = block('vaapi', true);
    const withoutPin = block('vaapi', false);
    // hevc_vaapi has no forced_idr; its idr_interval default 0 already means
    // "every I is an IDR", and emitting `-idr_interval 0` would be a no-op token
    // that manufactures false confidence. So the vaapi block is UNCHANGED.
    expect(args).toEqual(withoutPin);
    expect(args).not.toContain('-forced_idr');
    expect(args).not.toContain('-forced-idr');
    expect(args).not.toContain('-idr_interval');
  });

  it('AC-5: the 4-encoder × {undefined,false,true} matrix emits the expected token count', () => {
    const expected: Record<EncoderId, string | null> = {
      libx265: 'open-gop=0',
      qsv: '-forced_idr',
      nvenc: '-forced-idr',
      vaapi: null,
    };
    for (const enc of ENCODER_IDS) {
      for (const forceIdr of [undefined, false] as const) {
        const args = block(enc, forceIdr).join(' ');
        expect(args).not.toContain('open-gop=0');
        expect(args).not.toContain('-forced_idr');
        expect(args).not.toContain('-forced-idr');
      }
      const on = block(enc, true).join(' ');
      const token = expected[enc];
      if (token === null) expect(on).toBe(block(enc, false).join(' '));
      else expect(on).toContain(token);
    }
  });
});

// AC-6: libx265 must carry exactly ONE -x265-params token no matter how many
// segments contribute (37-01 pools, 43-04 HDR10, 49-02 open-gop). x265 evaluates
// only the LAST such token — a second one would silently discard the first.
describe('49-02 libx265 -x265-params merge — AC-6 (pools × hdr10 × forceIdr)', () => {
  const HDR = { masterDisplay: 'G(1,2)B(3,4)R(5,6)WP(7,8)L(9,1)', maxCll: '1000,400' };

  function x265(forceIdr: boolean, pools: string, hdr10: boolean): string[] {
    process.env.X265_POOLS = pools;
    __forTests_resetX265PoolsCache();
    return buildCodecBlock({
      encoder: 'libx265',
      crf: 22,
      preset: 'medium',
      forceIdr,
      hdr10: hdr10 ? HDR : undefined,
    });
  }

  it('AC-6: pools + hdr10 + forceIdr ⇒ ONE token, open-gop=0 LAST', () => {
    const args = x265(true, '8', true);
    expect(args.filter((t) => t === '-x265-params')).toHaveLength(1);
    expect(args[args.indexOf('-x265-params') + 1]).toBe(
      `pools=8:master-display=${HDR.masterDisplay}:max-cll=${HDR.maxCll}:open-gop=0`,
    );
  });

  it('AC-6: pools=null (X265_POOLS=0) and no hdr10 ⇒ exactly "open-gop=0"', () => {
    const args = x265(true, '0', false);
    expect(args.filter((t) => t === '-x265-params')).toHaveLength(1);
    expect(args[args.indexOf('-x265-params') + 1]).toBe('open-gop=0');
  });

  it('AC-6: the full 2×2×2 matrix never emits two -x265-params tokens', () => {
    for (const forceIdr of [false, true]) {
      for (const pools of ['0', '8']) {
        for (const hdr10 of [false, true]) {
          const args = x265(forceIdr, pools, hdr10);
          expect(args.filter((t) => t === '-x265-params').length).toBeLessThanOrEqual(1);
          const idx = args.indexOf('-x265-params');
          if (idx >= 0 && forceIdr) {
            const segments = args[idx + 1].split(':');
            // open-gop=0 is appended LAST, after pools / master-display / max-cll
            expect(segments[segments.length - 1]).toBe('open-gop=0');
          }
        }
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 49-03 (AC-1 … AC-4): the synthetic-probe `-pix_fmt` pin.
//
// G3, N100 forum report: `testsrc` produces rgb24. Modern `hevc_qsv` builds list
// RGB in their `pix_fmts` table, so ffmpeg does NOT auto-insert a converter — it
// hands RGB to the runtime and iHD refuses (`Current pixel format is
// unsupported`). Boot detection + /diagnostics then report the encoder BROKEN
// while the same host's real (yuv420p) encodes RUN.
//
// The field is set EXCLUSIVELY by the two synthetic builders. `buildArgs` never
// sets it ⇒ the production argv stays byte-identical to v2.46.0 ⇒ no kill-switch
// is needed (D6). These assertions freeze BOTH halves of that contract.
// ─────────────────────────────────────────────────────────────────────────────
describe('49-03 pixFmt — synthetic probe pixel-format pin', () => {
  const block = (encoder: EncoderId, extra: Record<string, unknown> = {}) =>
    buildCodecBlock({
      encoder,
      crf: 24,
      preset: DEFAULT_PRESET_BY_ENCODER[encoder],
      ...extra,
    } as Parameters<typeof buildCodecBlock>[0]);

  // Index of the first adjacent [a, b] pair in argv, or -1.
  const pairIndex = (argv: string[], a: string, b: string): number => {
    for (let i = 0; i < argv.length - 1; i++) if (argv[i] === a && argv[i + 1] === b) return i;
    return -1;
  };

  // AC-1: pixFmt unset ⇒ byte-identical to v2.46.0. The five argv lists are
  // frozen as LITERALS (not as "equals the same call without the field", which
  // would be self-fulfilling). X265_POOLS=0 is pinned by the suite beforeEach.
  describe('AC-1: pixFmt unset ⇒ token-for-token identical to v2.46.0', () => {
    const V246: Array<[string, Record<string, unknown>, string[]]> = [
      [
        'libx265 (forceIdr on)',
        { encoder: 'libx265', forceIdr: true },
        ['-c:v', 'libx265', '-preset', 'medium', '-crf', '24', '-x265-params', 'open-gop=0'],
      ],
      [
        'nvenc (forceIdr on)',
        { encoder: 'nvenc', forceIdr: true },
        [
          '-c:v',
          'hevc_nvenc',
          '-preset',
          'p5',
          '-tune',
          'hq',
          '-rc',
          'constqp',
          '-qp',
          '24',
          '-b:v',
          '0',
          '-forced-idr',
          '1',
        ],
      ],
      [
        'qsv icq-full (forceIdr on)',
        { encoder: 'qsv', qsvRateControl: 'icq-full', forceIdr: true },
        [
          '-c:v',
          'hevc_qsv',
          '-preset',
          'slow',
          '-global_quality',
          '24',
          '-low_power',
          '0',
          '-forced_idr',
          '1',
        ],
      ],
      [
        'qsv cqp (forceIdr on)',
        { encoder: 'qsv', qsvRateControl: 'cqp', forceIdr: true },
        ['-c:v', 'hevc_qsv', '-preset', 'slow', '-q:v', '24', '-forced_idr', '1'],
      ],
      [
        'vaapi (forceIdr on — emits no IDR token by design)',
        { encoder: 'vaapi', forceIdr: true },
        [
          '-vaapi_device',
          '/dev/dri/renderD128',
          '-vf',
          'format=nv12,hwupload',
          '-c:v',
          'hevc_vaapi',
          '-preset',
          'slow',
          '-rc_mode',
          'CQP',
          '-qp',
          '24',
          '-compression_level',
          '1',
        ],
      ],
    ];

    for (const [label, input, expected] of V246) {
      it(`${label}: byte-identical, and carries no -pix_fmt token`, () => {
        const argv = block(input.encoder as EncoderId, input);
        expect(argv).toEqual(expected);
        expect(argv).not.toContain('-pix_fmt');
      });
    }

    it('every encoder: omitting pixFmt equals passing undefined', () => {
      for (const enc of ENCODER_IDS) {
        expect(block(enc, { pixFmt: undefined })).toEqual(block(enc));
      }
    });
  });

  // AC-2: qsv (both ratecontrol branches) + nvenc pin, at the PRESCRIBED
  // position — exactly where tenBitArgs stands today, and always BEFORE idrArgs.
  describe('AC-2: pixFmt set ⇒ qsv + nvenc pin at the prescribed position', () => {
    it('qsv icq-full: -pix_fmt nv12 immediately after -low_power 0, before -forced_idr', () => {
      const argv = block('qsv', { qsvRateControl: 'icq-full', pixFmt: 'nv12', forceIdr: true });
      const lowPower = pairIndex(argv, '-low_power', '0');
      const pin = pairIndex(argv, '-pix_fmt', 'nv12');
      expect(lowPower).toBeGreaterThanOrEqual(0);
      expect(pin).toBe(lowPower + 2);
      expect(pin).toBeLessThan(argv.indexOf('-forced_idr'));
      expect(argv.filter((t) => t === '-pix_fmt')).toHaveLength(1);
    });

    it('qsv cqp: -pix_fmt nv12 immediately after -q:v <crf>, before -forced_idr', () => {
      const argv = block('qsv', { qsvRateControl: 'cqp', pixFmt: 'nv12', forceIdr: true });
      const qv = pairIndex(argv, '-q:v', '24');
      const pin = pairIndex(argv, '-pix_fmt', 'nv12');
      expect(qv).toBeGreaterThanOrEqual(0);
      expect(pin).toBe(qv + 2);
      expect(pin).toBeLessThan(argv.indexOf('-forced_idr'));
      expect(argv.filter((t) => t === '-pix_fmt')).toHaveLength(1);
    });

    it('nvenc: -pix_fmt nv12 immediately after -b:v 0, before -forced-idr', () => {
      const argv = block('nvenc', { pixFmt: 'nv12', forceIdr: true });
      const bv = pairIndex(argv, '-b:v', '0');
      const pin = pairIndex(argv, '-pix_fmt', 'nv12');
      expect(bv).toBeGreaterThanOrEqual(0);
      expect(pin).toBe(bv + 2);
      expect(pin).toBeLessThan(argv.indexOf('-forced-idr'));
      expect(argv.filter((t) => t === '-pix_fmt')).toHaveLength(1);
    });

    it('the pin does NOT drag a 10-bit profile in with it', () => {
      for (const input of [
        { encoder: 'qsv' as const, qsvRateControl: 'icq-full' as const, pixFmt: 'nv12' },
        { encoder: 'qsv' as const, qsvRateControl: 'cqp' as const, pixFmt: 'nv12' },
        { encoder: 'nvenc' as const, pixFmt: 'nv12' },
      ]) {
        const argv = block(input.encoder, input);
        expect(argv).not.toContain('-profile:v');
        expect(argv).not.toContain('main10');
      }
    });
  });

  // AC-3: libx265 + vaapi ignore the field ENTIRELY. Executed, not commented:
  // for both a pin would be BROKEN, not neutral — nv12 is not in libx265's
  // pix_fmts table (ffmpeg converts rgb24 there by itself), and vaapi already
  // pins the format inside its own `format=…,hwupload` chain.
  describe('AC-3: libx265 and vaapi emit nothing (D2=E-B)', () => {
    for (const enc of ['libx265', 'vaapi'] as const) {
      it(`${enc}: argv with pixFmt is token-identical to argv without`, () => {
        for (const forceIdr of [false, true]) {
          const withPin = block(enc, { pixFmt: 'nv12', forceIdr });
          const without = block(enc, { forceIdr });
          expect(withPin).toEqual(without);
          expect(withPin).not.toContain('-pix_fmt');
        }
      });
    }

    it('vaapi keeps nv12 ONLY inside its filter chain, never as a -pix_fmt token', () => {
      const argv = block('vaapi', { pixFmt: 'nv12' });
      expect(argv).toContain('format=nv12,hwupload');
      expect(argv).not.toContain('-pix_fmt');
    });
  });

  // AC-4: pixFmt × tenBit ⇒ EXACTLY ONE -pix_fmt token, and tenBit wins.
  // Two tokens would make the result depend on ffmpeg's last-one-wins ordering
  // instead of on this specification.
  describe('AC-4: pixFmt × tenBit ⇒ exactly one -pix_fmt token, tenBit wins', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['qsv icq-full', { encoder: 'qsv', qsvRateControl: 'icq-full' }],
      ['qsv cqp', { encoder: 'qsv', qsvRateControl: 'cqp' }],
      ['nvenc', { encoder: 'nvenc' }],
    ];

    for (const [label, base] of cases) {
      it(`${label}: p010le wins over nv12, and main10 is still emitted`, () => {
        const argv = block(base.encoder as EncoderId, {
          ...base,
          pixFmt: 'nv12',
          tenBit: true,
          forceIdr: true,
        });
        expect(argv.filter((t) => t === '-pix_fmt')).toHaveLength(1);
        expect(argv[argv.indexOf('-pix_fmt') + 1]).toBe('p010le');
        expect(argv).not.toContain('nv12');
        expect(pairIndex(argv, '-profile:v', 'main10')).toBeGreaterThanOrEqual(0);
      });

      it(`${label}: tenBit + pixFmt is byte-identical to tenBit alone`, () => {
        const both = block(base.encoder as EncoderId, {
          ...base,
          pixFmt: 'nv12',
          tenBit: true,
          forceIdr: true,
        });
        const tenBitOnly = block(base.encoder as EncoderId, {
          ...base,
          tenBit: true,
          forceIdr: true,
        });
        expect(both).toEqual(tenBitOnly);
      });
    }

    it('no encoder × {pixFmt, tenBit, forceIdr} combination ever emits two -pix_fmt tokens', () => {
      for (const enc of ENCODER_IDS) {
        for (const pixFmt of [undefined, 'nv12']) {
          for (const tenBit of [false, true]) {
            for (const forceIdr of [false, true]) {
              const argv = block(enc, { pixFmt, tenBit, forceIdr });
              expect(argv.filter((t) => t === '-pix_fmt').length).toBeLessThanOrEqual(1);
            }
          }
        }
      }
    });
  });
});
