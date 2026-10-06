// validateBenchMatrix (shared by route and form).

import { describe, it, expect } from 'vitest';
import { validateBenchMatrix } from '@/src/lib/bench/matrix-validate';

const nvenc = { encoders: ['hevc_nvenc'], presets: ['p5'] };
const x265 = { encoders: ['libx265'], presets: ['medium'] };

describe('validateBenchMatrix — encoders and presets', () => {
  it('test_validate_when_no_encoder_then_encoder_required', () => {
    expect(
      validateBenchMatrix('native-sweep', {
        encoders: [],
        presets: ['medium'],
        nativeValues: [20],
      }),
    ).toEqual({
      ok: false,
      error: 'encoder_required',
    });
  });

  it('test_validate_when_unknown_encoder_then_encoder_unknown', () => {
    expect(
      validateBenchMatrix('native-sweep', {
        encoders: ['h264_foo'],
        presets: ['medium'],
        nativeValues: [20],
      }),
    ).toEqual({ ok: false, error: 'encoder_unknown', encoders: ['h264_foo'] });
  });

  it('test_validate_when_nvenc_with_only_x265_presets_then_preset_missing', () => {
    expect(
      validateBenchMatrix('native-sweep', {
        encoders: ['hevc_nvenc'],
        presets: ['veryfast', 'slower'],
        nativeValues: [20],
      }),
    ).toEqual({ ok: false, error: 'preset_missing_for_encoder', encoders: ['hevc_nvenc'] });
  });

  it('test_validate_when_one_of_two_encoders_lacks_preset_then_names_only_that_one', () => {
    expect(
      validateBenchMatrix('native-sweep', {
        encoders: ['libx265', 'hevc_nvenc'],
        presets: ['medium'],
        nativeValues: [20],
      }),
    ).toEqual({ ok: false, error: 'preset_missing_for_encoder', encoders: ['hevc_nvenc'] });
  });

  it('test_validate_when_mixed_presets_cover_both_encoders_then_ok', () => {
    expect(
      validateBenchMatrix('native-sweep', {
        encoders: ['libx265', 'hevc_nvenc'],
        presets: ['medium', 'p5'],
        nativeValues: [20],
      }),
    ).toEqual({ ok: true });
  });
});

describe('validateBenchMatrix — VMAF targets (vmaf-anchored)', () => {
  it.each([50, 90, 95, 100])('test_validate_when_vmaf_target_%s_then_ok', (v) => {
    expect(validateBenchMatrix('vmaf-anchored', { ...nvenc, vmafTargets: [v] })).toEqual({
      ok: true,
    });
  });

  it.each([49.9, 100.1, 15, -1])('test_validate_when_vmaf_target_%s_then_out_of_range', (v) => {
    expect(validateBenchMatrix('vmaf-anchored', { ...nvenc, vmafTargets: [v] })).toEqual({
      ok: false,
      error: 'vmaf_target_out_of_range',
      values: [v],
    });
  });

  it('test_validate_when_vmaf_targets_empty_then_values_required', () => {
    expect(validateBenchMatrix('vmaf-anchored', { ...nvenc, vmafTargets: [] })).toEqual({
      ok: false,
      error: 'values_required',
    });
  });

  it('test_validate_when_vmaf_target_not_number_then_out_of_range', () => {
    expect(validateBenchMatrix('vmaf-anchored', { ...nvenc, vmafTargets: ['95'] })).toMatchObject({
      ok: false,
      error: 'vmaf_target_out_of_range',
    });
  });
});

describe('validateBenchMatrix — native values (native-sweep)', () => {
  it.each([0, 20, 51])('test_validate_when_native_value_%s_then_ok', (v) => {
    expect(validateBenchMatrix('native-sweep', { ...x265, nativeValues: [v] })).toEqual({
      ok: true,
    });
  });

  it.each([-1, 52, 22.5])('test_validate_when_native_value_%s_then_out_of_range', (v) => {
    expect(validateBenchMatrix('native-sweep', { ...x265, nativeValues: [v] })).toEqual({
      ok: false,
      error: 'native_value_out_of_range',
      values: [v],
    });
  });

  it('test_validate_when_native_values_missing_then_values_required', () => {
    expect(validateBenchMatrix('native-sweep', { ...x265 })).toEqual({
      ok: false,
      error: 'values_required',
    });
  });
});
