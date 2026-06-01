import type Database from 'better-sqlite3';
import type {
  BenchComboRow,
  BenchComboCreateInput,
  BenchComboStatus,
  AggregatedCombo,
  AggregatedComboView,
  Top3Role,
} from '../schema';
import { computeParetoFrontier, pickTop3 } from '@/src/lib/bench/pareto';

type Db = InstanceType<typeof Database>;

const NOW_SECONDS = (): number => Math.floor(Date.now() / 1000);

interface BenchComboRaw {
  id: number;
  run_id: number;
  file_id: number;
  encoder: string;
  preset: string | null;
  native_quality_param: string;
  native_quality_value: number;
  vmaf_target: number | null;
  sample_idx: number;
  vmaf: number | null;
  size_bytes: number | null;
  encode_seconds: number | null;
  source_sample_bytes: number | null; // 11-02-FIX-V2 UAT-003 migration 0021
  pass2_vmaf: number | null; // 11-03 migration 0022
  pass2_size_bytes: number | null;
  pass2_encode_seconds: number | null;
  pass2_completed_at: number | null;
  status: string;
  error_reason: string | null;
  is_pareto: number;
  top3_role: string | null;
  created_at: number;
  completed_at: number | null;
}

function rawToRow(raw: BenchComboRaw): BenchComboRow {
  return {
    ...raw,
    status: raw.status as BenchComboStatus,
    top3_role: raw.top3_role as Top3Role | null,
  };
}

export class BenchComboRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  createBatch(runId: number, combos: BenchComboCreateInput[]): void {
    const now = NOW_SECONDS();
    const insert = this.db.prepare(
      `INSERT INTO bench_combo
         (run_id, file_id, encoder, preset, native_quality_param, native_quality_value,
          vmaf_target, sample_idx, status, is_pareto, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    );
    const tx = this.db.transaction(() => {
      for (const c of combos) {
        insert.run(
          runId,
          c.file_id,
          c.encoder,
          c.preset,
          c.native_quality_param,
          c.native_quality_value,
          c.vmaf_target,
          c.sample_idx,
          now,
        );
      }
    });
    tx();
  }

  findById(id: number): BenchComboRow | null {
    const row = this.db.prepare(`SELECT * FROM bench_combo WHERE id=?`).get(id) as
      | BenchComboRaw
      | undefined;
    return row ? rawToRow(row) : null;
  }

  // 11-03 AC-3: Pass-2 full-file verify write path. Caller (orchestrator)
  // guarantees one-shot semantics via global isPass2Running lock; this UPDATE
  // is bare (no state-machine guard) for symmetry with markComboComplete.
  markPass2Complete(
    id: number,
    metrics: {
      vmaf: number;
      sizeBytes: number;
      encodeSeconds: number;
      completedAt: number;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE bench_combo
         SET pass2_vmaf=?, pass2_size_bytes=?, pass2_encode_seconds=?, pass2_completed_at=?
         WHERE id=?`,
      )
      .run(metrics.vmaf, metrics.sizeBytes, metrics.encodeSeconds, metrics.completedAt, id);
  }

  markComboComplete(
    id: number,
    metrics: {
      vmaf: number;
      sizeBytes: number;
      encodeSec: number;
      // 11-02-FIX-V2 UAT-003: optional — omit for legacy callers; column stays NULL.
      sourceSampleBytes?: number;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE bench_combo
         SET status='complete', vmaf=?, size_bytes=?, encode_seconds=?, source_sample_bytes=?, completed_at=?
         WHERE id=?`,
      )
      .run(
        metrics.vmaf,
        metrics.sizeBytes,
        metrics.encodeSec,
        metrics.sourceSampleBytes ?? null,
        NOW_SECONDS(),
        id,
      );
  }

  markComboEncoding(id: number): void {
    this.db
      .prepare(`UPDATE bench_combo SET status='encoding' WHERE id=? AND status='pending'`)
      .run(id);
  }

  markComboFailed(id: number, errorReason: string): void {
    this.db
      .prepare(
        `UPDATE bench_combo
         SET status='failed', error_reason=?, completed_at=?
         WHERE id=?`,
      )
      .run(errorReason, NOW_SECONDS(), id);
  }

  markComboSkipped(id: number): void {
    this.db
      .prepare(`UPDATE bench_combo SET status='skipped', completed_at=? WHERE id=?`)
      .run(NOW_SECONDS(), id);
  }

  listByRun(runId: number): BenchComboRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM bench_combo WHERE run_id=?
         ORDER BY file_id, sample_idx, encoder, native_quality_value`,
      )
      .all(runId) as BenchComboRaw[];
    return rows.map(rawToRow);
  }

  listPendingByRun(runId: number): BenchComboRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM bench_combo WHERE run_id=? AND status='pending' ORDER BY id`)
      .all(runId) as BenchComboRaw[];
    return rows.map(rawToRow);
  }

  recomputePareto(runId: number): void {
    const completeRows = this.db
      .prepare(
        `SELECT * FROM bench_combo
         WHERE run_id=? AND status='complete'
           AND vmaf IS NOT NULL AND size_bytes IS NOT NULL AND encode_seconds IS NOT NULL`,
      )
      .all(runId) as BenchComboRaw[];

    if (completeRows.length === 0) return;

    type AggKey = string;
    const groups = new Map<AggKey, BenchComboRaw[]>();
    for (const row of completeRows) {
      const key = `${row.encoder}|${row.preset ?? ''}|${row.native_quality_param}|${row.native_quality_value}|${row.vmaf_target ?? ''}`;
      const existing = groups.get(key);
      if (existing) {
        existing.push(row);
      } else {
        groups.set(key, [row]);
      }
    }

    const aggregated: AggregatedCombo[] = [];
    for (const [, rows] of groups) {
      const n = rows.length;
      const vmaf = rows.reduce((s, r) => s + r.vmaf!, 0) / n;
      const sizeBytes = rows.reduce((s, r) => s + r.size_bytes!, 0) / n;
      const encodeSec = rows.reduce((s, r) => s + r.encode_seconds!, 0) / n;
      // 11-02-FIX-V2 audit M2: explicit null-skip aggregation. Filter non-null FIRST,
      // then average over filtered length. Mixed null+non-null avoids NaN propagation.
      const sourceNonNull = rows
        .map((r) => r.source_sample_bytes)
        .filter((v): v is number => v !== null);
      const sourceSampleBytes =
        sourceNonNull.length === 0
          ? null
          : sourceNonNull.reduce((s, v) => s + v, 0) / sourceNonNull.length;
      aggregated.push({
        encoder: rows[0].encoder,
        preset: rows[0].preset,
        native_quality_param: rows[0].native_quality_param,
        native_quality_value: rows[0].native_quality_value,
        vmaf_target: rows[0].vmaf_target,
        vmaf,
        sizeBytes,
        encodeSec,
        sourceSampleBytes,
        sampleIds: rows.map((r) => r.id),
      });
    }

    const pareto = computeParetoFrontier(aggregated);
    const top3 = pickTop3(pareto);

    const paretoSampleIds = pareto.flatMap((c) => c.sampleIds);
    const qualitySampleIds = top3?.quality.sampleIds ?? [];
    const balancedSampleIds = top3?.balanced.sampleIds ?? [];
    const sizeSampleIds = top3?.size.sampleIds ?? [];

    const tx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE bench_combo SET is_pareto=0, top3_role=NULL WHERE run_id=?`)
        .run(runId);

      if (paretoSampleIds.length > 0) {
        const placeholders = paretoSampleIds.map(() => '?').join(',');
        this.db
          .prepare(`UPDATE bench_combo SET is_pareto=1 WHERE id IN (${placeholders})`)
          .run(...paretoSampleIds);
      }

      const setTop3Role = (ids: number[], role: Top3Role): void => {
        if (ids.length === 0) return;
        const placeholders = ids.map(() => '?').join(',');
        this.db
          .prepare(`UPDATE bench_combo SET top3_role=? WHERE id IN (${placeholders})`)
          .run(role, ...ids);
      };

      if (top3) {
        setTop3Role(qualitySampleIds, 'quality');
        setTop3Role(balancedSampleIds, 'balanced');
        setTop3Role(sizeSampleIds, 'size');
      }
    });
    tx();
  }

  summarizeRun(runId: number): AggregatedComboView[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM bench_combo
         WHERE run_id=? AND status='complete'
           AND vmaf IS NOT NULL AND size_bytes IS NOT NULL AND encode_seconds IS NOT NULL`,
      )
      .all(runId) as BenchComboRaw[];

    type AggKey = string;
    const groups = new Map<AggKey, BenchComboRaw[]>();
    for (const row of rows) {
      const key = `${row.encoder}|${row.preset ?? ''}|${row.native_quality_param}|${row.native_quality_value}|${row.vmaf_target ?? ''}`;
      const existing = groups.get(key);
      if (existing) {
        existing.push(row);
      } else {
        groups.set(key, [row]);
      }
    }

    const result: AggregatedComboView[] = [];
    for (const [, comboRows] of groups) {
      const n = comboRows.length;
      const vmaf = comboRows.reduce((s, r) => s + r.vmaf!, 0) / n;
      const sizeBytes = comboRows.reduce((s, r) => s + r.size_bytes!, 0) / n;
      const encodeSec = comboRows.reduce((s, r) => s + r.encode_seconds!, 0) / n;
      // 11-02-FIX-V2 audit M2: explicit null-skip aggregation (mirror recomputePareto).
      const sourceNonNull = comboRows
        .map((r) => r.source_sample_bytes)
        .filter((v): v is number => v !== null);
      const sourceSampleBytes =
        sourceNonNull.length === 0
          ? null
          : sourceNonNull.reduce((s, v) => s + v, 0) / sourceNonNull.length;
      const isParetoAny = comboRows.some((r) => r.is_pareto === 1);
      const top3Role = comboRows.find((r) => r.top3_role !== null)?.top3_role ?? null;
      result.push({
        encoder: comboRows[0].encoder,
        preset: comboRows[0].preset,
        native_quality_param: comboRows[0].native_quality_param,
        native_quality_value: comboRows[0].native_quality_value,
        vmaf_target: comboRows[0].vmaf_target,
        vmaf,
        sizeBytes,
        encodeSec,
        sourceSampleBytes,
        sampleIds: comboRows.map((r) => r.id),
        is_pareto: isParetoAny,
        top3_role: top3Role as Top3Role | null,
      });
    }
    return result;
  }
}

export function makeBenchComboRepo(db: Db): BenchComboRepo {
  return new BenchComboRepo(db);
}
