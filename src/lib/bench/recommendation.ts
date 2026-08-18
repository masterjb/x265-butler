// 12-01: Bench recommendation helper — pure-function selection of top-1 per role
// CRF/preset per encoder from a bench_combo row list. ZERO I/O, ZERO logging.
//
// 12-04: mode parameter extends 12-01 single-role 'quality' filter to operator-
// selectable 'quality' | 'balanced' | 'size'. Default 'quality' preserves
// byte-identical 12-01 behavior for any caller passing only combos.
// Empty-result {} when no combo matches mode is a legitimate outcome (e.g.
// recomputePareto last-write-wins collapsed the role) — NOT an error.
//
// Caller (route handler /api/bench/recommendation) consumes:
//   - recommendations: per-encoder { crf, preset } map
//   - unknownEncoders: encoder-string values absent from EncoderId union (e.g. AV1)
//   - divergences: P11-invariant violations (multiple combos for the chosen
//                  role + encoder that DISAGREE on (crf, preset)). First-seen
//                  wins; caller emits a structured warn-log per request.
//
// Purity invariant: this module imports ONLY from db/schema (types) and
// encode/profiles (EncoderId / ENCODER_IDS). It MUST NOT import from
// db/index, db/repos/*, node:fs, node:child_process, or any I/O surface —
// the test suite tests/bench/recommendation.test.ts runs without DB init.

import { ENCODER_IDS, type EncoderId } from '@/src/lib/encode/profiles';
import type { BenchComboRow } from '@/src/lib/db/schema';

export interface EncoderRecommendation {
  crf: number;
  preset: string | null;
}

export type RecommendationByEncoder = Partial<Record<EncoderId, EncoderRecommendation>>;

export interface RecommendationDivergence {
  encoder: EncoderId;
  picked: EncoderRecommendation;
  conflict: EncoderRecommendation;
}

export interface RecommendationResult {
  recommendations: RecommendationByEncoder;
  unknownEncoders: string[];
  divergences: RecommendationDivergence[];
}

const KNOWN_ENCODERS = new Set<string>(ENCODER_IDS);

export type RecommendationMode = 'quality' | 'balanced' | 'size';

export function selectRecommendationsByEncoder(
  combos: ReadonlyArray<BenchComboRow>,
  mode: RecommendationMode = 'quality',
): RecommendationResult {
  const recommendations: RecommendationByEncoder = {};
  const unknownSet = new Set<string>();
  const divergences: RecommendationDivergence[] = [];

  for (const combo of combos) {
    if (combo.top3_role !== mode) continue;

    if (!KNOWN_ENCODERS.has(combo.encoder)) {
      unknownSet.add(combo.encoder);
      continue;
    }

    const encoderId = combo.encoder as EncoderId;
    const existing = recommendations[encoderId];
    const candidate: EncoderRecommendation = {
      crf: combo.native_quality_value,
      preset: combo.preset,
    };

    if (!existing) {
      recommendations[encoderId] = candidate;
      continue;
    }

    if (existing.crf !== candidate.crf || existing.preset !== candidate.preset) {
      divergences.push({
        encoder: encoderId,
        picked: existing,
        conflict: candidate,
      });
    }
  }

  return {
    recommendations,
    unknownEncoders: Array.from(unknownSet),
    divergences,
  };
}
