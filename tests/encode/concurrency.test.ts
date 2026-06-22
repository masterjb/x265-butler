import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computePerEncoderLimits, type LimitsInput } from '@/src/lib/encode/concurrency';

let warnSpy: ReturnType<typeof vi.fn>;

function makeLogger(): LimitsInput['logger'] {
  warnSpy = vi.fn();
  return { warn: warnSpy };
}

beforeEach(() => {
  warnSpy = vi.fn();
});

describe('computePerEncoderLimits — auto resolution', () => {
  it('test_computePerEncoderLimits_when_auto_and_cpu_8_then_libx265_2_hw_1', () => {
    const r = computePerEncoderLimits({ concurrency: 'auto', cpuCount: 8 });
    expect(r).toEqual({ libx265: 2, nvenc: 1, qsv: 1, vaapi: 1 });
  });

  it('test_computePerEncoderLimits_when_auto_and_cpu_32_then_libx265_clamped_to_8', () => {
    const r = computePerEncoderLimits({ concurrency: 'auto', cpuCount: 32 });
    expect(r.libx265).toBe(8);
  });

  it('test_computePerEncoderLimits_when_auto_and_cpu_1_then_libx265_floor_1', () => {
    const r = computePerEncoderLimits({ concurrency: 'auto', cpuCount: 1 });
    expect(r.libx265).toBe(1);
  });

  it('test_computePerEncoderLimits_when_auto_and_cpu_4_then_libx265_1_hw_1', () => {
    const r = computePerEncoderLimits({ concurrency: 'auto', cpuCount: 4 });
    expect(r).toEqual({ libx265: 1, nvenc: 1, qsv: 1, vaapi: 1 });
  });

  it('test_computePerEncoderLimits_when_concurrency_undefined_then_treated_as_auto', () => {
    const r = computePerEncoderLimits({ concurrency: undefined, cpuCount: 16 });
    expect(r).toEqual({ libx265: 4, nvenc: 1, qsv: 1, vaapi: 1 });
  });
});

describe('computePerEncoderLimits — operator override (universal N)', () => {
  it('test_computePerEncoderLimits_when_override_4_then_all_encoders_get_4', () => {
    const r = computePerEncoderLimits({ concurrency: '4', cpuCount: 8 });
    expect(r).toEqual({ libx265: 4, nvenc: 4, qsv: 4, vaapi: 4 });
  });

  it('test_computePerEncoderLimits_when_override_1_then_all_encoders_get_1', () => {
    const r = computePerEncoderLimits({ concurrency: '1', cpuCount: 16 });
    expect(r).toEqual({ libx265: 1, nvenc: 1, qsv: 1, vaapi: 1 });
  });

  it('test_computePerEncoderLimits_when_override_higher_than_auto_then_override_wins', () => {
    // cpu=8 → auto libx265=2, but override=6 should win
    const r = computePerEncoderLimits({ concurrency: '6', cpuCount: 8 });
    expect(r.libx265).toBe(6);
    expect(r.nvenc).toBe(6);
  });
});

describe('computePerEncoderLimits — invalid value falls back to auto + warns', () => {
  it('test_computePerEncoderLimits_when_zero_then_falls_back_to_auto_with_warn', () => {
    const logger = makeLogger();
    const r = computePerEncoderLimits({ concurrency: '0', cpuCount: 8, logger });
    expect(r).toEqual({ libx265: 2, nvenc: 1, qsv: 1, vaapi: 1 });
    expect(warnSpy).toHaveBeenCalled();
    const [payload] = warnSpy.mock.calls[0] as [Record<string, unknown>];
    expect(payload.action).toBe('concurrency_setting_invalid');
    expect(payload.value).toBe('0');
    expect(payload.fallback).toBe('auto');
  });

  it('test_computePerEncoderLimits_when_negative_then_falls_back_to_auto_with_warn', () => {
    const logger = makeLogger();
    const r = computePerEncoderLimits({ concurrency: '-3', cpuCount: 8, logger });
    expect(r.libx265).toBe(2);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('test_computePerEncoderLimits_when_gibberish_then_falls_back_to_auto_with_warn', () => {
    const logger = makeLogger();
    const r = computePerEncoderLimits({ concurrency: 'gibberish', cpuCount: 8, logger });
    expect(r.libx265).toBe(2);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('test_computePerEncoderLimits_when_decimal_then_falls_back_to_auto_with_warn', () => {
    const logger = makeLogger();
    const r = computePerEncoderLimits({ concurrency: '2.5', cpuCount: 8, logger });
    expect(r.libx265).toBe(2);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('test_computePerEncoderLimits_when_warn_emitted_then_log_payload_has_correct_action_and_value', () => {
    const logger = makeLogger();
    computePerEncoderLimits({ concurrency: 'bad', cpuCount: 4, logger });
    const [payload, msg] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(payload).toMatchObject({
      action: 'concurrency_setting_invalid',
      value: 'bad',
      fallback: 'auto',
    });
    expect(msg).toMatch(/invalid settings.concurrency/);
  });

  it('test_computePerEncoderLimits_when_invalid_without_logger_then_no_throw', () => {
    expect(() => computePerEncoderLimits({ concurrency: 'bad', cpuCount: 4 })).not.toThrow();
  });
});

describe('computePerEncoderLimits — defensive cpuCount clamp (audit S4)', () => {
  it('test_computePerEncoderLimits_when_cpuCount_zero_then_libx265_floor_1', () => {
    // Constrained environments return os.cpus().length === 0
    const r = computePerEncoderLimits({ concurrency: 'auto', cpuCount: 0 });
    expect(r.libx265).toBe(1);
  });

  it('test_computePerEncoderLimits_when_cpuCount_negative_then_libx265_floor_1', () => {
    const r = computePerEncoderLimits({ concurrency: 'auto', cpuCount: -5 });
    expect(r.libx265).toBe(1);
  });

  it('test_computePerEncoderLimits_when_cpuCount_NaN_then_libx265_floor_1', () => {
    const r = computePerEncoderLimits({ concurrency: 'auto', cpuCount: Number.NaN });
    expect(r.libx265).toBe(1);
  });
});
