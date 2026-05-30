// Phase 13 Plan 13-04 Task 1 — savings-estimator pure-function tests.
//
// Covers AC-5 (bench-augmented), AC-6 (naive-fallback), AC-7 (encodeTime
// derivation + SR3 partial-duration scaling). 12 cases — audit-uplifted
// from 10 for SR3 (cases 11+12).

import { describe, it, expect } from 'vitest';
import {
  estimateSavings,
  NAIVE_RATIO_BY_ENCODER,
  NAIVE_FPS_BY_ENCODER,
  type BenchAugmentedInput,
} from '@/src/lib/scan/savings-estimator';

const HOUR = 3600;

describe('estimateSavings (13-04 T1)', () => {
  it('bench-augmented happy-path: ratio=0.5 + 2 files 1GB+2GB → projectedBytes=1.5GB', () => {
    const benchData: BenchAugmentedInput = { runId: 42, ratio: 0.5, encodeFpsRatio: 2.0 };
    const result = estimateSavings({
      eligibleFileSizes: [1_000_000_000, 2_000_000_000],
      eligibleFileDurations: [HOUR, 2 * HOUR],
      encoder: 'libx265',
      benchData,
    });
    expect(result.savings.totalBytes).toBe(3_000_000_000);
    expect(result.savings.ratio).toBe(0.5);
    expect(result.savings.projectedBytes).toBe(1_500_000_000);
    expect(result.savings.source).toBe('bench-augmented');
    expect(result.savings.runId).toBe(42);
  });

  it('naive-fallback libx265 + 3 files → ratio=0.45 used', () => {
    const result = estimateSavings({
      eligibleFileSizes: [1_000_000_000, 2_000_000_000, 3_000_000_000],
      eligibleFileDurations: [HOUR, HOUR, HOUR],
      encoder: 'libx265',
      benchData: null,
    });
    expect(result.savings.ratio).toBe(NAIVE_RATIO_BY_ENCODER.libx265);
    expect(result.savings.ratio).toBe(0.45);
    expect(result.savings.projectedBytes).toBe(Math.round(6_000_000_000 * 0.45));
    expect(result.savings.source).toBe('naive');
  });

  it('encoder-routing nvenc → NAIVE_FPS=3.0 used in encodeTime denominator', () => {
    const result = estimateSavings({
      eligibleFileSizes: [1_000_000_000],
      eligibleFileDurations: [HOUR],
      encoder: 'nvenc',
      benchData: null,
    });
    // 3600s @ 3.0× realtime = 1200s, scaleFactor=1 (full coverage)
    expect(NAIVE_FPS_BY_ENCODER.nvenc).toBe(3.0);
    expect(result.encodeTime.seconds).toBe(1200);
    expect(result.encodeTime.scaleFactor).toBe(1);
  });

  it('empty eligibleFiles → totalBytes=0, projectedBytes=0, encodeTime.seconds=0', () => {
    const result = estimateSavings({
      eligibleFileSizes: [],
      eligibleFileDurations: [],
      encoder: 'libx265',
      benchData: null,
    });
    expect(result.savings.totalBytes).toBe(0);
    expect(result.savings.projectedBytes).toBe(0);
    expect(result.encodeTime.seconds).toBe(0);
    expect(result.encodeTime.scaleFactor).toBe(0);
    expect(result.encodeTime.eligibleCount).toBe(0);
    expect(result.encodeTime.withDurationCount).toBe(0);
  });

  it('null-durations only → encodeTime.seconds=0 (no probe data)', () => {
    const result = estimateSavings({
      eligibleFileSizes: [1_000_000_000, 2_000_000_000],
      eligibleFileDurations: [null, null],
      encoder: 'libx265',
      benchData: null,
    });
    // No valid durations → cannot estimate time, but savings still computable from sizes.
    expect(result.savings.projectedBytes).toBeGreaterThan(0);
    expect(result.encodeTime.seconds).toBe(0);
    expect(result.encodeTime.withDurationCount).toBe(0);
    expect(result.encodeTime.scaleFactor).toBe(0);
  });

  it('mixed null+valid durations → uses only valid AND scales up via SR3 factor', () => {
    // 4 eligible files, 2 with-duration → scaleFactor = 4/2 = 2
    const result = estimateSavings({
      eligibleFileSizes: [1_000_000_000, 1_000_000_000, 1_000_000_000, 1_000_000_000],
      eligibleFileDurations: [HOUR, HOUR, null, null],
      encoder: 'libx265',
      benchData: null,
    });
    expect(result.encodeTime.eligibleCount).toBe(4);
    expect(result.encodeTime.withDurationCount).toBe(2);
    expect(result.encodeTime.scaleFactor).toBe(2);
    // rawSeconds = 2*HOUR / 0.8 = 9000s; scaled = 18000s
    expect(result.encodeTime.seconds).toBe(18000);
  });

  it('source-runId consistency (bench → runId set; naive → null)', () => {
    const bench = estimateSavings({
      eligibleFileSizes: [1000],
      eligibleFileDurations: [60],
      encoder: 'libx265',
      benchData: { runId: 7, ratio: 0.5, encodeFpsRatio: 1 },
    });
    const naive = estimateSavings({
      eligibleFileSizes: [1000],
      eligibleFileDurations: [60],
      encoder: 'libx265',
      benchData: null,
    });
    expect(bench.savings.runId).toBe(7);
    expect(bench.encodeTime.runId).toBe(7);
    expect(naive.savings.runId).toBeNull();
    expect(naive.encodeTime.runId).toBeNull();
  });

  it('encodeTime.source matches savings.source (consistency invariant)', () => {
    const bench = estimateSavings({
      eligibleFileSizes: [1000],
      eligibleFileDurations: [60],
      encoder: 'qsv',
      benchData: { runId: 1, ratio: 0.5, encodeFpsRatio: 1 },
    });
    const naive = estimateSavings({
      eligibleFileSizes: [1000],
      eligibleFileDurations: [60],
      encoder: 'qsv',
      benchData: null,
    });
    expect(bench.savings.source).toBe(bench.encodeTime.source);
    expect(naive.savings.source).toBe(naive.encodeTime.source);
    expect(bench.encodeTime.source).toBe('bench-augmented');
    expect(naive.encodeTime.source).toBe('naive');
  });

  it('ratio=0 edge → projectedBytes=0 (no savings)', () => {
    const result = estimateSavings({
      eligibleFileSizes: [1_000_000_000],
      eligibleFileDurations: [HOUR],
      encoder: 'libx265',
      benchData: { runId: 1, ratio: 0, encodeFpsRatio: 1 },
    });
    expect(result.savings.projectedBytes).toBe(0);
    expect(result.savings.ratio).toBe(0);
  });

  it('ratio>1 edge (allowed, signals worse output) → projectedBytes > totalBytes (NOT clamped)', () => {
    // Per src/lib/format/savings.ts SR4 — operator must see catastrophic results honestly.
    const result = estimateSavings({
      eligibleFileSizes: [1_000_000_000],
      eligibleFileDurations: [HOUR],
      encoder: 'libx265',
      benchData: { runId: 1, ratio: 1.5, encodeFpsRatio: 1 },
    });
    expect(result.savings.projectedBytes).toBe(1_500_000_000);
    expect(result.savings.projectedBytes).toBeGreaterThan(result.savings.totalBytes);
  });

  // SR3 — case A: 4 eligible / 2 with-duration → scaleFactor=2 + scaledSeconds = rawSeconds × 2.
  it('SR3 case A: partial-duration scaling factor = eligible/withDuration', () => {
    const result = estimateSavings({
      eligibleFileSizes: [1000, 1000, 1000, 1000],
      eligibleFileDurations: [600, 600, null, null],
      encoder: 'nvenc', // 3.0× realtime
      benchData: null,
    });
    // rawSeconds = (600+600) / 3.0 = 400s; scaleFactor = 4/2 = 2; scaled = 800s
    expect(result.encodeTime.scaleFactor).toBe(2);
    expect(result.encodeTime.seconds).toBe(800);
    expect(result.encodeTime.eligibleCount).toBe(4);
    expect(result.encodeTime.withDurationCount).toBe(2);
  });

  // SR3 — case B: full-coverage → scaleFactor=1, identical to pre-SR3 (no regression).
  it('SR3 case B: all eligible have duration → scaleFactor=1, no scaling', () => {
    const result = estimateSavings({
      eligibleFileSizes: [1000, 1000, 1000],
      eligibleFileDurations: [600, 600, 600],
      encoder: 'nvenc',
      benchData: null,
    });
    // rawSeconds = 1800 / 3.0 = 600s; scaleFactor = 3/3 = 1; scaled = 600s
    expect(result.encodeTime.scaleFactor).toBe(1);
    expect(result.encodeTime.seconds).toBe(600);
    expect(result.encodeTime.withDurationCount).toBe(3);
  });
});
