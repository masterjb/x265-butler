import { describe, it, expect } from 'vitest';
import {
  buildCodecBlock,
  buildEncodeArgs,
  PROFILE_BUILDERS,
  ENCODER_IDS,
  DEFAULT_PRESET_BY_ENCODER,
  type EncoderId,
} from '@/src/lib/encode/profiles';

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

  it('test_buildCodecBlock_when_qsv_with_default_preset_then_includes_hevc_qsv_global_quality_NO_lookahead', () => {
    const block = buildCodecBlock({ encoder: 'qsv', crf: 22, preset: 'slow' });
    expect(block).toEqual(['-c:v', 'hevc_qsv', '-preset', 'slow', '-global_quality', '22']);
    // 25-02: look_ahead family removed (libvpl/oneVPL rejects MSDK-only options).
    expect(block).not.toContain('-look_ahead');
    expect(block).not.toContain('-look_ahead_depth');
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

  it('test_buildCodecBlock_when_qsv_with_veryslow_preset_then_argv_threads_veryslow_AND_global_quality_only_NO_lookahead', () => {
    // 25-02 SR1: qsv block = global_quality + preset only; look_ahead REMOVED (libvpl-compat).
    expect(buildCodecBlock({ encoder: 'qsv', crf: 22, preset: 'veryslow' })).toEqual([
      '-c:v',
      'hevc_qsv',
      '-preset',
      'veryslow',
      '-global_quality',
      '22',
    ]);
  });

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
