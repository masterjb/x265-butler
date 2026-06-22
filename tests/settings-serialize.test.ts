import { describe, it, expect } from 'vitest';
import { serializeForApi } from '@/src/lib/api/settings-serialize';

// 14-04 (Plan 14-04 Task 5): scan_root / extensions / min_size_mb / max_depth
// removed from FormValues / EditableSettings. parseExtensions helper removed
// (no consumer post-14-04). Surface that remains: encoder + concurrency + CRF +
// preset_<encoder> + min_savings_percent + output_* + general-tab fields.

describe('serializeForApi', () => {
  it('test_serializeForApi_when_partial_then_only_provided_keys', () => {
    expect(serializeForApi({ language: 'de' })).toEqual({ language: 'de' });
  });

  it('test_serializeForApi_when_full_general_tab_then_keys_serialized', () => {
    const out = serializeForApi({
      language: 'en',
      theme_override: 'dark',
      auto_enqueue_after_scan: true,
    });
    expect(out).toEqual({
      language: 'en',
      theme_override: 'dark',
      auto_enqueue_after_scan: 'true',
    });
  });
});

// 03-03 audit M2: encoder + concurrency + CRF serialization.
describe('serializeForApi — encoder + concurrency + CRF (Plan 03-03)', () => {
  it('test_serializeForApi_when_encoder_set_then_passes_through', () => {
    expect(serializeForApi({ encoder: 'nvenc' })).toEqual({ encoder: 'nvenc' });
  });

  it('test_serializeForApi_when_concurrency_set_then_passes_through', () => {
    expect(serializeForApi({ concurrency: '4' })).toEqual({ concurrency: '4' });
  });

  it('test_serializeForApi_when_crf_libx265_number_23_then_string_23', () => {
    expect(serializeForApi({ crf_libx265: 23 })).toEqual({ crf_libx265: '23' });
  });

  it('test_serializeForApi_when_crf_qsv_number_22_then_string_22', () => {
    expect(serializeForApi({ crf_qsv: 22 })).toEqual({ crf_qsv: '22' });
  });

  it('test_serializeForApi_when_only_encoder_set_then_only_encoder_in_output', () => {
    const out = serializeForApi({ encoder: 'libx265' });
    expect(out).toEqual({ encoder: 'libx265' });
    expect(out.concurrency).toBeUndefined();
    expect(out.crf_libx265).toBeUndefined();
  });

  it('test_serializeForApi_when_full_encoder_tab_dirty_then_six_keys_serialized', () => {
    const out = serializeForApi({
      encoder: 'nvenc',
      concurrency: '4',
      crf_libx265: 23,
      crf_nvenc: 23,
      crf_qsv: 20,
      crf_vaapi: 22,
    });
    expect(out).toEqual({
      encoder: 'nvenc',
      concurrency: '4',
      crf_libx265: '23',
      crf_nvenc: '23',
      crf_qsv: '20',
      crf_vaapi: '22',
    });
  });
});

// 12-03: per-encoder preset_<encoder> serialization (form-string → API-string
// passthrough; zod enum-narrows at app/api/settings/route.ts not here, per
// audit M1 — settings-serialize is type-pass-through only).
describe('serializeForApi — per-encoder preset (Plan 12-03)', () => {
  it('test_serializeForApi_when_preset_libx265_slow_then_passes_through_string', () => {
    expect(serializeForApi({ preset_libx265: 'slow' })).toEqual({ preset_libx265: 'slow' });
  });

  it('test_serializeForApi_when_preset_nvenc_p7_then_passes_through_string', () => {
    expect(serializeForApi({ preset_nvenc: 'p7' })).toEqual({ preset_nvenc: 'p7' });
  });

  it('test_serializeForApi_when_preset_qsv_veryslow_then_passes_through_string', () => {
    expect(serializeForApi({ preset_qsv: 'veryslow' })).toEqual({ preset_qsv: 'veryslow' });
  });

  it('test_serializeForApi_when_preset_vaapi_fast_then_passes_through_string', () => {
    expect(serializeForApi({ preset_vaapi: 'fast' })).toEqual({ preset_vaapi: 'fast' });
  });

  it('test_serializeForApi_when_all_four_presets_dirty_then_four_keys_serialized', () => {
    expect(
      serializeForApi({
        preset_libx265: 'slow',
        preset_nvenc: 'p7',
        preset_qsv: 'veryslow',
        preset_vaapi: 'fast',
      }),
    ).toEqual({
      preset_libx265: 'slow',
      preset_nvenc: 'p7',
      preset_qsv: 'veryslow',
      preset_vaapi: 'fast',
    });
  });

  it('test_serializeForApi_when_preset_AND_crf_for_same_encoder_then_both_serialized', () => {
    expect(serializeForApi({ crf_libx265: 21, preset_libx265: 'slow' })).toEqual({
      crf_libx265: '21',
      preset_libx265: 'slow',
    });
  });
});

// 05-13 / 05-14 / 05-15: additive scalar settings.
describe('serializeForApi — output + min_savings_percent', () => {
  it('test_serializeForApi_when_min_savings_percent_number_then_string', () => {
    expect(serializeForApi({ min_savings_percent: 12 })).toEqual({ min_savings_percent: '12' });
  });

  it('test_serializeForApi_when_output_container_match_source_then_passes_through', () => {
    expect(serializeForApi({ output_container: 'match-source' })).toEqual({
      output_container: 'match-source',
    });
  });
});

// 33-02: trash_path is a direct string passthrough (empty = auto-cache; no
// transform here — validation happens at the route zod layer).
describe('serializeForApi — trash_path (Plan 33-02)', () => {
  it('test_serializeForApi_when_trash_path_set_then_passes_through_string', () => {
    expect(serializeForApi({ trash_path: '/mnt/user/media-trash' })).toEqual({
      trash_path: '/mnt/user/media-trash',
    });
  });

  it('test_serializeForApi_when_trash_path_empty_then_passes_through_empty', () => {
    expect(serializeForApi({ trash_path: '' })).toEqual({ trash_path: '' });
  });
});

// 34-02: gpu_device is a direct string passthrough (empty = auto-first-node; the
// route zod enforces ''|/dev/dri/renderD<N> + empty-trim + invalidate-on-change).
describe('serializeForApi — gpu_device (Plan 34-02)', () => {
  it('test_serializeForApi_when_gpu_device_node_then_passes_through_full_path', () => {
    expect(serializeForApi({ gpu_device: '/dev/dri/renderD129' })).toEqual({
      gpu_device: '/dev/dri/renderD129',
    });
  });

  it('test_serializeForApi_when_gpu_device_empty_then_passes_through_empty', () => {
    expect(serializeForApi({ gpu_device: '' })).toEqual({ gpu_device: '' });
  });

  it('test_serializeForApi_when_gpu_device_absent_then_not_in_output', () => {
    const out = serializeForApi({ encoder: 'qsv' });
    expect(out.gpu_device).toBeUndefined();
  });
});

// 35-02: auto_crop bool → 'true'/'false'; crop_override direct string passthrough
// (empty = auto/none). Mirrors delete_original_after_encode + trash_path idioms.
describe('serializeForApi — auto_crop + crop_override (Plan 35-02)', () => {
  it('test_serializeForApi_when_auto_crop_true_then_string_true', () => {
    expect(serializeForApi({ auto_crop: true })).toEqual({ auto_crop: 'true' });
  });

  it('test_serializeForApi_when_auto_crop_false_then_string_false', () => {
    expect(serializeForApi({ auto_crop: false })).toEqual({ auto_crop: 'false' });
  });

  it('test_serializeForApi_when_crop_override_set_then_passes_through_string', () => {
    expect(serializeForApi({ crop_override: '1920:800:0:140' })).toEqual({
      crop_override: '1920:800:0:140',
    });
  });

  it('test_serializeForApi_when_crop_override_empty_then_passes_through_empty', () => {
    expect(serializeForApi({ crop_override: '' })).toEqual({ crop_override: '' });
  });

  it('test_serializeForApi_when_crop_keys_absent_then_not_in_output', () => {
    const out = serializeForApi({ encoder: 'qsv' });
    expect(out.auto_crop).toBeUndefined();
    expect(out.crop_override).toBeUndefined();
  });
});
