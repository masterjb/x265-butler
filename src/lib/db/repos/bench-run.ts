import type Database from 'better-sqlite3';
import { logger } from '../../logger';
import type { BenchRunRow, BenchRunCreateInput, BenchRunStatus, BenchMatrix } from '../schema';

type Db = InstanceType<typeof Database>;

const NOW_SECONDS = (): number => Math.floor(Date.now() / 1000);

export class OccConflictError extends Error {
  constructor(
    public readonly table: string,
    public readonly id: number,
    public readonly expectedVersion: number,
    public readonly actualVersion: number | null,
  ) {
    super(
      `OCC conflict on ${table}(id=${id}): expected version=${expectedVersion}, got ${actualVersion ?? 'row-not-found'}`,
    );
    this.name = 'OccConflictError';
  }
}

interface BenchRunRaw {
  id: number;
  mode: string;
  status: string;
  file_ids_json: string;
  matrix_json: string;
  sample_count: number;
  sample_duration_seconds: number;
  vmaf_buckets_json: string | null;
  vmaf_model: string;
  actor_id: number | null;
  error_reason: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  version: number;
}

function hydrateRow(raw: BenchRunRaw): BenchRunRow {
  let fileIds: number[] = [];
  let matrix: BenchMatrix = { encoders: [], presets: [], nativeValues: [] };
  try {
    fileIds = JSON.parse(raw.file_ids_json) as number[];
  } catch {
    logger.warn({ action: 'bench_run_hydrate_malformed_json', field: 'file_ids_json', id: raw.id });
  }
  try {
    matrix = JSON.parse(raw.matrix_json) as BenchMatrix;
  } catch {
    logger.warn({ action: 'bench_run_hydrate_malformed_json', field: 'matrix_json', id: raw.id });
  }
  return {
    id: raw.id,
    mode: raw.mode as BenchRunRow['mode'],
    status: raw.status as BenchRunRow['status'],
    fileIds,
    matrix,
    sample_count: raw.sample_count,
    sample_duration_seconds: raw.sample_duration_seconds,
    vmaf_buckets_json: raw.vmaf_buckets_json,
    vmaf_model: raw.vmaf_model,
    actor_id: raw.actor_id,
    error_reason: raw.error_reason,
    created_at: raw.created_at,
    started_at: raw.started_at,
    completed_at: raw.completed_at,
    version: raw.version,
  };
}

export class BenchRunRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  create(input: BenchRunCreateInput): number {
    const now = NOW_SECONDS();
    const result = this.db
      .prepare(
        `INSERT INTO bench_run
           (mode, status, file_ids_json, matrix_json, sample_count, sample_duration_seconds,
            vmaf_buckets_json, vmaf_model, actor_id, created_at, version)
         VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        input.mode,
        JSON.stringify(input.fileIds),
        JSON.stringify(input.matrix),
        input.sampleCount ?? 3,
        input.sampleDurationSec ?? 20,
        input.vmafBuckets ? JSON.stringify(input.vmafBuckets) : null,
        input.vmafModel ?? 'vmaf_v0.6.1',
        input.actorId ?? null,
        now,
      );
    return result.lastInsertRowid as number;
  }

  markRunning(id: number, expectedVersion: number): void {
    const result = this.db
      .prepare(
        `UPDATE bench_run
         SET status='running', started_at=?, version=version+1
         WHERE id=? AND status='pending' AND version=?`,
      )
      .run(NOW_SECONDS(), id, expectedVersion);
    if (result.changes === 0) {
      const row = this.db.prepare('SELECT version FROM bench_run WHERE id=?').get(id) as
        | { version: number }
        | undefined;
      throw new OccConflictError('bench_run', id, expectedVersion, row?.version ?? null);
    }
  }

  markComplete(id: number, expectedVersion: number): void {
    const result = this.db
      .prepare(
        `UPDATE bench_run
         SET status='complete', completed_at=?, version=version+1
         WHERE id=? AND status='running' AND version=?`,
      )
      .run(NOW_SECONDS(), id, expectedVersion);
    if (result.changes === 0) {
      const row = this.db.prepare('SELECT version FROM bench_run WHERE id=?').get(id) as
        | { version: number }
        | undefined;
      throw new OccConflictError('bench_run', id, expectedVersion, row?.version ?? null);
    }
  }

  markFailed(id: number, errorReason: string, expectedVersion: number): void {
    const result = this.db
      .prepare(
        `UPDATE bench_run
         SET status='failed', completed_at=?, error_reason=?, version=version+1
         WHERE id=? AND status IN ('pending','running') AND version=?`,
      )
      .run(NOW_SECONDS(), errorReason, id, expectedVersion);
    if (result.changes === 0) {
      const row = this.db.prepare('SELECT version FROM bench_run WHERE id=?').get(id) as
        | { version: number }
        | undefined;
      throw new OccConflictError('bench_run', id, expectedVersion, row?.version ?? null);
    }
  }

  markCancelled(id: number, expectedVersion: number): void {
    const result = this.db
      .prepare(
        `UPDATE bench_run
         SET status='cancelled', completed_at=?, version=version+1
         WHERE id=? AND status IN ('pending','running') AND version=?`,
      )
      .run(NOW_SECONDS(), id, expectedVersion);
    if (result.changes === 0) {
      const row = this.db.prepare('SELECT version FROM bench_run WHERE id=?').get(id) as
        | { version: number }
        | undefined;
      throw new OccConflictError('bench_run', id, expectedVersion, row?.version ?? null);
    }
  }

  findById(id: number): BenchRunRow | null {
    const raw = this.db.prepare('SELECT * FROM bench_run WHERE id=?').get(id) as
      | BenchRunRaw
      | undefined;
    if (!raw) return null;
    return hydrateRow(raw);
  }

  listRecent(limit = 50, offset = 0, status?: BenchRunStatus): BenchRunRow[] {
    // 12-04 audit M1: optional status filter (driven by RunModePicker that
    // surfaces only completed runs). When omitted, query is byte-identical to
    // the 11-01 baseline (ORDER BY created_at DESC LIMIT ? OFFSET ?). When
    // supplied, prepend WHERE status=? — small-cardinality column, no new
    // index required.
    if (status !== undefined) {
      const rows = this.db
        .prepare('SELECT * FROM bench_run WHERE status=? ORDER BY created_at DESC LIMIT ? OFFSET ?')
        .all(status, limit, offset) as BenchRunRaw[];
      return rows.map(hydrateRow);
    }
    const rows = this.db
      .prepare('SELECT * FROM bench_run ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as BenchRunRaw[];
    return rows.map(hydrateRow);
  }

  // 12-01 audit M4: single-row read of the latest completed bench_run.
  // Replaces bounded-scan listRecent(50,0).find(r => r.status === 'complete')
  // which lies about state when ≥50 newer non-complete rows hide the genuine
  // latest-complete behind them. Uses the existing created_at DESC index;
  // no new index required.
  findLatestComplete(): BenchRunRow | null {
    const raw = this.db
      .prepare("SELECT * FROM bench_run WHERE status='complete' ORDER BY created_at DESC LIMIT 1")
      .get() as BenchRunRaw | undefined;
    if (!raw) return null;
    return hydrateRow(raw);
  }

  countAll(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM bench_run').get() as { c: number };
    return row.c;
  }

  countByStatus(status: BenchRunStatus): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM bench_run WHERE status=?')
      .get(status) as { c: number };
    return row.c;
  }

  findActiveRunningCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM bench_run WHERE status='running'")
      .get() as { c: number };
    return row.c;
  }

  resetStuckRunningToFailed(): number {
    const now = NOW_SECONDS();
    const result = this.db
      .prepare(
        `UPDATE bench_run
         SET status='failed', completed_at=?, error_reason='boot_recovery_stale_running', version=version+1
         WHERE status='running'`,
      )
      .run(now);
    return result.changes;
  }
}

export function makeBenchRunRepo(db: Db): BenchRunRepo {
  return new BenchRunRepo(db);
}
