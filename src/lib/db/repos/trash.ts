import type Database from 'better-sqlite3';
import type { TrashEntryCreateInput, TrashEntryRow } from '../schema';

type Db = InstanceType<typeof Database>;

const NOW_SECONDS = (): number => Math.floor(Date.now() / 1000);

const SECONDS_PER_DAY = 86_400;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;
const DEFAULT_DELETE_BATCH = 1000;
const MAX_DELETE_BATCH = 10_000;

// audit-added S3: validates retention BEFORE the DB write so a misconfigured
// `trash_retention_days='0'` setting can never silently destroy restorable
// trash on the very next sweep. Throws RangeError for caller to surface.
export function computeExpiresAt(trashedAtSeconds: number, retentionDays: number): number {
  if (
    typeof retentionDays !== 'number' ||
    !Number.isFinite(retentionDays) ||
    !Number.isInteger(retentionDays) ||
    retentionDays < MIN_RETENTION_DAYS ||
    retentionDays > MAX_RETENTION_DAYS
  ) {
    throw new RangeError(
      `trashRepo: retention_days=${String(retentionDays)} outside legal range [${MIN_RETENTION_DAYS}..${MAX_RETENTION_DAYS}]`,
    );
  }
  return trashedAtSeconds + retentionDays * SECONDS_PER_DAY;
}

export interface TrashListOptions {
  page: number;
  size: number;
  includeRestored?: boolean;
}

export interface TrashListResult {
  rows: TrashEntryRow[];
  total: number;
}

export interface TrashSummary {
  bytesReclaimed: number;
  count: number;
}

export interface TrashRepo {
  create(input: TrashEntryCreateInput): TrashEntryRow;
  list(opts: TrashListOptions): TrashListResult;
  restore(id: number): boolean;
  // audit-added S4: bounded delete; default 1000 / max 10_000.
  deleteExpired(now: number, batchSize?: number): number;
  // 02-03 additive: total trash entry count for paginated /api/trash response.
  // The existing `list` method already returns `total` but `count` is needed
  // separately by callers that don't want a row payload.
  count(includeRestored?: boolean): number;
  // 02-04 additive: findById for restore endpoint pre-flight checks.
  findById(id: number): TrashEntryRow | undefined;
  // 02-04 additive: aggregate for CumulativeSavingsPill + /api/trash/summary.
  summary(): TrashSummary;
  // 13-02 additive: permanent delete of a single trash entry by id (used by
  // /api/trash/bulk-delete inside per-ID SAVEPOINT iteration). Returns true if
  // a row was deleted, false if the row did not exist (idempotent).
  deleteRow(id: number): boolean;
}

export function makeTrashRepo(db: Db): TrashRepo {
  const insertStmt = db.prepare(
    `INSERT INTO trash_entry
       (file_id, original_path, trash_path, size_bytes, trashed_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const findByIdStmt = db.prepare<[number], TrashEntryRow>(
    'SELECT * FROM trash_entry WHERE id = ?',
  );
  const restoreStmt = db.prepare(
    'UPDATE trash_entry SET restored_at = ? WHERE id = ? AND restored_at IS NULL',
  );
  const listExcludingRestoredStmt = db.prepare<[number, number], TrashEntryRow>(
    `SELECT * FROM trash_entry
     WHERE restored_at IS NULL
     ORDER BY trashed_at DESC, id DESC
     LIMIT ? OFFSET ?`,
  );
  const listAllStmt = db.prepare<[number, number], TrashEntryRow>(
    `SELECT * FROM trash_entry
     ORDER BY trashed_at DESC, id DESC
     LIMIT ? OFFSET ?`,
  );
  const countExcludingRestoredStmt = db.prepare<[], { c: number }>(
    'SELECT COUNT(*) AS c FROM trash_entry WHERE restored_at IS NULL',
  );
  const countAllStmt = db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM trash_entry');
  // audit-added S4: bounded delete via id-IN subquery (better-sqlite3 build
  // does not include SQLITE_ENABLE_UPDATE_DELETE_LIMIT, so direct
  // DELETE...LIMIT is unavailable; the IN-subquery pattern is portable).
  const deleteExpiredStmt = db.prepare(
    `DELETE FROM trash_entry
     WHERE id IN (
       SELECT id FROM trash_entry
       WHERE expires_at <= ? AND restored_at IS NULL
       ORDER BY expires_at ASC, id ASC
       LIMIT ?
     )`,
  );
  // 02-04 additive: aggregate for CumulativeSavingsPill — count + sum of active
  // (not yet restored) trash entries. COALESCE ensures 0 not NULL on empty table.
  const summaryStmt = db.prepare<[], { count: number; bytesReclaimed: number }>(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(size_bytes), 0) AS bytesReclaimed
     FROM trash_entry
     WHERE restored_at IS NULL`,
  );
  // 13-02 additive: single-row DELETE for /api/trash/bulk-delete per-ID iteration.
  const deleteRowStmt = db.prepare<[number], void>('DELETE FROM trash_entry WHERE id = ?');

  return {
    create(input: TrashEntryCreateInput): TrashEntryRow {
      const trashedAt = NOW_SECONDS();
      // computeExpiresAt validates retention_days FIRST — throws BEFORE the
      // INSERT so an invalid input never persists a partial row.
      const expiresAt = computeExpiresAt(trashedAt, input.retention_days);
      const result = insertStmt.run(
        input.file_id,
        input.original_path,
        input.trash_path,
        input.size_bytes,
        trashedAt,
        expiresAt,
      );
      const inserted = findByIdStmt.get(Number(result.lastInsertRowid));
      if (!inserted) {
        throw new Error(`trashRepo.create: insert returned no row for ${input.trash_path}`);
      }
      return inserted;
    },

    list(opts: TrashListOptions): TrashListResult {
      const offset = (opts.page - 1) * opts.size;
      if (opts.includeRestored) {
        const rows = listAllStmt.all(opts.size, offset);
        const total = countAllStmt.get();
        return { rows, total: total?.c ?? 0 };
      }
      const rows = listExcludingRestoredStmt.all(opts.size, offset);
      const total = countExcludingRestoredStmt.get();
      return { rows, total: total?.c ?? 0 };
    },

    restore(id: number): boolean {
      const result = restoreStmt.run(NOW_SECONDS(), id);
      return result.changes === 1;
    },

    deleteExpired(now: number, batchSize: number = DEFAULT_DELETE_BATCH): number {
      const safeBatch = Math.min(Math.max(1, Math.floor(batchSize)), MAX_DELETE_BATCH);
      const result = deleteExpiredStmt.run(now, safeBatch);
      return result.changes;
    },

    count(includeRestored?: boolean): number {
      if (includeRestored) {
        return countAllStmt.get()?.c ?? 0;
      }
      return countExcludingRestoredStmt.get()?.c ?? 0;
    },

    findById(id: number): TrashEntryRow | undefined {
      return findByIdStmt.get(id);
    },

    summary(): TrashSummary {
      const row = summaryStmt.get();
      return {
        count: row?.count ?? 0,
        bytesReclaimed: row?.bytesReclaimed ?? 0,
      };
    },

    deleteRow(id: number): boolean {
      const result = deleteRowStmt.run(id);
      return result.changes === 1;
    },
  };
}
