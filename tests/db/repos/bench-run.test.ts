import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@/src/lib/db/migrate';
import { makeBenchRunRepo, OccConflictError } from '@/src/lib/db/repos/bench-run';
import type { BenchRunRepo } from '@/src/lib/db/repos/bench-run';

type Db = InstanceType<typeof Database>;

function setupDb(): { db: Db; repo: BenchRunRepo } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return { db, repo: makeBenchRunRepo(db) };
}

const BASE_INPUT = {
  mode: 'native-sweep' as const,
  fileIds: [1, 2],
  matrix: { encoders: ['libx265'], presets: ['medium'], nativeValues: [23] },
};

describe('BenchRunRepo', () => {
  let db: Db;
  let repo: BenchRunRepo;

  beforeEach(() => {
    ({ db, repo } = setupDb());
    db.prepare(
      "INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at) VALUES ('/a.mkv', 1000, 1, 'aaaa', 1)",
    ).run();
    db.prepare(
      "INSERT INTO file (path, size_bytes, mtime, content_hash, last_scanned_at) VALUES ('/b.mkv', 2000, 1, 'bbbb', 1)",
    ).run();
  });

  afterEach(() => db.close());

  it('test_create_inserts_pending_row_with_version_1', () => {
    const id = repo.create(BASE_INPUT);
    const row = repo.findById(id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('pending');
    expect(row!.version).toBe(1);
    expect(row!.mode).toBe('native-sweep');
    expect(row!.fileIds).toEqual([1, 2]);
    expect(row!.sample_count).toBe(3);
    expect(row!.vmaf_model).toBe('vmaf_v0.6.1');
  });

  it('test_create_with_custom_options_stores_them', () => {
    const id = repo.create({
      ...BASE_INPUT,
      sampleCount: 5,
      sampleDurationSec: 30,
      vmafBuckets: [95, 92],
      vmafModel: 'vmaf_4k',
      actorId: 42,
    });
    const row = repo.findById(id);
    expect(row!.sample_count).toBe(5);
    expect(row!.sample_duration_seconds).toBe(30);
    expect(row!.vmaf_buckets_json).toBe('[95,92]');
    expect(row!.vmaf_model).toBe('vmaf_4k');
    expect(row!.actor_id).toBe(42);
  });

  it('test_markRunning_flips_pending_to_running_and_bumps_version', () => {
    const id = repo.create(BASE_INPUT);
    repo.markRunning(id, 1);
    const row = repo.findById(id);
    expect(row!.status).toBe('running');
    expect(row!.version).toBe(2);
    expect(row!.started_at).not.toBeNull();
  });

  it('test_markRunning_with_wrong_version_throws_OccConflictError', () => {
    const id = repo.create(BASE_INPUT);
    expect(() => repo.markRunning(id, 99)).toThrow(OccConflictError);
  });

  it('test_markComplete_flips_running_to_complete_and_bumps_version', () => {
    const id = repo.create(BASE_INPUT);
    repo.markRunning(id, 1);
    repo.markComplete(id, 2);
    const row = repo.findById(id);
    expect(row!.status).toBe('complete');
    expect(row!.version).toBe(3);
    expect(row!.completed_at).not.toBeNull();
  });

  it('test_markFailed_flips_pending_or_running_to_failed_with_reason', () => {
    const id = repo.create(BASE_INPUT);
    repo.markFailed(id, 'ffmpeg_crash', 1);
    const row = repo.findById(id);
    expect(row!.status).toBe('failed');
    expect(row!.error_reason).toBe('ffmpeg_crash');
  });

  it('test_markCancelled_flips_pending_to_cancelled', () => {
    const id = repo.create(BASE_INPUT);
    repo.markCancelled(id, 1);
    const row = repo.findById(id);
    expect(row!.status).toBe('cancelled');
  });

  it('test_findById_returns_null_on_miss', () => {
    expect(repo.findById(999)).toBeNull();
  });

  it('test_listRecent_returns_rows_desc_by_created_at', () => {
    repo.create(BASE_INPUT);
    repo.create(BASE_INPUT);
    const rows = repo.listRecent(10, 0);
    expect(rows.length).toBe(2);
    expect(rows[0].created_at).toBeGreaterThanOrEqual(rows[1].created_at);
  });

  it('test_countByStatus_returns_correct_scalar', () => {
    repo.create(BASE_INPUT);
    repo.create(BASE_INPUT);
    expect(repo.countByStatus('pending')).toBe(2);
    expect(repo.countByStatus('running')).toBe(0);
  });

  it('test_findActiveRunningCount_counts_only_running_rows', () => {
    const id = repo.create(BASE_INPUT);
    expect(repo.findActiveRunningCount()).toBe(0);
    repo.markRunning(id, 1);
    expect(repo.findActiveRunningCount()).toBe(1);
  });

  it('test_resetStuckRunningToFailed_flips_running_rows_and_returns_count', () => {
    const id1 = repo.create(BASE_INPUT);
    const id2 = repo.create(BASE_INPUT);
    repo.markRunning(id1, 1);
    repo.markRunning(id2, 1);
    const recovered = repo.resetStuckRunningToFailed();
    expect(recovered).toBe(2);
    expect(repo.findById(id1)!.status).toBe('failed');
    expect(repo.findById(id1)!.error_reason).toBe('boot_recovery_stale_running');
    expect(repo.countByStatus('running')).toBe(0);
  });

  it('test_hydrate_malformed_json_warns_and_returns_empty_arrays', () => {
    db.prepare(
      "INSERT INTO bench_run (mode, status, file_ids_json, matrix_json, created_at) VALUES ('native-sweep','pending','INVALID','INVALID',1)",
    ).run();
    const rows = repo.listRecent(10, 0);
    const badRow = rows.find((r) => r.fileIds.length === 0);
    // Should not throw; fileIds defaults to empty array
    expect(badRow?.fileIds).toEqual([]);
  });
});
