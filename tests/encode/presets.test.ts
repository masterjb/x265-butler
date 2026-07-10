import { describe, it, expect } from 'vitest';
import { PRESETS_BY_ENCODER, isValidPreset } from '@/src/lib/encode/presets';
import { ENCODER_IDS } from '@/src/lib/encode/profiles';

describe('PRESETS_BY_ENCODER structural equality', () => {
  it('libx265: 10 presets in spec order', () => {
    expect([...PRESETS_BY_ENCODER.libx265]).toEqual([
      'ultrafast',
      'superfast',
      'veryfast',
      'faster',
      'fast',
      'medium',
      'slow',
      'slower',
      'veryslow',
      'placebo',
    ]);
  });

  it('nvenc: p1–p7 in order', () => {
    expect([...PRESETS_BY_ENCODER.nvenc]).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
  });

  it('qsv: 7 presets matching QSV speed tiers', () => {
    expect([...PRESETS_BY_ENCODER.qsv]).toEqual([
      'veryfast',
      'faster',
      'fast',
      'medium',
      'slow',
      'slower',
      'veryslow',
    ]);
  });

  it('vaapi: 3 generic speed tiers', () => {
    expect([...PRESETS_BY_ENCODER.vaapi]).toEqual(['fast', 'medium', 'slow']);
  });
});

describe('PRESETS_BY_ENCODER invariants', () => {
  it('outer object is frozen', () => {
    expect(Object.isFrozen(PRESETS_BY_ENCODER)).toBe(true);
  });

  it('each encoder array is frozen', () => {
    for (const key of ENCODER_IDS) {
      expect(Object.isFrozen(PRESETS_BY_ENCODER[key])).toBe(true);
    }
  });

  it('no duplicate presets within any encoder', () => {
    for (const key of ENCODER_IDS) {
      const arr = PRESETS_BY_ENCODER[key];
      expect(new Set(arr).size).toBe(arr.length);
    }
  });

  it('encoder key set matches ENCODER_IDS exactly', () => {
    expect(new Set(Object.keys(PRESETS_BY_ENCODER))).toEqual(new Set(ENCODER_IDS));
  });
});

describe('isValidPreset', () => {
  it('returns true for known libx265 preset', () => {
    expect(isValidPreset('libx265', 'medium')).toBe(true);
  });

  it('returns true for known nvenc preset', () => {
    expect(isValidPreset('nvenc', 'p5')).toBe(true);
  });

  it('returns false for preset from wrong encoder', () => {
    expect(isValidPreset('nvenc', 'medium')).toBe(false);
  });

  it('returns false for unknown string', () => {
    expect(isValidPreset('libx265', 'turbo')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isValidPreset('qsv', '')).toBe(false);
  });
});

describe('regression guard — default profile presets exist in catalog', () => {
  it("libx265 default 'medium' in catalog", () => {
    expect(PRESETS_BY_ENCODER.libx265.includes('medium')).toBe(true);
  });

  it("nvenc default 'p5' in catalog", () => {
    expect(PRESETS_BY_ENCODER.nvenc.includes('p5')).toBe(true);
  });

  it("qsv default 'slow' in catalog", () => {
    expect(PRESETS_BY_ENCODER.qsv.includes('slow')).toBe(true);
  });

  it("vaapi has 'fast' in catalog", () => {
    expect(PRESETS_BY_ENCODER.vaapi.includes('fast')).toBe(true);
  });
});
