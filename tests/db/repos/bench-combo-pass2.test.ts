// 11-03 AC-1 + AC-2: bench_combo Pass-2 metrics column persistence.

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

describe('BenchComboRepo Pass-2 metrics (11-03)', () => {
  it('test_findById_returns_row_with_all_pass2_columns_NULL_by_default', () => {
    const combos = repo.listByRun(runId);
    const row = repo.findById(combos[0].id);
    expect(row).not.toBeNull();
    expect(row!.pass2_vmaf).toBeNull();
    expect(row!.pass2_size_bytes).toBeNull();
    expect(row!.pass2_encode_seconds).toBeNull();
    expect(row!.pass2_completed_at).toBeNull();
  });

  it('test_findById_returns_null_for_unknown_id', () => {
    expect(repo.findById(99999)).toBeNull();
  });

  it('test_markPass2Complete_persists_all_four_fields', () => {
    const combos = repo.listByRun(runId);
    const id = combos[0].id;
    const now = 1747000000;
    repo.markPass2Complete(id, {
      vmaf: 92.34,
      sizeBytes: 500_000_000,
      encodeSeconds: 123.45,
      completedAt: now,
    });
    const updated = repo.findById(id);
    expect(updated!.pass2_vmaf).toBeCloseTo(92.34, 2);
    expect(updated!.pass2_size_bytes).toBe(500_000_000);
    expect(updated!.pass2_encode_seconds).toBeCloseTo(123.45, 2);
    expect(updated!.pass2_completed_at).toBe(now);
  });

  it('test_markPass2Complete_does_not_disturb_pass1_metrics', () => {
    const combos = repo.listByRun(runId);
    const id = combos[0].id;
    repo.markComboComplete(id, {
      vmaf: 88.0,
      sizeBytes: 100,
      encodeSec: 5.0,
      sourceSampleBytes: 200,
    });
    repo.markPass2Complete(id, {
      vmaf: 91.0,
      sizeBytes: 5_000_000_000,
      encodeSeconds: 600,
      completedAt: 1747000000,
    });
    const row = repo.findById(id)!;
    expect(row.vmaf).toBeCloseTo(88.0, 2);
    expect(row.size_bytes).toBe(100);
    expect(row.encode_seconds).toBeCloseTo(5.0, 2);
    expect(row.source_sample_bytes).toBe(200);
    expect(row.pass2_vmaf).toBeCloseTo(91.0, 2);
    expect(row.pass2_size_bytes).toBe(5_000_000_000);
  });

  it('test_markPass2Complete_idempotent_second_call_overwrites_fields', () => {
    const combos = repo.listByRun(runId);
    const id = combos[0].id;
    repo.markPass2Complete(id, {
      vmaf: 90,
      sizeBytes: 100,
      encodeSeconds: 1,
      completedAt: 1000,
    });
    repo.markPass2Complete(id, {
      vmaf: 92,
      sizeBytes: 200,
      encodeSeconds: 2,
      completedAt: 2000,
    });
    const row = repo.findById(id)!;
    expect(row.pass2_vmaf).toBeCloseTo(92, 2);
    expect(row.pass2_completed_at).toBe(2000);
  });
});
