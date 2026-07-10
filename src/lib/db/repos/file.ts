import type Database from 'better-sqlite3';
import type { FileRow, FileStatus, FileUpsertInput, ShareIdFilter } from '../schema';
import {
  ENCODE_GUARD_MAX_FLIP_SCOPE,
  EncodeGuardScopeCapError,
} from '@/src/lib/blocklist/encode-guard';
import { withQueryTiming } from '@/src/lib/db/timing';

type Db = InstanceType<typeof Database>;

const NOW_SECONDS = (): number => Math.floor(Date.now() / 1000);

// 01-04: whitelisted sort tokens — never interpolate user input into SQL.
const SORT_COLUMNS = {
  size: 'size_bytes',
  bitrate: 'bitrate',
  duration: 'duration_seconds',
  scanned: 'last_scanned_at',
} as const;
export type SortKey = keyof typeof SORT_COLUMNS;
export type SortDir = 'asc' | 'desc';

export interface ListOptions {
  page: number;
  size: number;
  q?: string;
  status?: FileStatus | 'all';
  sort: SortKey;
  dir: SortDir;
  // 05-bonus: include rows with status='vanished' in the result set. Default
  // false → vanished rows are hidden. When status filter is explicitly
  // 'vanished' the flag is ignored (operator wants to see vanished).
  includeVanished?: boolean;
  // 07-01: single-file deep-link filter. When set, narrows result to that
  // exact file.id. Library page renders 1-row focused view; non-existent id
  // silently 0-rows (no crash, no 404). COUNT honors the filter so pagination
  // math stays consistent.
  idFilter?: number;
  // 14-03: scope rows to a specific share.id, the NULL-share orphan bucket,
  // or undefined = all (back-compat with 14-01/14-02 callers).
  shareId?: ShareIdFilter;
  // 15-01: prefix-restrict file.path. Empty string = no filter. Wildcards
  // (`%`, `_`) in input are LIKE-escaped pre-binding; rows match WHERE path
  // STARTS WITH literal prefix.
  pathPrefix?: string;
}

export interface ListResult {
  rows: FileRow[];
  total: number;
}

// All 17 FileStatus values + the `all` aggregate (15 pre-05-13 + 'done-not-worth' + 'done-already-evaluated').
export type CountByStatus = Record<FileStatus, number> & { all: number };

const ALL_STATUSES: readonly FileStatus[] = [
  'pending',
  'queued',
  'encoding',
  'done-smaller',
  'done-larger',
  'skipped-codec',
  'skipped-bitrate',
  'skipped-suffix',
  'skipped-tag',
  'skipped-sidecar',
  'skipped-blocklist',
  'failed',
  'blocklisted',
  'interrupted',
  'vanished',
  // 05-13: see schema.ts for semantics.
  'done-not-worth',
  'done-already-evaluated',
] as const;

// audit-added S7: runtime guard for setStatus — the SQLite column is free-text,
// so an unchecked JSON-passthrough could persist garbage like 'badstatus' that
// the TS literal-union would never produce. Tuple lookup throws TypeError
// before any DB write.
const FILE_STATUSES: ReadonlySet<FileStatus> = new Set(ALL_STATUSES);

// audit-added M7: escape LIKE wildcards in user input. `%` and `_` would
// otherwise expand the search beyond the literal substring.
function escapeLike(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// 15-01 T2: build the LIKE-bound parameter for the pathPrefix filter. STARTS
// WITH semantics — strips any trailing slash before appending `/%` so callers
// can pass either `/mnt/movies/A` or `/mnt/movies/A/` without double-slash
// matches. Returns null when the input is empty/undefined so the (? IS NULL)
// branch bypasses the WHERE clause.
function buildPathPrefixParam(input: string | undefined): string | null {
  if (!input || input.length === 0) return null;
  const trimmed = input.endsWith('/') ? input.slice(0, -1) : input;
  return escapeLike(trimmed) + '/%';
}

// 28-01 L4: single source for the 6-predicate file-list WHERE block, previously
// triplicated across getListStmt / getIterateStmt / getCountStmt. Provenance of
// the predicates:
//   - LIKE-path search (LOWER() case-insensitive + ESCAPE '\' wildcard guard, M7)
//   - status filter (? IS NULL OR status = ?)
//   - 05-bonus: `AND (? = 1 OR status != 'vanished')` hides vanished by default;
//     caller binds 1 when includeVanished OR status filter is explicitly 'vanished'.
//   - 07-01: `AND (? IS NULL OR file.id = ?)` deep-link single-file narrow.
//   - 14-03: SHARE CASE selector (NULL=all / -1=orphan / N>0=share_id=N) — the
//     sentinel encoding lives in the binder, keeping the `?` count tractable.
//   - 15-01: pathPrefix STARTS WITH clause (escape-bound, ? IS NULL bypass),
//     appended last to keep prior bind order stable.
// The predicate ORDER and `?`-placeholder count are FROZEN: the listPaginated /
// iterateAll / countByQuery binders pass 12 params positionally — do NOT renumber.
function buildFileListWhereClause(): string {
  return `WHERE (? IS NULL OR LOWER(path) LIKE LOWER(?) ESCAPE '\\')
           AND (? IS NULL OR status = ?)
           AND (? = 1 OR status != 'vanished')
           AND (? IS NULL OR file.id = ?)
           AND CASE
                WHEN ? IS NULL THEN 1
                WHEN ? = -1 THEN share_id IS NULL
                ELSE share_id = ?
              END
           AND (? IS NULL OR path LIKE ? ESCAPE '\\')`;
}

export interface FileRepo {
  upsertByPath(input: FileUpsertInput): FileRow;
  findByPath(path: string): FileRow | undefined;
  findByContentHash(hash: string): FileRow | undefined;
  getById(id: number): FileRow | undefined;
  // 11-02-FIX-V2 UAT-003: batched lookup for bench-page file-size-map projection.
  // Chunks at >500 IDs to stay under SQLITE_MAX_VARIABLE_NUMBER=999 ceiling (audit SR7).
  listByIds(ids: readonly number[]): FileRow[];
  count(): number;
  // audit-added M6: bumped on hash failure so the existing row's
  // last_scanned_at does not drift stale. See orchestrator.ts.
  touchLastScanned(id: number, lastScannedAt: number): void;
  // 01-04 additions
  listPaginated(opts: ListOptions): ListResult;
  countByStatus(): CountByStatus;
  // 02-01: OCC-aware status transition. Returns false on stale `expectedVersion`
  // OR missing id — caller backs off, never overwrites fresher state.
  setStatus(id: number, status: FileStatus, expectedVersion: number): boolean;
  // 05-09 audit M2: bulk file→pending for /api/queue/cancel-all single-TX path.
  // Status-guarded — only rows currently in `expectedStates` flip; OCC-race-free
  // (no per-row version snapshot needed). Empty `ids` array NO-OP returns 0.
  // Per-row setStatus is FORBIDDEN inside cancelAllQueued (race window with
  // concurrent scan/trash flows on stale version snapshot).
  bulkSetStatusToPendingByIds(ids: number[], expectedStates: readonly FileStatus[]): number;
  // 13-06: generalized bulk status flip. Mirrors bulkSetStatusToPendingByIds
  // shape but accepts target newStatus. Single-TX status-guarded UPDATE;
  // OCC-bumped via version + 1. Empty ids → NO-OP returns 0.
  // bulkSetStatusToPendingByIds REMAINS (05-09 cancel-all consumer).
  bulkSetStatusByIds(
    ids: readonly number[],
    newStatus: FileStatus,
    expectedStates: readonly FileStatus[],
  ): number;
  // 13-06: candidate set for retroactive blocklist flip. Returns only
  // (id, path, status) projection (matchPath inputs + previous-status snapshot).
  // Caller passes ENCODE_GUARD_ELIGIBLE_STATES — bounded by 5 placeholders.
  // Throws EncodeGuardScopeCapError when candidate count exceeds
  // ENCODE_GUARD_MAX_FLIP_SCOPE = 100_000 (audit M3).
  listEligibleForBlocklistFlip(
    statuses: readonly FileStatus[],
  ): Array<{ id: number; path: string; status: FileStatus }>;
  // 02-04 follow-up: bulk reconcile-on-boot for orphan file-rows whose
  // status is 'encoding' without a live encoder. Single-process invariant
  // makes the OCC version check redundant here — orchestrator boot is the
  // only writer at this moment. Returns the number of rows updated.
  recoverStaleEncoding(now: number): number;
  // 05-bonus: bulk-mark file rows whose `last_scanned_at` is older than the
  // current scan's startedAt as 'vanished'. PROTECTED statuses are NEVER
  // flipped — operator-controlled state stays intact. Returns the count of
  // rows mutated. OCC version is bumped per row (defensive — single-process
  // invariant should make races impossible, but keep parity with setStatus).
  markVanishedNotIn(scanStartedAt: number, protectedStatuses: readonly FileStatus[]): number;
  // 05-04: streaming CSV export. iterateAll yields rows one at a time backed
  // by better-sqlite3 stmt.iterate() — never .all(). The Route Handler at
  // app/api/library/export.csv/route.ts pulls one row per ReadableStream
  // pull() so memory stays bounded regardless of total row count.
  // page+size are intentionally ignored — export emits the full filtered set.
  iterateAll(opts: ListOptions): IterableIterator<FileRow>;
  countByQuery(opts: ListOptions): number;
  // 14-03: orphan-bucket count for Library ShareFilterPill. Returns rows where
  // share_id IS NULL, excluding status='vanished' so the bucket mirrors
  // listPaginated default (no stale-vanished inflation).
  countOrphaned(): number;
  // 10-02 E-D1: set per-file container override. NULL = inherit global.
  // Returns false when file not found.
  setContainerOverride(id: number, value: 'mkv' | 'mp4' | 'match-source' | null): boolean;
  // 24-04 F6: row-only "forget" delete. Removes ONLY the `file` row; FK
  // CASCADE drops its `job` + `blocklist_entry` rows, `trash_entry.file_id`
  // is SET NULL (trash data survives, back-reference severed). NEVER touches
  // the filesystem. Returns true when a row was removed (changes > 0), false
  // when the id did not exist (idempotent-friendly for the route's 404 path).
  // Delete is terminal — no OCC version param (no stale-overwrite risk).
  deleteById(id: number): boolean;
  // 24-04 F6 (D2 bench soft-guard): is the file referenced by >=1 bench_combo
  // row? bench_combo.file_id has NO on-delete clause (NO ACTION) so a delete
  // of a bench-referenced file raises SQLITE_CONSTRAINT_FOREIGNKEY. The route
  // pre-checks this to return a clean 409 instead of a raw FK exception.
  isReferencedByBench(id: number): boolean;
}

export function makeFileRepo(db: Db): FileRepo {
  const findByPathStmt = db.prepare<[string], FileRow>('SELECT * FROM file WHERE path = ?');
  const findByContentHashStmt = db.prepare<[string], FileRow>(
    'SELECT * FROM file WHERE content_hash = ? LIMIT 1',
  );
  const findByIdStmt = db.prepare<[number], FileRow>('SELECT * FROM file WHERE id = ?');
  const countStmt = db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM file');
  const insertStmt = db.prepare(
    `INSERT INTO file (
       path, size_bytes, mtime, content_hash, codec, bitrate,
       duration_seconds, width, height, container, last_scanned_at, share_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateFullStmt = db.prepare(
    `UPDATE file SET
       size_bytes = ?, mtime = ?, content_hash = ?, codec = ?, bitrate = ?,
       duration_seconds = ?, width = ?, height = ?, container = ?,
       last_scanned_at = ?, share_id = ?, updated_at = ?
     WHERE id = ?`,
  );
  const updateLastScannedStmt = db.prepare(
    'UPDATE file SET last_scanned_at = ?, updated_at = ? WHERE id = ?',
  );
  // audit-fix:M1 orphan-recovery — fast-path mtime+size unchanged but
  // share_id divergent (operator deleted prior share → FK SET NULL → new
  // share now covers same path). Rebind share_id without touching the
  // size/mtime/hash/probe columns. NOT used by touchLastScanned (callers
  // there pass id-only, no share_id context).
  const updateLastScannedAndShareIdStmt = db.prepare(
    'UPDATE file SET last_scanned_at = ?, share_id = ?, updated_at = ? WHERE id = ?',
  );
  // 02-01: OCC bump — version increment only when expected matches.
  const setStatusStmt = db.prepare(
    'UPDATE file SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
  );
  // 24-04 F6: row-only delete + bench-reference soft-guard. Lazy-prepared
  // alongside the other statements (same makeFileRepo closure pattern).
  const deleteByIdStmt = db.prepare<[number], unknown>('DELETE FROM file WHERE id = ?');
  const isReferencedByBenchStmt = db.prepare<[number], { one: number }>(
    'SELECT 1 AS one FROM bench_combo WHERE file_id = ? LIMIT 1',
  );
  const groupByStatusStmt = db.prepare<[], { status: FileStatus; c: number }>(
    'SELECT status, COUNT(*) AS c FROM file GROUP BY status',
  );
  // 14-03: orphan-bucket counter for Library ShareFilterPill. Excludes
  // status='vanished' so the bucket mirrors listPaginated default — orphan
  // should not be inflated by stale-vanished rows.
  const countOrphanedStmt = db.prepare<[], { c: number }>(
    "SELECT COUNT(*) AS c FROM file WHERE share_id IS NULL AND status != 'vanished'",
  );

  // 01-04: cache the (sort, dir) → prepared statement permutations at module
  // load. Eight combinations (4 sorts × 2 dirs); the cost of caching is trivial
  // and avoids parsing the SQL string on every request.
  type ListStmt = ReturnType<typeof db.prepare<unknown[], FileRow>>;
  type CountStmt = ReturnType<typeof db.prepare<unknown[], { c: number }>>;
  const listStmtCache = new Map<string, ListStmt>();
  const countStmtCache = new Map<string, CountStmt>();

  function getListStmt(sort: SortKey, dir: SortDir): ListStmt {
    const key = `${sort}|${dir}`;
    let stmt = listStmtCache.get(key);
    if (!stmt) {
      const col = SORT_COLUMNS[sort];
      const order = dir === 'asc' ? 'ASC' : 'DESC';
      // audit-added M7: LOWER() on both sides for case-insensitive search
      // (matches "süße" vs "SÜSSE" vs "Süße"). SQLite's LOWER() is locale-naive
      // but covers Latin-1 paths that operators typically use.
      // ESCAPE '\' neutralizes escaped wildcards in the parameter.
      // Anonymous `?` placeholders + positional binding — likeParam and
      // statusParam are repeated in the bind order to satisfy each `?`.
      stmt = db.prepare<unknown[], FileRow>(
        // 28-01 L4: 6-predicate WHERE shared via buildFileListWhereClause()
        // (see module-scope helper for predicate provenance + frozen bind order).
        // 28-01 P6: COUNT(*) OVER() AS __total rides every returned row so rows +
        // total come from ONE prepared statement (single round-trip). The window
        // is evaluated BEFORE LIMIT/OFFSET, so it counts every WHERE-matching row
        // but only surfaces on rows actually returned — listPaginated strips
        // __total from the FileRow shape and falls back to getCountStmt on an
        // empty (over-paginated) page.
        `SELECT *, COUNT(*) OVER() AS __total FROM file
         ${buildFileListWhereClause()}
         ORDER BY ${col} ${order}, id ASC
         LIMIT ? OFFSET ?`,
      );
      listStmtCache.set(key, stmt);
    }
    return stmt;
  }

  // 05-04: cache the (sort, dir) → prepared statement permutations for the
  // CSV export iterator. Mirrors getListStmt but omits LIMIT/OFFSET because
  // the export streams the full filtered set.
  const iterateStmtCache = new Map<string, ListStmt>();

  function getIterateStmt(sort: SortKey, dir: SortDir): ListStmt {
    const key = `${sort}|${dir}|export`;
    let stmt = iterateStmtCache.get(key);
    if (!stmt) {
      const col = SORT_COLUMNS[sort];
      const order = dir === 'asc' ? 'ASC' : 'DESC';
      stmt = db.prepare<unknown[], FileRow>(
        // 28-01 L4: same 6-predicate WHERE as getListStmt via the shared helper.
        // CSV export streams the FULL filtered set — no LIMIT/OFFSET, and NO
        // COUNT(*) OVER() (the iterator never needs a total).
        `SELECT * FROM file
         ${buildFileListWhereClause()}
         ORDER BY ${col} ${order}, id ASC`,
      );
      iterateStmtCache.set(key, stmt);
    }
    return stmt;
  }

  function getCountStmt(): CountStmt {
    let stmt = countStmtCache.get('list');
    if (!stmt) {
      stmt = db.prepare<unknown[], { c: number }>(
        // 28-01 L4: same 6-predicate WHERE as getListStmt via the shared helper —
        // COUNT honors every filter so pagination math (pageCount) stays
        // consistent with the LIST result.
        // 28-01 P6/M1: RETAINED as the listPaginated empty-page (over-paginated)
        // fallback — COUNT(*) OVER() carries no total on a zero-row page, so
        // listPaginated re-uses this with identical binds when rows.length === 0.
        `SELECT COUNT(*) AS c FROM file
         ${buildFileListWhereClause()}`,
      );
      countStmtCache.set('list', stmt);
    }
    return stmt;
  }

  function findByPath(p: string): FileRow | undefined {
    return findByPathStmt.get(p);
  }

  return {
    findByPath,

    findByContentHash(hash: string): FileRow | undefined {
      return findByContentHashStmt.get(hash);
    },

    getById(id: number): FileRow | undefined {
      return findByIdStmt.get(id);
    },

    listByIds(ids: readonly number[]): FileRow[] {
      // 11-02-FIX-V2 UAT-003 + audit SR7: defensive chunking at 500 to stay below
      // SQLite SQLITE_MAX_VARIABLE_NUMBER=999. Bench runs typically ≤10 fileIds,
      // but future bulk-bench could exceed; this prevents the scaling cliff.
      if (ids.length === 0) return [];
      const CHUNK = 500;
      const out: FileRow[] = [];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const placeholders = slice.map(() => '?').join(',');
        const stmt = db.prepare<number[], FileRow>(
          `SELECT * FROM file WHERE id IN (${placeholders})`,
        );
        out.push(...stmt.all(...slice));
      }
      return out;
    },

    count(): number {
      const row = countStmt.get();
      return row?.c ?? 0;
    },

    upsertByPath(input: FileUpsertInput): FileRow {
      const existing = findByPath(input.path);
      const now = NOW_SECONDS();

      // 05-bonus: auto-revive — file row previously marked 'vanished' is back
      // on disk. Flip status to 'pending' so skip-pipeline re-evaluates next.
      // Bumps version (matches setStatus convention).
      if (existing && existing.status === 'vanished') {
        db.prepare(
          "UPDATE file SET status = 'pending', version = version + 1, updated_at = ? WHERE id = ?",
        ).run(now, existing.id);
      }

      if (existing && existing.size_bytes === input.size_bytes && existing.mtime === input.mtime) {
        // mtime-skip fast path: only refresh last_scanned_at.
        // audit-fix:M1 orphan-recovery — on share_id divergence (e.g.
        // existing.share_id===NULL post-FK-SET-NULL, input.share_id pointing
        // at a recreated share), rebind without touching probe/hash columns.
        if (existing.share_id !== input.share_id) {
          updateLastScannedAndShareIdStmt.run(
            input.last_scanned_at,
            input.share_id,
            now,
            existing.id,
          );
        } else {
          updateLastScannedStmt.run(input.last_scanned_at, now, existing.id);
        }
        const refreshed = findByIdStmt.get(existing.id);
        if (!refreshed) {
          throw new Error(`upsertByPath: row vanished mid-update for id=${existing.id}`);
        }
        return refreshed;
      }

      if (existing) {
        updateFullStmt.run(
          input.size_bytes,
          input.mtime,
          input.content_hash,
          input.codec,
          input.bitrate,
          input.duration_seconds,
          input.width,
          input.height,
          input.container,
          input.last_scanned_at,
          input.share_id,
          now,
          existing.id,
        );
        const refreshed = findByIdStmt.get(existing.id);
        if (!refreshed) {
          throw new Error(`upsertByPath: row vanished mid-update for id=${existing.id}`);
        }
        return refreshed;
      }

      const result = insertStmt.run(
        input.path,
        input.size_bytes,
        input.mtime,
        input.content_hash,
        input.codec,
        input.bitrate,
        input.duration_seconds,
        input.width,
        input.height,
        input.container,
        input.last_scanned_at,
        input.share_id,
      );
      const inserted = findByIdStmt.get(Number(result.lastInsertRowid));
      if (!inserted) {
        throw new Error(`upsertByPath: insert returned no row for path=${input.path}`);
      }
      return inserted;
    },

    touchLastScanned(id: number, lastScannedAt: number): void {
      updateLastScannedStmt.run(lastScannedAt, NOW_SECONDS(), id);
    },

    listPaginated(opts: ListOptions): ListResult {
      // 22-01 IMP-3 audit-M6 canonical outer-body wrap.
      return withQueryTiming('fileRepo.listPaginated', () => {
        const offset = (opts.page - 1) * opts.size;
        const likeParam = opts.q && opts.q.length > 0 ? `%${escapeLike(opts.q)}%` : null;
        const statusParam = opts.status && opts.status !== 'all' ? opts.status : null;
        // 05-bonus: include vanished when explicit toggle OR explicit status filter.
        const includeVanishedFlag = opts.includeVanished || opts.status === 'vanished' ? 1 : 0;
        // 07-01: deep-link single-file filter; null bypasses the WHERE clause.
        const idParam = opts.idFilter ?? null;
        // 14-03: share-axis selector — null = no filter, -1 = orphan bucket
        // (share_id IS NULL), positive int = share_id = N. Sentinel lives here.
        const shareSelector: number | null =
          opts.shareId === 'orphan' ? -1 : (opts.shareId ?? null);
        // 15-01: pathPrefix STARTS WITH binder. null bypasses the WHERE clause.
        const pathPrefixParam = buildPathPrefixParam(opts.pathPrefix);

        // 14-03 audit M2: SHARE clause bound AFTER idFilter — keep position
        // stable to avoid off-by-one.
        // 28-01 P6: single round-trip — rows + total from ONE windowed
        // statement (COUNT(*) OVER() AS __total appended in getListStmt).
        const rawRows = getListStmt(opts.sort, opts.dir).all(
          likeParam,
          likeParam,
          statusParam,
          statusParam,
          includeVanishedFlag,
          idParam,
          idParam,
          shareSelector,
          shareSelector,
          shareSelector,
          pathPrefixParam,
          pathPrefixParam,
          opts.size,
          offset,
        ) as Array<FileRow & { __total?: number }>;

        // 28-01 P6/M1: COUNT(*) OVER() rides every RETURNED row. On a non-empty
        // page read __total off the first row (it is identical on all rows). On
        // an EMPTY (over-paginated) page no row carries it, so fall back to
        // getCountStmt with identical binds — the full filtered count must NOT
        // collapse to 0. The library UI clamps to the last valid page from
        // `total`, so a false 0 would flip a shrunk result into a "no files"
        // empty state. This keeps single-round-trip on the common path (rows
        // present) and correctness on the empty page.
        let total: number;
        if (rawRows.length > 0) {
          total = rawRows[0].__total ?? 0;
        } else {
          const totalRow = getCountStmt().get(
            likeParam,
            likeParam,
            statusParam,
            statusParam,
            includeVanishedFlag,
            idParam,
            idParam,
            shareSelector,
            shareSelector,
            shareSelector,
            pathPrefixParam,
            pathPrefixParam,
          );
          total = totalRow?.c ?? 0;
        }

        // 28-01 SR1: strip __total so it never reaches a FileRow consumer (the
        // API serializes rows straight to the client). Mutating the freshly
        // fetched row object is safe — it escapes nowhere else.
        const rows: FileRow[] = rawRows.map((r) => {
          delete r.__total;
          return r as FileRow;
        });

        return { rows, total };
      });
    },

    countByStatus(): CountByStatus {
      return withQueryTiming('fileRepo.countByStatus', () => {
        const grouped = groupByStatusStmt.all();
        const out: Record<string, number> = {};
        for (const status of ALL_STATUSES) out[status] = 0;
        let total = 0;
        for (const row of grouped) {
          out[row.status] = row.c;
          total += row.c;
        }
        out.all = total;
        return out as CountByStatus;
      });
    },

    setStatus(id: number, status: FileStatus, expectedVersion: number): boolean {
      // audit-added S7: reject unknown status BEFORE any DB write.
      if (!FILE_STATUSES.has(status)) {
        throw new TypeError(
          `fileRepo.setStatus: invalid status '${String(status)}' — must be one of ${[...FILE_STATUSES].join(', ')}`,
        );
      }
      const result = setStatusStmt.run(status, NOW_SECONDS(), id, expectedVersion);
      return result.changes === 1;
    },

    bulkSetStatusToPendingByIds(ids: number[], expectedStates: readonly FileStatus[]): number {
      if (ids.length === 0) return 0;
      // Defensive — if caller passes an empty expectedStates array the status
      // guard would always be false and the UPDATE would be a no-op. Treat as
      // bug-on-caller-side rather than silently no-op.
      if (expectedStates.length === 0) {
        throw new TypeError(
          'fileRepo.bulkSetStatusToPendingByIds: expectedStates must be non-empty',
        );
      }
      for (const s of expectedStates) {
        if (!FILE_STATUSES.has(s)) {
          throw new TypeError(
            `fileRepo.bulkSetStatusToPendingByIds: invalid expected status '${String(s)}'`,
          );
        }
      }
      const idPlaceholders = ids.map(() => '?').join(',');
      const statePlaceholders = expectedStates.map(() => '?').join(',');
      const stmt = db.prepare<unknown[], unknown>(
        `UPDATE file
         SET status = 'pending', version = version + 1, updated_at = ?
         WHERE id IN (${idPlaceholders}) AND status IN (${statePlaceholders})`,
      );
      const result = stmt.run(NOW_SECONDS(), ...ids, ...expectedStates);
      return result.changes;
    },

    bulkSetStatusByIds(
      ids: readonly number[],
      newStatus: FileStatus,
      expectedStates: readonly FileStatus[],
    ): number {
      if (ids.length === 0) return 0;
      if (!FILE_STATUSES.has(newStatus)) {
        throw new TypeError(
          `fileRepo.bulkSetStatusByIds: invalid newStatus '${String(newStatus)}'`,
        );
      }
      if (expectedStates.length === 0) {
        throw new TypeError('fileRepo.bulkSetStatusByIds: expectedStates must be non-empty');
      }
      for (const s of expectedStates) {
        if (!FILE_STATUSES.has(s)) {
          throw new TypeError(
            `fileRepo.bulkSetStatusByIds: invalid expected status '${String(s)}'`,
          );
        }
      }
      const idPlaceholders = ids.map(() => '?').join(',');
      const statePlaceholders = expectedStates.map(() => '?').join(',');
      const stmt = db.prepare<unknown[], unknown>(
        `UPDATE file
         SET status = ?, version = version + 1, updated_at = ?
         WHERE id IN (${idPlaceholders}) AND status IN (${statePlaceholders})`,
      );
      const result = stmt.run(newStatus, NOW_SECONDS(), ...ids, ...expectedStates);
      return result.changes;
    },

    listEligibleForBlocklistFlip(
      statuses: readonly FileStatus[],
    ): Array<{ id: number; path: string; status: FileStatus }> {
      if (statuses.length === 0) return [];
      for (const s of statuses) {
        if (!FILE_STATUSES.has(s)) {
          throw new TypeError(
            `fileRepo.listEligibleForBlocklistFlip: invalid status '${String(s)}'`,
          );
        }
      }
      const placeholders = statuses.map(() => '?').join(',');
      const countStmtLocal = db.prepare<unknown[], { c: number }>(
        `SELECT COUNT(*) AS c FROM file WHERE status IN (${placeholders})`,
      );
      const countRow = countStmtLocal.get(...statuses);
      const scopeCount = countRow?.c ?? 0;
      if (scopeCount > ENCODE_GUARD_MAX_FLIP_SCOPE) {
        throw new EncodeGuardScopeCapError(scopeCount, ENCODE_GUARD_MAX_FLIP_SCOPE);
      }
      const listStmtLocal = db.prepare<unknown[], { id: number; path: string; status: FileStatus }>(
        `SELECT id, path, status FROM file WHERE status IN (${placeholders})`,
      );
      return listStmtLocal.all(...statuses);
    },

    recoverStaleEncoding(now: number): number {
      const stmt = db.prepare(
        "UPDATE file SET status = 'interrupted', version = version + 1, updated_at = ? WHERE status = 'encoding'",
      );
      const result = stmt.run(now);
      return result.changes;
    },

    iterateAll(opts: ListOptions): IterableIterator<FileRow> {
      const likeParam = opts.q && opts.q.length > 0 ? `%${escapeLike(opts.q)}%` : null;
      const statusParam = opts.status && opts.status !== 'all' ? opts.status : null;
      const includeVanishedFlag = opts.includeVanished || opts.status === 'vanished' ? 1 : 0;
      const idParam = opts.idFilter ?? null;
      // 14-03 audit M2: SHARE clause bound AFTER idFilter — keep position
      // stable to avoid off-by-one.
      const shareSelector: number | null = opts.shareId === 'orphan' ? -1 : (opts.shareId ?? null);
      // 15-01: pathPrefix iterate-parity binder.
      const pathPrefixParam = buildPathPrefixParam(opts.pathPrefix);
      return getIterateStmt(opts.sort, opts.dir).iterate(
        likeParam,
        likeParam,
        statusParam,
        statusParam,
        includeVanishedFlag,
        idParam,
        idParam,
        shareSelector,
        shareSelector,
        shareSelector,
        pathPrefixParam,
        pathPrefixParam,
      ) as IterableIterator<FileRow>;
    },

    countByQuery(opts: ListOptions): number {
      const likeParam = opts.q && opts.q.length > 0 ? `%${escapeLike(opts.q)}%` : null;
      const statusParam = opts.status && opts.status !== 'all' ? opts.status : null;
      const includeVanishedFlag = opts.includeVanished || opts.status === 'vanished' ? 1 : 0;
      const idParam = opts.idFilter ?? null;
      // 14-03 audit M2: SHARE clause bound AFTER idFilter — keep position
      // stable to avoid off-by-one.
      const shareSelector: number | null = opts.shareId === 'orphan' ? -1 : (opts.shareId ?? null);
      // 15-01: pathPrefix parity binder.
      const pathPrefixParam = buildPathPrefixParam(opts.pathPrefix);
      const totalRow = getCountStmt().get(
        likeParam,
        likeParam,
        statusParam,
        statusParam,
        includeVanishedFlag,
        idParam,
        idParam,
        shareSelector,
        shareSelector,
        shareSelector,
        pathPrefixParam,
        pathPrefixParam,
      );
      return totalRow?.c ?? 0;
    },

    countOrphaned(): number {
      return withQueryTiming('fileRepo.countOrphaned', () => {
        const row = countOrphanedStmt.get();
        return row?.c ?? 0;
      });
    },

    markVanishedNotIn(scanStartedAt: number, protectedStatuses: readonly FileStatus[]): number {
      // Reject status values that are already 'vanished' from the protected
      // list — re-marking is a no-op (already vanished). This also defends
      // against the operator passing 'vanished' in protectedStatuses, which
      // would NEVER let any row transition (correct, but wasteful).
      const protect = protectedStatuses.filter((s) => s !== 'vanished');
      // SQLite IN-list accepts a fixed-arity placeholder list. Build inline
      // with positional placeholders.
      const placeholders = protect.map(() => '?').join(',');
      // No protect set → use a subquery that always-false to keep SQL valid.
      const protectClause = protect.length > 0 ? `AND status NOT IN (${placeholders})` : '';
      const stmt = db.prepare<unknown[], unknown>(
        `UPDATE file
         SET status = 'vanished', version = version + 1, updated_at = ?
         WHERE last_scanned_at < ?
           AND status != 'vanished'
           ${protectClause}`,
      );
      const params: unknown[] = [NOW_SECONDS(), scanStartedAt, ...protect];
      const result = stmt.run(...params);
      return result.changes;
    },

    setContainerOverride(id: number, value: 'mkv' | 'mp4' | 'match-source' | null): boolean {
      const stmt = db.prepare<[string | null, number, number], unknown>(
        'UPDATE file SET container_override = ?, version = version + 1, updated_at = ? WHERE id = ?',
      );
      const result = stmt.run(value, NOW_SECONDS(), id);
      return result.changes === 1;
    },

    deleteById(id: number): boolean {
      // 24-04 F6: relies on FK CASCADE (job, blocklist_entry) + SET NULL
      // (trash_entry). Filesystem is NEVER touched (D1 = A row-only forget).
      const result = deleteByIdStmt.run(id);
      return result.changes > 0;
    },

    isReferencedByBench(id: number): boolean {
      // 24-04 F6 D2: pre-check for the bench FK NO-ACTION constraint.
      const row = isReferencedByBenchStmt.get(id);
      return row !== undefined;
    },
  };
}
