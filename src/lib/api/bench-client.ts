// 11-02: Typed fetch wrappers for /api/bench — no new runtime deps
import type {
  BenchRunRow,
  BenchComboRow,
  AggregatedComboView,
  BenchMode,
  BenchMatrix,
} from '@/src/lib/db/schema';
import type { EncoderId } from '@/src/lib/encode/profiles';
import type {
  EncoderRecommendation,
  RecommendationByEncoder,
} from '@/src/lib/bench/recommendation';

export type { BenchRunRow, BenchComboRow, AggregatedComboView };

export interface EnqueueBenchBody {
  mode: BenchMode;
  fileIds: number[];
  matrix: BenchMatrix;
  sampleCount?: number;
  sampleDurationSeconds?: number;
  vmafModel?: string;
}

export interface BenchRunDetail {
  run: BenchRunRow;
  combos: BenchComboRow[];
  summary: AggregatedComboView[];
}

export async function enqueueBenchRun(
  body: EnqueueBenchBody,
): Promise<{ runId: number } | { error: string; details?: unknown }> {
  const res = await fetch('/api/bench', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { runId?: number; error?: string; details?: unknown };
  if (!res.ok) return { error: json.error ?? 'unknown_error', details: json.details };
  return { runId: json.runId! };
}

export async function listBenchRuns(limit = 20, offset = 0): Promise<BenchRunRow[]> {
  const res = await fetch(`/api/bench?limit=${limit}&offset=${offset}`);
  if (!res.ok) return [];
  const json = (await res.json()) as { runs: BenchRunRow[] };
  return json.runs ?? [];
}

export async function getBenchRun(runId: number): Promise<BenchRunDetail | null> {
  const res = await fetch(`/api/bench/${runId}`);
  if (!res.ok) return null;
  return (await res.json()) as BenchRunDetail;
}

// 20-03: Onboarding BenchRecommendationChip consumer. Returns the recommendation
// for the active encoder if a complete bench-run yields one for the requested
// mode (default 'quality'); otherwise null. Treats 401/403/404/500/abort
// uniformly as "no recommendation available" — silent-hide path per AC-2/AC-3/
// AC-12. Caller supplies AbortSignal for the perceived-perf 5000ms upper-bound.
export async function getBenchRecommendation(
  activeEncoder: EncoderId,
  signal?: AbortSignal,
  mode: 'quality' | 'balanced' | 'size' = 'quality',
): Promise<EncoderRecommendation | null> {
  try {
    const res = await fetch(`/api/bench/recommendation?mode=${mode}`, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { recommendations?: RecommendationByEncoder };
    const rec = body.recommendations?.[activeEncoder];
    return rec ?? null;
  } catch {
    return null;
  }
}

export async function cancelBenchRun(
  runId: number,
): Promise<{ cancelled: true } | { error: string }> {
  const res = await fetch(`/api/bench/${runId}`, { method: 'DELETE' });
  const json = (await res.json()) as { cancelled?: true; error?: string };
  if (!res.ok) return { error: json.error ?? 'unknown_error' };
  return { cancelled: true };
}

// 11-03: Pass-2 verify enqueue + cancel + apply-as-defaults wrappers.

export interface Pass2EnqueueResult {
  comboId: number;
  startedAt: number;
}

export async function apiPass2(
  runId: number,
  comboId: number,
): Promise<Pass2EnqueueResult | { error: string }> {
  const res = await fetch(`/api/bench/${runId}/pass2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comboId }),
  });
  const json = (await res.json()) as {
    comboId?: number;
    startedAt?: number;
    error?: string;
  };
  if (!res.ok) return { error: json.error ?? 'unknown_error' };
  return { comboId: json.comboId!, startedAt: json.startedAt! };
}

export async function apiCancelPass2(
  runId: number,
  comboId: number,
): Promise<{ cancelled: true } | { error: string }> {
  const res = await fetch(`/api/bench/${runId}/pass2`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comboId }),
  });
  const json = (await res.json()) as { comboId?: number; error?: string };
  if (!res.ok) return { error: json.error ?? 'unknown_error' };
  return { cancelled: true };
}

export interface ApplyDefaultsResult {
  defaultEncoder: string;
  crf: string;
  preset: string | null;
  idempotent: boolean;
  // 13-01b T5 (audit M2 ADDITIVE): per-key snapshot taken pre-write so the
  // client can offer a compensating-Undo (Variant-B flow). Keys present in
  // priorValues correspond to settings rows that existed pre-write; absent
  // keys signal "no row existed → restore must delete-key" (audit M7).
  priorValues: Record<string, string>;
}

export async function apiApply(
  runId: number,
  comboId: number,
): Promise<ApplyDefaultsResult | { error: string }> {
  const res = await fetch(`/api/bench/${runId}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comboId }),
  });
  const json = (await res.json()) as {
    defaultEncoder?: string;
    crf?: string;
    preset?: string | null;
    idempotent?: boolean;
    priorValues?: Record<string, string>;
    error?: string;
  };
  if (!res.ok) return { error: json.error ?? 'unknown_error' };
  return {
    defaultEncoder: json.defaultEncoder!,
    crf: json.crf!,
    preset: json.preset ?? null,
    idempotent: json.idempotent ?? false,
    priorValues: json.priorValues ?? {},
  };
}

// 13-01b T5 (audit M3+M6 Variant-B compensating-Undo): POST same route in
// restore-mode with the snapshot received from a prior apply-mode response.
// Server-side discriminated-union switches on `priorValues` body shape →
// writes the snapshot back. settingRepo.delete() is used for absent keys.
export async function apiApplyRestore(
  runId: number,
  priorValues: Record<string, string>,
): Promise<{ restored: true; restoredKeys: number } | { error: string }> {
  const res = await fetch(`/api/bench/${runId}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priorValues }),
  });
  const json = (await res.json()) as {
    restored?: true;
    restoredKeys?: number;
    error?: string;
  };
  if (!res.ok) return { error: json.error ?? 'unknown_error' };
  return { restored: true, restoredKeys: json.restoredKeys ?? 0 };
}
