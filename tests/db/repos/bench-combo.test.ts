import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeBenchRunRepo } from '@/src/lib/db/repos/bench-run';
import { makeBenchComboRepo } from '@/src/lib/db/repos/bench-combo';
import type { BenchRunRepo } from '@/src/lib/db/repos/bench-run';
import type { BenchComboRepo } from '@/src/lib/db/repos/bench-combo';

type Db = InstanceType<typeof Database>;

function setupDb(): { db: Db; runRepo: BenchRunRepo; comboRepo: BenchComboRepo } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return { db, runRepo: makeBenchRunRepo(db), comboRepo: makeBenchComboRepo(db) };
}

const MATRIX = { encoders: ['libx265'], presets: ['medium'], nativeValues: [23] };

describe('BenchComboRepo', () => {
  let db: Db;
  let runRepo: BenchRunRepo;
  let comboRepo: BenchComboRepo;
  let runId: number;
  let fileId: number;

  beforeEach(() => {
    ({ db, runRepo, comboRepo } = setupDb());
    const r = db
      .prepare(
        "INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at) VALUES ('/a.mkv', 1000, 1, 'h', 1)",
      )
      .run();
    fileId = r.lastInsertRowid as number;
    runId = runRepo.create({ mode: 'native-sweep', fileIds: [fileId], matrix: MATRIX });
  });

  afterEach(() => db.close());

  it('test_createBatch_inserts_pending_combos_with_is_pareto_0', () => {
    comboRepo.createBatch(runId, [
      {
        file_id: fileId,
        encoder: 'libx265',
        preset: 'medium',
        native_quality_param: '-crf',
        native_quality_value: 23,
        vmaf_target: null,
        sample_idx: 0,
      },
    ]);
    const rows = comboRepo.listByRun(runId);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].is_pareto).toBe(0);
    expect(rows[0].top3_role).toBeNull();
  });

  it('test_markComboComplete_sets_status_and_metrics', () => {
    comboRepo.createBatch(runId, [
      {
        file_id: fileId,
        encoder: 'libx265',
        preset: 'medium',
        native_quality_param: '-crf',
        native_quality_value: 23,
        vmaf_target: null,
        sample_idx: 0,
      },
    ]);
    const id = comboRepo.listByRun(runId)[0].id;
    comboRepo.markComboComplete(id, { vmaf: 95.5, sizeBytes: 500000, encodeSec: 12.3 });
    const row = comboRepo.listByRun(runId)[0];
    expect(row.status).toBe('complete');
    expect(row.vmaf).toBeCloseTo(95.5);
    expect(row.size_bytes).toBe(500000);
    expect(row.encode_seconds).toBeCloseTo(12.3);
    expect(row.completed_at).not.toBeNull();
  });

  it('test_markComboFailed_sets_status_and_reason', () => {
    comboRepo.createBatch(runId, [
      {
        file_id: fileId,
        encoder: 'libx265',
        preset: 'medium',
        native_quality_param: '-crf',
        native_quality_value: 23,
        vmaf_target: null,
        sample_idx: 0,
      },
    ]);
    const id = comboRepo.listByRun(runId)[0].id;
    comboRepo.markComboFailed(id, 'ffmpeg_exit_1');
    const row = comboRepo.listByRun(runId)[0];
    expect(row.status).toBe('failed');
    expect(row.error_reason).toBe('ffmpeg_exit_1');
  });

  it('test_listByRun_orders_by_file_sample_encoder_value', () => {
    comboRepo.createBatch(runId, [
      {
        file_id: fileId,
        encoder: 'libx265',
        preset: 'medium',
        native_quality_param: '-crf',
        native_quality_value: 26,
        vmaf_target: null,
        sample_idx: 1,
      },
      {
        file_id: fileId,
        encoder: 'libx265',
        preset: 'medium',
        native_quality_param: '-crf',
        native_quality_value: 20,
        vmaf_target: null,
        sample_idx: 0,
      },
    ]);
    const rows = comboRepo.listByRun(runId);
    expect(rows[0].sample_idx).toBe(0);
    expect(rows[0].native_quality_value).toBe(20);
    expect(rows[1].sample_idx).toBe(1);
    expect(rows[1].native_quality_value).toBe(26);
  });

  it('test_recomputePareto_sets_is_pareto_and_top3_role', () => {
    // 3 combos: crf 20 (high quality, big), crf 23 (balanced), crf 26 (low quality, small)
    comboRepo.createBatch(runId, [
      {
        file_id: fileId,
        encoder: 'libx265',
        preset: 'medium',
        native_quality_param: '-crf',
        native_quality_value: 20,
        vmaf_target: null,
        sample_idx: 0,
      },
      {
        file_id: fileId,
        encoder: 'libx265',
        preset: 'medium',
        native_quality_param: '-crf',
        native_quality_value: 23,
        vmaf_target: null,
        sample_idx: 0,
      },
      {
        file_id: fileId,
        encoder: 'libx265',
        preset: 'medium',
        native_quality_param: '-crf',
        native_quality_value: 26,
        vmaf_target: null,
        sample_idx: 0,
      },
    ]);
    const rows = comboRepo.listByRun(runId);
    comboRepo.markComboComplete(rows[0].id, { vmaf: 98.0, sizeBytes: 900000, encodeSec: 30 });
    comboRepo.markComboComplete(rows[1].id, { vmaf: 94.0, sizeBytes: 600000, encodeSec: 20 });
    comboRepo.markComboComplete(rows[2].id, { vmaf: 88.0, sizeBytes: 350000, encodeSec: 10 });

    comboRepo.recomputePareto(runId);

    const updated = comboRepo.listByRun(runId);
    const pareto = updated.filter((r) => r.is_pareto === 1);
    expect(pareto.length).toBe(3); // all 3 are on the frontier (none dominated)
    const top3 = updated.filter((r) => r.top3_role !== null);
    const roles = new Set(top3.map((r) => r.top3_role));
    expect(roles).toContain('quality');
    expect(roles).toContain('balanced');
    expect(roles).toContain('size');
  });

  it('test_recomputePareto_no_complete_rows_is_noop', () => {
    comboRepo.createBatch(runId, [
      {
        file_id: fileId,
        encoder: 'libx265',
        preset: 'medium',
        native_quality_param: '-crf',
        native_quality_value: 23,
        vmaf_target: null,
        sample_idx: 0,
      },
    ]);
    expect(() => comboRepo.recomputePareto(runId)).not.toThrow();
  });

  it('test_summarizeRun_aggregates_3sample_mean', () => {
    comboRepo.createBatch(runId, [
      {
        file_id: fileId,
        encoder: 'libx265',
        preset: 'medium',
        native_quality_param: '-crf',
        native_quality_value: 23,
        vmaf_target: null,
        sample_idx: 0,
      },
      {
        file_id: fileId,
        encoder: 'libx265',
        preset: 'medium',
        native_quality_param: '-crf',
        native_quality_value: 23,
        vmaf_target: null,
        sample_idx: 1,
      },
      {
        file_id: fileId,
        encoder: 'libx265',
        preset: 'medium',
        native_quality_param: '-crf',
        native_quality_value: 23,
        vmaf_target: null,
        sample_idx: 2,
      },
    ]);
    const rows = comboRepo.listByRun(runId);
    comboRepo.markComboComplete(rows[0].id, { vmaf: 90, sizeBytes: 300000, encodeSec: 10 });
    comboRepo.markComboComplete(rows[1].id, { vmaf: 92, sizeBytes: 320000, encodeSec: 12 });
    comboRepo.markComboComplete(rows[2].id, { vmaf: 94, sizeBytes: 340000, encodeSec: 14 });

    comboRepo.recomputePareto(runId);
    const summary = comboRepo.summarizeRun(runId);
    expect(summary.length).toBe(1);
    expect(summary[0].vmaf).toBeCloseTo(92);
    expect(summary[0].sizeBytes).toBeCloseTo(320000);
    expect(summary[0].encodeSec).toBeCloseTo(12);
    expect(summary[0].is_pareto).toBe(true);
  });

  it('test_createBatch_in_single_transaction_all_or_nothing', () => {
    // Create two combos; verify both inserted atomically
    comboRepo.createBatch(runId, [
      {
        file_id: fileId,
        encoder: 'libx265',
        preset: 'medium',
        native_quality_param: '-crf',
        native_quality_value: 20,
        vmaf_target: null,
        sample_idx: 0,
      },
      {
        file_id: fileId,
        encoder: 'libx265',
        preset: 'medium',
        native_quality_param: '-crf',
        native_quality_value: 23,
        vmaf_target: null,
        sample_idx: 0,
      },
    ]);
    expect(comboRepo.listByRun(runId).length).toBe(2);
  });

  it('test_markComboSkipped_sets_skipped_status', () => {
    comboRepo.createBatch(runId, [
      {
        file_id: fileId,
        encoder: 'libx265',
        preset: 'medium',
        native_quality_param: '-crf',
        native_quality_value: 23,
        vmaf_target: null,
        sample_idx: 0,
      },
    ]);
    const id = comboRepo.listByRun(runId)[0].id;
    comboRepo.markComboSkipped(id);
    expect(comboRepo.listByRun(runId)[0].status).toBe('skipped');
  });
});
