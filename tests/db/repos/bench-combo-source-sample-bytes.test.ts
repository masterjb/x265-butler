// 11-02-FIX-V2 UAT-003: bench_combo source_sample_bytes column persistence + aggregation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { BenchComboRepo } from '@/src/lib/db/repos/bench-combo';
import { BenchRunRepo } from '@/src/lib/db/repos/bench-run';

type Db = InstanceType<typeof Database>;

let db: Db;
let repo: BenchComboRepo;
let runRepo: BenchRunRepo;
let runId: number;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  db.pragma('foreign_keys = ON');
  // file row required for FK (real schema per migration 0001)
  db.prepare(
    `INSERT INTO file (id, path, size_bytes, mtime, content_hash, status, last_scanned_at)
     VALUES (10, '/m/a.mkv', 1000000000, 1000, 'h', 'pending', 1000)`,
  ).run();
  repo = new BenchComboRepo(db);
  runRepo = new BenchRunRepo(db);
  runId = runRepo.create({
    mode: 'native-sweep',
    fileIds: [10],
    matrix: { encoders: ['libx265'], presets: ['medium'], nativeValues: [23] },
    sampleCount: 1,
    sampleDurationSec: 20,
  });
  repo.createBatch(runId, [
    {
      file_id: 10,
      encoder: 'libx265',
      preset: 'medium',
      native_quality_param: '-crf',
      native_quality_value: 23,
      vmaf_target: null,
      sample_idx: 0,
    },
  ]);
});

afterEach(() => db.close());

describe('BenchComboRepo source_sample_bytes (11-02-FIX-V2)', () => {
  it('test_markComboComplete_with_sourceSampleBytes_persists_value', () => {
    const combos = repo.listByRun(runId);
    repo.markComboComplete(combos[0].id, {
      vmaf: 90,
      sizeBytes: 100,
      encodeSec: 1,
      sourceSampleBytes: 500,
    });
    const updated = repo.listByRun(runId);
    expect(updated[0].source_sample_bytes).toBe(500);
  });

  it('test_markComboComplete_without_sourceSampleBytes_leaves_NULL_legacy_callers', () => {
    const combos = repo.listByRun(runId);
    repo.markComboComplete(combos[0].id, { vmaf: 90, sizeBytes: 100, encodeSec: 1 });
    const updated = repo.listByRun(runId);
    expect(updated[0].source_sample_bytes).toBeNull();
  });

  it('test_summarizeRun_averages_non_null_sourceSampleBytes_audit_M2', () => {
    // Create 2 more sample combos (same encoder+preset+CRF group)
    repo.createBatch(runId, [
      {
        file_id: 10,
        encoder: 'libx265',
        preset: 'medium',
        native_quality_param: '-crf',
        native_quality_value: 23,
        vmaf_target: null,
        sample_idx: 1,
      },
      {
        file_id: 10,
        encoder: 'libx265',
        preset: 'medium',
        native_quality_param: '-crf',
        native_quality_value: 23,
        vmaf_target: null,
        sample_idx: 2,
      },
    ]);
    const combos = repo.listByRun(runId);
    repo.markComboComplete(combos[0].id, {
      vmaf: 90,
      sizeBytes: 100,
      encodeSec: 1,
      sourceSampleBytes: 100,
    });
    repo.markComboComplete(combos[1].id, {
      vmaf: 91,
      sizeBytes: 110,
      encodeSec: 1.1,
      sourceSampleBytes: 200,
    });
    repo.markComboComplete(combos[2].id, { vmaf: 92, sizeBytes: 120, encodeSec: 1.2 }); // null

    const summary = repo.summarizeRun(runId);
    expect(summary).toHaveLength(1);
    // Mean of [100, 200] = 150 (the null is SKIPPED, not treated as 0)
    expect(summary[0].sourceSampleBytes).toBe(150);
  });

  it('test_summarizeRun_returns_null_when_all_sourceSampleBytes_are_null', () => {
    const combos = repo.listByRun(runId);
    repo.markComboComplete(combos[0].id, { vmaf: 90, sizeBytes: 100, encodeSec: 1 });
    const summary = repo.summarizeRun(runId);
    expect(summary[0].sourceSampleBytes).toBeNull(); // NOT NaN, NOT 0
  });
});
