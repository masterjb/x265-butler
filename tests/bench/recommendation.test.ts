// 12-01: Pure-helper unit tests for selectRecommendationsByEncoder.
// ZERO DB initialization — purity invariant tests run in microseconds.

import { describe, it, expect } from 'vitest';
import { selectRecommendationsByEncoder } from '@/src/lib/bench/recommendation';
import type { BenchComboRow } from '@/src/lib/db/schema';

function makeCombo(overrides: Partial<BenchComboRow> = {}): BenchComboRow {
  return {
    id: 1,
    run_id: 1,
    file_id: 1,
    encoder: 'libx265',
    preset: 'medium',
    native_quality_param: '-crf',
    native_quality_value: 22,
    vmaf_target: null,
    sample_idx: 0,
    vmaf: 92,
    size_bytes: 1000,
    encode_seconds: 1,
    source_sample_bytes: 2000,
    pass2_vmaf: null,
    pass2_size_bytes: null,
    pass2_encode_seconds: null,
    pass2_completed_at: null,
    status: 'complete',
    error_reason: null,
    is_pareto: 1,
    top3_role: 'quality',
    created_at: 1000,
    completed_at: 1001,
    ...overrides,
  };
}

describe('selectRecommendationsByEncoder — empty + happy paths', () => {
  it('empty array → empty recommendations, empty unknown, empty divergences', () => {
    expect(selectRecommendationsByEncoder([])).toEqual({
      recommendations: {},
      unknownEncoders: [],
      divergences: [],
    });
  });

  it('single libx265 quality combo → recommendation populated, divergences empty', () => {
    const result = selectRecommendationsByEncoder([
      makeCombo({ encoder: 'libx265', native_quality_value: 22, preset: 'medium' }),
    ]);
    expect(result.recommendations).toEqual({ libx265: { crf: 22, preset: 'medium' } });
    expect(result.unknownEncoders).toEqual([]);
    expect(result.divergences).toEqual([]);
  });

  it('all 4 encoders with quality picks → 4 recommendations, divergences empty', () => {
    const result = selectRecommendationsByEncoder([
      makeCombo({ encoder: 'libx265', native_quality_value: 22, preset: 'medium' }),
      makeCombo({ encoder: 'nvenc', native_quality_value: 25, preset: 'p5', id: 2 }),
      makeCombo({ encoder: 'qsv', native_quality_value: 24, preset: 'medium', id: 3 }),
      makeCombo({ encoder: 'vaapi', native_quality_value: 23, preset: null, id: 4 }),
    ]);
    expect(result.recommendations).toEqual({
      libx265: { crf: 22, preset: 'medium' },
      nvenc: { crf: 25, preset: 'p5' },
      qsv: { crf: 24, preset: 'medium' },
      vaapi: { crf: 23, preset: null },
    });
    expect(result.unknownEncoders).toEqual([]);
    expect(result.divergences).toEqual([]);
  });
});

describe('selectRecommendationsByEncoder — role filtering', () => {
  it("filters non-'quality' roles (balanced / size / null)", () => {
    const result = selectRecommendationsByEncoder([
      makeCombo({ encoder: 'libx265', top3_role: 'balanced' }),
      makeCombo({ encoder: 'nvenc', top3_role: 'size', id: 2 }),
      makeCombo({ encoder: 'qsv', top3_role: null, id: 3 }),
    ]);
    expect(result.recommendations).toEqual({});
    expect(result.unknownEncoders).toEqual([]);
    expect(result.divergences).toEqual([]);
  });

  it('mixed roles → only quality picked', () => {
    const result = selectRecommendationsByEncoder([
      makeCombo({ encoder: 'libx265', top3_role: 'balanced', native_quality_value: 99 }),
      makeCombo({ encoder: 'libx265', top3_role: 'quality', native_quality_value: 22, id: 2 }),
      makeCombo({ encoder: 'libx265', top3_role: 'size', native_quality_value: 1, id: 3 }),
    ]);
    expect(result.recommendations).toEqual({ libx265: { crf: 22, preset: 'medium' } });
  });
});

describe('selectRecommendationsByEncoder — unknown encoders (AV1 forward-compat)', () => {
  it("unknown encoder 'av1' → present in unknownEncoders, absent from recommendations", () => {
    const result = selectRecommendationsByEncoder([
      makeCombo({ encoder: 'av1' }),
      makeCombo({ encoder: 'libx265', id: 2 }),
    ]);
    expect(result.recommendations).toEqual({ libx265: { crf: 22, preset: 'medium' } });
    expect(result.unknownEncoders).toEqual(['av1']);
    expect(result.divergences).toEqual([]);
  });

  it('multiple unknown encoders → deduplicated in unknownEncoders', () => {
    const result = selectRecommendationsByEncoder([
      makeCombo({ encoder: 'av1' }),
      makeCombo({ encoder: 'av1', id: 2 }),
      makeCombo({ encoder: 'vp9', id: 3 }),
      makeCombo({ encoder: 'av1', id: 4 }),
    ]);
    expect(result.recommendations).toEqual({});
    expect(result.unknownEncoders.sort()).toEqual(['av1', 'vp9']);
  });
});

describe('selectRecommendationsByEncoder — P11-invariant duplicate handling (audit SR2)', () => {
  it('identical (crf, preset) duplicates for same encoder → first wins, divergences EMPTY', () => {
    const result = selectRecommendationsByEncoder([
      makeCombo({ encoder: 'libx265', native_quality_value: 22, preset: 'medium', id: 1 }),
      makeCombo({ encoder: 'libx265', native_quality_value: 22, preset: 'medium', id: 2 }),
      makeCombo({ encoder: 'libx265', native_quality_value: 22, preset: 'medium', id: 3 }),
      makeCombo({ encoder: 'libx265', native_quality_value: 22, preset: 'medium', id: 4 }),
      makeCombo({ encoder: 'libx265', native_quality_value: 22, preset: 'medium', id: 5 }),
      makeCombo({ encoder: 'libx265', native_quality_value: 22, preset: 'medium', id: 6 }),
    ]);
    expect(result.recommendations).toEqual({ libx265: { crf: 22, preset: 'medium' } });
    expect(result.divergences).toEqual([]);
  });

  it('differing crf → first wins, divergence sentinel emitted', () => {
    const result = selectRecommendationsByEncoder([
      makeCombo({ encoder: 'libx265', native_quality_value: 22, preset: 'medium', id: 1 }),
      makeCombo({ encoder: 'libx265', native_quality_value: 24, preset: 'medium', id: 2 }),
    ]);
    expect(result.recommendations).toEqual({ libx265: { crf: 22, preset: 'medium' } });
    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]).toEqual({
      encoder: 'libx265',
      picked: { crf: 22, preset: 'medium' },
      conflict: { crf: 24, preset: 'medium' },
    });
  });

  it('differing preset → first wins, divergence sentinel emitted', () => {
    const result = selectRecommendationsByEncoder([
      makeCombo({ encoder: 'libx265', native_quality_value: 22, preset: 'medium', id: 1 }),
      makeCombo({ encoder: 'libx265', native_quality_value: 22, preset: 'slow', id: 2 }),
    ]);
    expect(result.recommendations).toEqual({ libx265: { crf: 22, preset: 'medium' } });
    expect(result.divergences).toHaveLength(1);
    expect(result.divergences[0]).toEqual({
      encoder: 'libx265',
      picked: { crf: 22, preset: 'medium' },
      conflict: { crf: 22, preset: 'slow' },
    });
  });

  it('multiple divergences across encoders → all emitted', () => {
    const result = selectRecommendationsByEncoder([
      makeCombo({ encoder: 'libx265', native_quality_value: 22, preset: 'medium', id: 1 }),
      makeCombo({ encoder: 'libx265', native_quality_value: 24, preset: 'medium', id: 2 }),
      makeCombo({ encoder: 'nvenc', native_quality_value: 25, preset: 'p5', id: 3 }),
      makeCombo({ encoder: 'nvenc', native_quality_value: 26, preset: 'p5', id: 4 }),
    ]);
    expect(result.recommendations).toEqual({
      libx265: { crf: 22, preset: 'medium' },
      nvenc: { crf: 25, preset: 'p5' },
    });
    expect(result.divergences).toHaveLength(2);
  });
});

describe('selectRecommendationsByEncoder — VAAPI null-preset case', () => {
  it('vaapi quality combo with preset=null → recommendation preset is null', () => {
    const result = selectRecommendationsByEncoder([
      makeCombo({ encoder: 'vaapi', native_quality_value: 23, preset: null }),
    ]);
    expect(result.recommendations).toEqual({ vaapi: { crf: 23, preset: null } });
  });
});

// 12-04: mode parameterization + empty-mode-result branch (audit M2)
describe('selectRecommendationsByEncoder — 12-04 mode parameter', () => {
  it('default mode (no arg) preserves 12-01 byte-identical quality filter (AC-1)', () => {
    const combos = [
      makeCombo({ encoder: 'libx265', top3_role: 'balanced', native_quality_value: 99, id: 1 }),
      makeCombo({ encoder: 'libx265', top3_role: 'quality', native_quality_value: 22, id: 2 }),
      makeCombo({ encoder: 'libx265', top3_role: 'size', native_quality_value: 1, id: 3 }),
    ];
    const result = selectRecommendationsByEncoder(combos);
    expect(result.recommendations).toEqual({ libx265: { crf: 22, preset: 'medium' } });
  });

  it("mode='balanced' filters top3_role='balanced' (AC-2)", () => {
    const combos = [
      makeCombo({ encoder: 'libx265', top3_role: 'quality', native_quality_value: 22, id: 1 }),
      makeCombo({ encoder: 'libx265', top3_role: 'balanced', native_quality_value: 26, id: 2 }),
      makeCombo({ encoder: 'libx265', top3_role: 'size', native_quality_value: 30, id: 3 }),
    ];
    const result = selectRecommendationsByEncoder(combos, 'balanced');
    expect(result.recommendations).toEqual({ libx265: { crf: 26, preset: 'medium' } });
  });

  it("mode='size' filters top3_role='size' (AC-3)", () => {
    const combos = [
      makeCombo({ encoder: 'libx265', top3_role: 'quality', native_quality_value: 20, id: 1 }),
      makeCombo({ encoder: 'libx265', top3_role: 'balanced', native_quality_value: 24, id: 2 }),
      makeCombo({ encoder: 'libx265', top3_role: 'size', native_quality_value: 28, id: 3 }),
    ];
    const result = selectRecommendationsByEncoder(combos, 'size');
    expect(result.recommendations).toEqual({ libx265: { crf: 28, preset: 'medium' } });
  });

  it('empty-mode-result: no combo with role → recommendations={} (AC-2/AC-3 audit M2)', () => {
    // Pareto-collapse last-write-wins overwrote 'balanced' tags.
    const combos = [
      makeCombo({ encoder: 'libx265', top3_role: 'quality', id: 1 }),
      makeCombo({ encoder: 'libx265', top3_role: 'size', id: 2 }),
    ];
    const result = selectRecommendationsByEncoder(combos, 'balanced');
    expect(result.recommendations).toEqual({});
    expect(result.unknownEncoders).toEqual([]);
    expect(result.divergences).toEqual([]);
  });
});
