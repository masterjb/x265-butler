// One validation for the bench matrix, used by POST /api/bench
// and by the client form. Pure leaf (no Node imports), so the form shows the
// same verdict the server would give.
import type { BenchMode } from '../db/schema';
import { PRESETS_BY_ENCODER } from '../encode/presets';
import { BENCH_ENCODER_TO_PRODUCTION_ID, isKnownBenchEncoder } from './encoder-map';

export const VMAF_TARGET_MIN = 50;
export const VMAF_TARGET_MAX = 100;
export const NATIVE_VALUE_MIN = 0;
export const NATIVE_VALUE_MAX = 51;

export type MatrixValidationError =
  | { error: 'encoder_required' }
  | { error: 'encoder_unknown'; encoders: string[] }
  | { error: 'preset_missing_for_encoder'; encoders: string[] }
  | { error: 'values_required' }
  | { error: 'vmaf_target_out_of_range'; values: number[] }
  | { error: 'native_value_out_of_range'; values: number[] };

export type MatrixValidationResult = { ok: true } | ({ ok: false } & MatrixValidationError);

function numberList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function validateBenchMatrix(mode: BenchMode, matrix: unknown): MatrixValidationResult {
  const m = (matrix ?? {}) as Record<string, unknown>;
  const encoders = numberList(m.encoders).filter((e): e is string => typeof e === 'string');
  const presets = numberList(m.presets).filter((p): p is string => typeof p === 'string');

  if (encoders.length === 0) return { ok: false, error: 'encoder_required' };

  const unknown = encoders.filter((e) => !isKnownBenchEncoder(e));
  if (unknown.length > 0) return { ok: false, error: 'encoder_unknown', encoders: unknown };

  const withoutPreset = encoders.filter((e) => {
    const valid = PRESETS_BY_ENCODER[BENCH_ENCODER_TO_PRODUCTION_ID[e]] as ReadonlyArray<string>;
    return !presets.some((p) => valid.includes(p));
  });
  if (withoutPreset.length > 0) {
    return { ok: false, error: 'preset_missing_for_encoder', encoders: withoutPreset };
  }

  if (mode === 'vmaf-anchored') {
    const values = numberList(m.vmafTargets);
    if (values.length === 0) return { ok: false, error: 'values_required' };
    const bad = values.filter(
      (v) =>
        typeof v !== 'number' || !Number.isFinite(v) || v < VMAF_TARGET_MIN || v > VMAF_TARGET_MAX,
    );
    if (bad.length > 0) {
      return { ok: false, error: 'vmaf_target_out_of_range', values: bad as number[] };
    }
    return { ok: true };
  }

  const values = numberList(m.nativeValues);
  if (values.length === 0) return { ok: false, error: 'values_required' };
  const bad = values.filter(
    (v) =>
      typeof v !== 'number' || !Number.isInteger(v) || v < NATIVE_VALUE_MIN || v > NATIVE_VALUE_MAX,
  );
  if (bad.length > 0) {
    return { ok: false, error: 'native_value_out_of_range', values: bad as number[] };
  }
  return { ok: true };
}
