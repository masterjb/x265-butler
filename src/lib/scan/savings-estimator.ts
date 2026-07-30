// Phase 13 Plan 13-04 Task 1 — savings-estimator pure helper.
//
// Bench-augmented per-encoder savings ratio + estimated encode time, with
// naive-fallback when no complete bench_run exists. Pure module: NO I/O,
// NO logger, NO DB. Consumed by estimate-engine.ts which feeds it derived
// inputs (eligible-file sizes/durations + bench-derived BenchAugmentedInput
// or null).
//
// Audit notes:
//   SR3 — partial-duration scaling. When ffprobe fails on M of N eligible
//         files, naive Σ(validDurations)/encodeFpsRatio understates the
//         total. Scale by eligibleCount / withDurationCount and expose
//         scaleFactor for UI transparency ("based on N/M sampled").
//
// Ratio semantics match src/lib/format/savings.ts:21 — `ratio` is the
// SAVINGS ratio (1 - encoded/source). projectedBytes is bytes SAVED, not
// output size. NAIVE_RATIO_BY_ENCODER values reflect typical x265-class
// compression ratios documented in the literature.

import type { EncoderId } from '@/src/lib/encode/profiles';

export type SavingsSource = 'bench-augmented' | 'naive';

export interface BenchAugmentedInput {
  runId: number;
  ratio: number; // 0..1 savings ratio (1 - encoded/source) per computeSavings semantics
  encodeFpsRatio: number; // sample_duration_seconds / encode_seconds (e.g. 2.5 = 2.5× realtime)
}

export interface EstimatorInput {
  eligibleFileSizes: number[]; // bytes per eligible file
  eligibleFileDurations: (number | null)[]; // seconds per eligible file, null when ffprobe failed
  encoder: EncoderId;
  benchData: BenchAugmentedInput | null; // null → naive fallback
}

export interface EstimatorSavings {
  ratio: number;
  projectedBytes: number; // bytes SAVED = totalBytes × ratio
  totalBytes: number;
  source: SavingsSource;
  runId: number | null;
  encoder: EncoderId;
}

export interface EstimatorEncodeTime {
  seconds: number;
  source: SavingsSource;
  runId: number | null;
  encoder: EncoderId;
  scaleFactor: number; // SR3 — eligibleCount / withDurationCount, 1 when full coverage, 0 when none
  eligibleCount: number;
  withDurationCount: number;
}

export interface EstimatorResult {
  savings: EstimatorSavings;
  encodeTime: EstimatorEncodeTime;
}

export const NAIVE_RATIO_BY_ENCODER: Record<EncoderId, number> = {
  libx265: 0.45,
  nvenc: 0.42,
  qsv: 0.4,
  vaapi: 0.4,
};

export const NAIVE_FPS_BY_ENCODER: Record<EncoderId, number> = {
  libx265: 0.8,
  nvenc: 3.0,
  qsv: 2.5,
  vaapi: 2.0,
};

export function estimateSavings(input: EstimatorInput): EstimatorResult {
  const { eligibleFileSizes, eligibleFileDurations, encoder, benchData } = input;

  const totalBytes = eligibleFileSizes.reduce((s, b) => s + b, 0);
  const ratio = benchData?.ratio ?? NAIVE_RATIO_BY_ENCODER[encoder];
  const projectedBytes = Math.round(totalBytes * ratio);
  const encodeFpsRatio = benchData?.encodeFpsRatio ?? NAIVE_FPS_BY_ENCODER[encoder];

  const validDurations = eligibleFileDurations.filter((d): d is number => d !== null && d > 0);
  const sumValidDurations = validDurations.reduce((s, d) => s + d, 0);
  const eligibleCount = eligibleFileSizes.length;
  const withDurationCount = validDurations.length;

  const rawSeconds = encodeFpsRatio > 0 ? sumValidDurations / encodeFpsRatio : 0;
  // SR3 — scale up to compensate for files we couldn't probe.
  const scaleFactor = withDurationCount > 0 ? eligibleCount / withDurationCount : 0;
  const scaledSeconds = Math.round(rawSeconds * scaleFactor);

  const source: SavingsSource = benchData ? 'bench-augmented' : 'naive';
  const runId = benchData?.runId ?? null;

  return {
    savings: { ratio, projectedBytes, totalBytes, source, runId, encoder },
    encodeTime: {
      seconds: scaledSeconds,
      source,
      runId,
      encoder,
      scaleFactor,
      eligibleCount,
      withDurationCount,
    },
  };
}
