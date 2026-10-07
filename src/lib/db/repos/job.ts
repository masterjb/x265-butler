import type Database from 'better-sqlite3';
import type {
  FileStatus,
  JobCompleteInput,
  JobCreateInput,
  JobFailInput,
  JobRow,
  JobStatus,
} from '../schema';
import { withQueryTiming } from '@/src/lib/db/timing';
import { DEFAULT_QUEUE_ORDER, QUEUE_ORDERS, type QueueOrder } from '@/src/lib/queue/queue-order';

type Db = InstanceType<typeof Database>;

const NOW_SECONDS = (): number => Math.floor(Date.now() / 1000);

// DI for the OCC-aware fileRepo.setStatus, used inside the
// transactional `enqueue` helper. Avoids a circular import between the job
// and file repo modules.
//
// bulkSetFileStatusToPending DI wires fileRepo's bulk helper
// into the cancelJobsAndPendFilesTx atomic-batch path so cancel-all happens
// in ONE TX (markCancelledBulk + bulk file→pending → all-or-nothing).
export interface JobRepoDeps {
  setFileStatus(id: number, status: FileStatus, expectedVersion: number): boolean;
  bulkSetFileStatusToPending(ids: number[], expectedStates: readonly FileStatus[]): number;
}

export type MoveBeforeResult =
  | { ok: true; fromIndex: number; toIndex: number; pinnedCount: number; queueLength: number }
  | { unknown: number[] }
  | { conflict: number[] };

// Pinned jobs first, in their manual order; then the processing order; id
// last so equal values (created_at has second resolution) stay stable.
// 'oldest' keeps queue_position for unpinned jobs too, which is exactly the
// order before the setting existed.
const PINNED_FIRST =
  'job.queue_pinned DESC, CASE WHEN job.queue_pinned = 1 THEN job.queue_position END ASC';
const ORDER_BY: Record<QueueOrder, string> = {
  oldest: 'job.queue_pinned DESC, job.queue_position ASC, job.created_at ASC, job.id ASC',
  newest: `${PINNED_FIRST}, job.created_at DESC, job.id DESC`,
  largest: `${PINNED_FIRST}, f.size_bytes DESC, job.id ASC`,
  smallest: `${PINNED_FIRST}, f.size_bytes ASC, job.id ASC`,
};

export interface JobRepo {
  create(input: JobCreateInput): JobRow | null;
  claimNext(order?: QueueOrder): JobRow | undefined;
  // audit-added M1: orphaned-encoding recovery on orchestrator startup.
  // Returns the rows it marked interrupted, so only jobs of this restart are
  // ever put back in the queue.
  recoverStaleEncoding(now: number, staleThresholdSeconds: number): JobRow[];
  markCompleted(id: number, input: JobCompleteInput): JobRow | null;
  markFailed(id: number, input: JobFailInput): JobRow | null;
  // Terminal-state guard.
  markCancelled(id: number): JobRow | null;
  // Bulk cancel for /api/queue/cancel-all single-TX path.
  // Single SQL UPDATE with WHERE id IN (...) AND status IN ('queued','encoding').
  // Returns affected row count. Empty array = NO SQL execution → returns 0.
  markCancelledBulk(ids: number[]): number;
  // Atomic bulk cancel + file→pending wrapped in a single
  // db.transaction(). All-or-nothing — both writes commit together OR neither.
  // Empty arrays → NO TX execution → returns {cancelled:0, fileChanges:0}.
  cancelJobsAndPendFilesTx(
    jobIds: number[],
    fileIds: number[],
    expectedFileStates: readonly FileStatus[],
  ): { cancelled: number; fileChanges: number };
  listActive(order?: QueueOrder): JobRow[];
  // audit-added S9: limit clamp ≤1000.
  listRecent(limit: number): JobRow[];
  // 05-bonus: paginated recent jobs for Queue page (Library-style pagination).
  // Sort: created_at DESC, id DESC (newest first; same as listRecent). Total
  // count honors the same status filter as the row query.
  // statusGroup: 'all' (default) | 'active' (queued+encoding) | 'done' |
  //              'failed' (failed+cancelled+interrupted)
  listRecentPaginated(opts: {
    page: number;
    size: number;
    statusGroup?: 'all' | 'active' | 'completed' | 'done' | 'failed' | 'cancelled';
  }): { rows: JobRow[]; total: number };
  findByFileId(file_id: number): JobRow | undefined;
  // Latest `done` job row for self-heal V2 payload reconstruction.
  // Returns the most-recent successful encode (for selfHealSidecar's V2 path).
  // Pre-0012 legacy rows return `crf: null`; the caller degrades to V1 then.
  findLatestDoneByFileId(file_id: number): JobRow | undefined;
  // Latest job row regardless of status for
  // operator-facing Detail-Panel. Failed / cancelled jobs ARE visible so a
  // pinned preset that didn't make it through (e.g. output_path_exists) is
  // still surfaced to the operator.
  findLatestByFileId(file_id: number): JobRow | undefined;
  // Transactional create + setFileStatus, requires JobRepoDeps.
  // crf threaded through; routes pass `null` (encoder not yet
  // resolved); orchestrator pin paths pass the resolved value; requestStopAll
  // re-queue passes the prior row's crf to preserve the encode intent.
  enqueue(
    file_id: number,
    encoder: string,
    expectedFileVersion: number,
    crf: number | null,
    force_container?: string | null,
  ): JobRow | null;
  // Exact count by status — unlike listRecent(500).filter(...), which
  // silently undercounts past 500 rows (Library bulk-enqueue scenario).
  // Single SELECT COUNT(*) WHERE status = ?.
  countByStatus(status: JobStatus): number;
  // Orchestrator writes the RESOLVED encoder back
  // AT DISPATCH (after auto-detect / fallback resolution), before any ffmpeg
  // spawn. Guarantees job.encoder reflects what actually ran, not the
  // enqueue-time intent. Caller MUST pass an EncoderId-validated string;
  // this method does NOT validate.
  setEncoder(id: number, encoder: string): JobRow | null;
  // Orchestrator dispatch persists the resolved CRF value so the
  // commit-step sidecar V2 payload (and any restart-from-DB self-heal) can
  // reconstruct the encode intent. SQL CHECK constrains 0..51 OR NULL; this
  // method does not re-validate — caller already resolves from settings.
  setCrf(id: number, crf: number | null): JobRow | null;
  // Orchestrator dispatch persists the resolved
  // preset_<encoder> value alongside setCrf + setEncoder. Allowed for queued +
  // encoding rows so a mid-flow flip is valid; terminal rows are guarded
  // by status check. Free-form string; caller already Catalog-validated.
  setPresetUsed(id: number, preset: string | null): JobRow | null;
  // Peek queued rows WITHOUT claiming + atomic claim by id.
  // Multi-slot orchestrator uses peek+filter+claim to skip saturated-encoder jobs
  // without permanent removal from the queue. Default limit 100 — covers >99% of
  // operator workloads (typical bulk-enqueue ≤50).
  peekQueued(limit: number, order?: QueueOrder): JobRow[];
  claimById(id: number): JobRow | undefined;
  // Sweep needs to skip active jobs.
  findById(id: number): JobRow | undefined;
  // Move one queued job before another (null = to the end) in the queue as
  // ordered by `order`, in one transaction. Every job from the front up to the
  // moved job (or up to the last job already pinned, if that is further back)
  // is pinned and renumbered, so the job lands exactly where it was dropped
  // whatever the order. `unknown` = id does not exist, `conflict` = exists but
  // is no longer queued; nothing is written in both cases.
  moveBefore(jobId: number, beforeJobId: number | null, order: QueueOrder): MoveBeforeResult;
  // Unpin every queued job; returns how many were pinned.
  clearManualOrder(): number;
  countPinnedQueued(): number;
  // Latest finished job of the file that is older than `beforeJobId`. A stalled
  // encode is retried only when this one did not stall as well.
  findPreviousFinishedByFileId(file_id: number, beforeJobId: number): JobRow | undefined;
  // Put a queued job ahead of every other queued job and pin it, so the
  // processing order cannot sort it back. Returns false when the job is not
  // queued (any more).
  moveToFront(id: number): boolean;
  // Finished jobs of the file with id <= `uptoJobId`, newest first. Used to
  // count restarts in a row.
  listFinishedByFileId(file_id: number, uptoJobId: number, limit: number): JobRow[];
  // interrupted → failed with a reason. Null when the row is not interrupted.
  markInterruptedFailed(id: number, errorMsg: string): JobRow | null;
  // Note on an interrupted row (what happened after the restart). False when
  // the row is not interrupted.
  setInterruptedNote(id: number, note: string): boolean;
  // Runs `fn` in one transaction on this database; nested repo transactions
  // (enqueue, moveToFront) become savepoints. A throw rolls back everything.
  runInTransaction<T>(fn: () => T): T;
}

// Narrow type-guard for SqliteError.code without depending on a non-exported
// runtime class. better-sqlite3 attaches `.code` strings like
// 'SQLITE_CONSTRAINT_UNIQUE' on its thrown errors.
function isUniqueConstraintError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  return (
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    (code.startsWith('SQLITE_CONSTRAINT') &&
      typeof (err as { message?: unknown }).message === 'string' &&
      ((err as { message: string }).message.includes('idx_job_active_per_file') ||
        (err as { message: string }).message.includes('UNIQUE')))
  );
}

export function makeJobRepo(db: Db, deps?: JobRepoDeps): JobRepo {
  // queue_position (migration 0014) auto-assigned to MAX(queue_position) + 1
  // over status='queued' rows, all inside one INSERT statement. better-sqlite3
  // is single-process + single-writer; the COALESCE subquery + INSERT execute
  // as one statement, making the assignment race-free against any other writer
  // in the same DB connection. Empty queue -> COALESCE returns 1.
  const insertStmt = db.prepare(
    `INSERT INTO job (file_id, status, encoder, created_at, crf, queue_position, force_container)
     VALUES (?, 'queued', ?, ?, ?, COALESCE((SELECT MAX(queue_position) + 1 FROM job WHERE status = 'queued'), 1), ?)`,
  );
  const findByIdStmt = db.prepare<[number], JobRow>('SELECT * FROM job WHERE id = ?');
  // Pick order: pinned jobs first by queue_position, the rest by the
  // processing order. One statement set per order, prepared once.
  const byOrder = <T>(make: (orderBy: string) => T): Record<QueueOrder, T> =>
    Object.fromEntries(QUEUE_ORDERS.map((o) => [o, make(ORDER_BY[o])])) as Record<QueueOrder, T>;
  const claimSelectStmts = byOrder((orderBy) =>
    db.prepare<[], { id: number }>(
      `SELECT job.id FROM job LEFT JOIN file f ON f.id = job.file_id
       WHERE job.status = 'queued' ORDER BY ${orderBy} LIMIT 1`,
    ),
  );
  const claimUpdateStmt = db.prepare(
    "UPDATE job SET status = 'encoding', started_at = ? WHERE id = ? AND status = 'queued'",
  );
  const recoverStaleStmt = db.prepare<[number, number], JobRow>(
    "UPDATE job SET status = 'interrupted', finished_at = ? WHERE status = 'encoding' AND started_at IS NOT NULL AND started_at <= ? RETURNING *",
  );
  // 2026-04-27 bug fix: status guard `AND status='encoding'` prevents
  // markCompleted from forcefully flipping terminal-state jobs back to 'done'.
  // Pre-fix: operator clicks Cancel during encode → markCancelled writes
  // 'cancelled' to job → ffmpeg keeps running because cancelJob's queued-
  // path was hit (no _activeControllers entry yet — pre-stage race) →
  // ffmpeg eventually completes → processOne calls markCompleted which
  // overwrites 'cancelled' → 'done' → original file moved to trash despite
  // operator's cancel intent. Post-fix: SQL UPDATE is no-op when status is
  // already terminal; markCompleted returns null; processOne sees null and
  // takes the external-cancel cleanup path.
  const markCompletedStmt = db.prepare(
    `UPDATE job SET status = 'done', finished_at = ?, bytes_in = ?, bytes_out = ?, duration_ms = ?
     WHERE id = ? AND status = 'encoding'`,
  );
  const markFailedStmt = db.prepare(
    `UPDATE job SET status = 'failed', finished_at = ?, exit_code = ?, error_msg = ?, log_tail = ?
     WHERE id = ? AND status = 'encoding'`,
  );
  // audit-added M2: WHERE clause restricts to non-terminal states.
  const markCancelledStmt = db.prepare(
    `UPDATE job SET status = 'cancelled', finished_at = ?
     WHERE id = ? AND status IN ('queued','encoding')`,
  );
  const listActiveStmts = byOrder((orderBy) =>
    db.prepare<[], JobRow>(
      `SELECT job.* FROM job LEFT JOIN file f ON f.id = job.file_id
       WHERE job.status IN ('queued','encoding') ORDER BY ${orderBy}`,
    ),
  );
  const listRecentStmt = db.prepare<[number], JobRow>(
    'SELECT * FROM job ORDER BY created_at DESC, id DESC LIMIT ?',
  );
  // 05-bonus: paginated variant — same ordering, additional OFFSET.
  const listRecentPaginatedStmt = db.prepare<[number, number], JobRow>(
    'SELECT * FROM job ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
  );
  const countAllJobsStmt = db.prepare<[], { n: number }>('SELECT COUNT(*) as n FROM job');
  const findByFileIdStmt = db.prepare<[number], JobRow>(
    'SELECT * FROM job WHERE file_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
  );
  // Exact COUNT for /api/queue/status pendingJobs +
  // POST /api/queue queue.updated emit + orchestrator queue.updated emit.
  const countByStatusStmt = db.prepare<[string], { n: number }>(
    'SELECT COUNT(*) as n FROM job WHERE status = ?',
  );
  // Orchestrator dispatch write-back of resolved encoder.
  const setEncoderStmt = db.prepare('UPDATE job SET encoder = ? WHERE id = ?');
  // Dispatch write-back of the resolved CRF value (companion to
  // setEncoder). Allowed for queued + encoding rows so a mid-flow flip is
  // valid; terminal rows are guarded by status check.
  const setCrfStmt = db.prepare(
    "UPDATE job SET crf = ? WHERE id = ? AND status IN ('queued','encoding')",
  );
  // Dispatch write-back of resolved preset (migration 0025) (companion
  // to setCrf + setEncoder). Same status guard.
  const setPresetUsedStmt = db.prepare(
    "UPDATE job SET preset_used = ? WHERE id = ? AND status IN ('queued','encoding')",
  );
  // Latest done row per file_id for selfHealSidecar V2 payload.
  const findLatestDoneByFileIdStmt = db.prepare<[number], JobRow>(
    "SELECT * FROM job WHERE file_id = ? AND status = 'done' ORDER BY finished_at DESC, id DESC LIMIT 1",
  );
  // Latest job row per file_id REGARDLESS of
  // status — for operator-facing Detail-Panel that needs to show the most
  // recent encode attempt (including failed/cancelled), so a pinned preset
  // setting is visible even when the encode failed (e.g. output_path_exists).
  // Done-jobs prefer finished_at; non-done rows fall back to created_at.
  const findLatestByFileIdStmt = db.prepare<[number], JobRow>(
    'SELECT * FROM job WHERE file_id = ? ORDER BY COALESCE(finished_at, started_at, created_at) DESC, id DESC LIMIT 1',
  );
  const findPreviousFinishedByFileIdStmt = db.prepare<[number, number], JobRow>(
    'SELECT * FROM job WHERE file_id = ? AND id < ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1',
  );
  const listFinishedByFileIdStmt = db.prepare<[number, number, number], JobRow>(
    'SELECT * FROM job WHERE file_id = ? AND id <= ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT ?',
  );
  const markInterruptedFailedStmt = db.prepare(
    "UPDATE job SET status = 'failed', error_msg = ? WHERE id = ? AND status = 'interrupted'",
  );
  const setInterruptedNoteStmt = db.prepare(
    "UPDATE job SET error_msg = ? WHERE id = ? AND status = 'interrupted'",
  );
  const minOtherQueuedPositionStmt = db.prepare<[number], { m: number | null }>(
    "SELECT MIN(queue_position) AS m FROM job WHERE status = 'queued' AND id != ?",
  );
  // queue_position carries CHECK (>= 0), so when the front is already at 0 the
  // others move back by one instead of this job going negative.
  const shiftOtherQueuedStmt = db.prepare(
    "UPDATE job SET queue_position = queue_position + 1 WHERE status = 'queued' AND id != ?",
  );
  const setQueuedPositionStmt = db.prepare(
    "UPDATE job SET queue_position = ?, queue_pinned = 1 WHERE id = ? AND status = 'queued'",
  );
  // Peek queued rows WITHOUT claiming.
  const peekQueuedStmts = byOrder((orderBy) =>
    db.prepare<[number], JobRow>(
      `SELECT job.* FROM job LEFT JOIN file f ON f.id = job.file_id
       WHERE job.status = 'queued' ORDER BY ${orderBy} LIMIT ?`,
    ),
  );
  const queuedIdsStmts = byOrder((orderBy) =>
    db.prepare<[], { id: number; queue_pinned: number }>(
      `SELECT job.id, job.queue_pinned FROM job LEFT JOIN file f ON f.id = job.file_id
       WHERE job.status = 'queued' ORDER BY ${orderBy}`,
    ),
  );
  const jobStatusStmt = db.prepare<[number], { status: JobStatus }>(
    'SELECT status FROM job WHERE id = ?',
  );
  const clearManualOrderStmt = db.prepare(
    "UPDATE job SET queue_pinned = 0 WHERE status = 'queued' AND queue_pinned = 1",
  );
  const countPinnedQueuedStmt = db.prepare<[], { n: number }>(
    "SELECT COUNT(*) AS n FROM job WHERE status = 'queued' AND queue_pinned = 1",
  );
  // Atomic claim by specific id (handles claim races).
  const claimByIdUpdateStmt = db.prepare(
    "UPDATE job SET status = 'encoding', started_at = ? WHERE id = ? AND status = 'queued'",
  );

  function create(input: JobCreateInput): JobRow | null {
    try {
      const result = insertStmt.run(
        input.file_id,
        input.encoder,
        NOW_SECONDS(),
        input.crf,
        input.force_container ?? null,
      );
      const row = findByIdStmt.get(Number(result.lastInsertRowid));
      return row ?? null;
    } catch (err) {
      if (isUniqueConstraintError(err)) return null;
      throw err;
    }
  }

  function claimNext(order: QueueOrder = DEFAULT_QUEUE_ORDER): JobRow | undefined {
    const claim = db.transaction((): JobRow | undefined => {
      const candidate = claimSelectStmts[order].get();
      if (!candidate) return undefined;
      const result = claimUpdateStmt.run(NOW_SECONDS(), candidate.id);
      if (result.changes !== 1) return undefined;
      return findByIdStmt.get(candidate.id);
    });
    return claim();
  }

  // Output-mode-agnostic by construction. This is a pure
  // status reconcile (UPDATE job SET status WHERE status='encoding' AND ...) —
  // it reads NO output path, suffix, or mode. A stale 'replace' job recovers
  // identically to a 'suffix' job. The trash-first replace ordering guarantees
  // any already-trashed original is recoverable via its trash row, so recovery
  // needs no replace-specific action. Do NOT add output-path assumptions here.
  function recoverStaleEncoding(now: number, staleThresholdSeconds: number): JobRow[] {
    const cutoff = now - staleThresholdSeconds;
    return recoverStaleStmt.all(now, cutoff);
  }

  function markCompleted(id: number, input: JobCompleteInput): JobRow | null {
    const result = markCompletedStmt.run(
      NOW_SECONDS(),
      input.bytes_in,
      input.bytes_out,
      input.duration_ms,
      id,
    );
    if (result.changes !== 1) return null;
    return findByIdStmt.get(id) ?? null;
  }

  function markFailed(id: number, input: JobFailInput): JobRow | null {
    const result = markFailedStmt.run(
      NOW_SECONDS(),
      input.exit_code,
      input.error_msg,
      input.log_tail,
      id,
    );
    if (result.changes !== 1) return null;
    return findByIdStmt.get(id) ?? null;
  }

  function markCancelled(id: number): JobRow | null {
    const result = markCancelledStmt.run(NOW_SECONDS(), id);
    if (result.changes !== 1) return null;
    return findByIdStmt.get(id) ?? null;
  }

  // Bulk cancel — single-TX-friendly. Empty array short-circuits
  // BEFORE any SQL execution (defends against `IN ()` syntax error). Status
  // guard `IN ('queued','encoding')` skips already-terminal rows so callers
  // don't need a pre-filter pass.
  function markCancelledBulk(ids: number[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const stmt = db.prepare(
      `UPDATE job SET status = 'cancelled', finished_at = ?
       WHERE id IN (${placeholders}) AND status IN ('queued','encoding')`,
    );
    const result = stmt.run(NOW_SECONDS(), ...ids);
    return result.changes;
  }

  // Atomic cancel-all wrapper. Wraps markCancelledBulk +
  // injected bulkSetFileStatusToPending in a single db.transaction() so the
  // queue and file row mutations commit together. Single-process orchestrator
  // invariant means the only race is with concurrent scan/trash flows; status
  // guards inside both bulk SQLs neutralize that.
  function cancelJobsAndPendFilesTx(
    jobIds: number[],
    fileIds: number[],
    expectedFileStates: readonly FileStatus[],
  ): { cancelled: number; fileChanges: number } {
    if (!deps) {
      throw new Error(
        'jobRepo.cancelJobsAndPendFilesTx requires JobRepoDeps.bulkSetFileStatusToPending — wire via makeJobRepo(db, deps)',
      );
    }
    if (jobIds.length === 0 && fileIds.length === 0) {
      return { cancelled: 0, fileChanges: 0 };
    }
    const bulkSetFileStatusToPending = deps.bulkSetFileStatusToPending;
    const tx = db.transaction((): { cancelled: number; fileChanges: number } => {
      const cancelled = markCancelledBulk(jobIds);
      const fileChanges = bulkSetFileStatusToPending(fileIds, expectedFileStates);
      return { cancelled, fileChanges };
    });
    return tx();
  }

  function listActive(order: QueueOrder = DEFAULT_QUEUE_ORDER): JobRow[] {
    return withQueryTiming('jobRepo.listActive', () => listActiveStmts[order].all());
  }

  function listRecent(limit: number): JobRow[] {
    // audit-added S9: clamp [1, 1000] defends against pathological clients.
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 1000);
    return listRecentStmt.all(safeLimit);
  }

  // Status-group filter for the Queue page.
  // 'completed' = all 4 terminal states; 'cancelled' = cancelled+interrupted.
  // 'failed' is ['failed'] alone (previously ['failed','cancelled','interrupted']).
  // The split-layout completed-pane chips done/failed/cancelled need disjoint groups so the
  // operator can no longer misread a user-cancelled job as an encoder-failed one.
  function statusesFor(
    group: 'all' | 'active' | 'completed' | 'done' | 'failed' | 'cancelled',
  ): string[] | null {
    if (group === 'active') return ['queued', 'encoding'];
    if (group === 'completed') return ['done', 'failed', 'cancelled', 'interrupted'];
    if (group === 'done') return ['done'];
    if (group === 'failed') return ['failed'];
    if (group === 'cancelled') return ['cancelled', 'interrupted'];
    return null; // all
  }

  function listRecentPaginated(opts: {
    page: number;
    size: number;
    statusGroup?: 'all' | 'active' | 'completed' | 'done' | 'failed' | 'cancelled';
  }): { rows: JobRow[]; total: number } {
    const safeSize = Math.min(Math.max(1, Math.floor(opts.size)), 1000);
    const safePage = Math.max(1, Math.floor(opts.page));
    const offset = (safePage - 1) * safeSize;
    const group = opts.statusGroup ?? 'all';
    const statuses = statusesFor(group);
    if (statuses === null) {
      const rows = listRecentPaginatedStmt.all(safeSize, offset);
      const total = countAllJobsStmt.get()?.n ?? 0;
      return { rows, total };
    }
    const placeholders = statuses.map(() => '?').join(',');
    const rowStmt = db.prepare<unknown[], JobRow>(
      `SELECT * FROM job WHERE status IN (${placeholders})
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    );
    const countStmt = db.prepare<unknown[], { n: number }>(
      `SELECT COUNT(*) as n FROM job WHERE status IN (${placeholders})`,
    );
    const rows = rowStmt.all(...statuses, safeSize, offset);
    const total = countStmt.get(...statuses)?.n ?? 0;
    return { rows, total };
  }

  function findByFileId(file_id: number): JobRow | undefined {
    return findByFileIdStmt.get(file_id);
  }

  function countByStatus(status: JobStatus): number {
    return withQueryTiming('jobRepo.countByStatus', () => {
      const row = countByStatusStmt.get(status);
      return row?.n ?? 0;
    });
  }

  function peekQueued(limit: number, order: QueueOrder = DEFAULT_QUEUE_ORDER): JobRow[] {
    // Same clamp pattern as listRecent.
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 1000);
    return peekQueuedStmts[order].all(safeLimit);
  }

  function claimById(id: number): JobRow | undefined {
    // Atomic select-then-update mirroring claimNext but for a specific id.
    // better-sqlite3 transactions are synchronous + immediate; the UPDATE's
    // WHERE-clause `status = 'queued'` is what makes this race-safe (returns
    // undefined when another claimer already moved the row out of 'queued').
    const claim = db.transaction((): JobRow | undefined => {
      const result = claimByIdUpdateStmt.run(NOW_SECONDS(), id);
      if (result.changes !== 1) return undefined;
      return findByIdStmt.get(id);
    });
    return claim();
  }

  function setEncoder(id: number, encoder: string): JobRow | null {
    const result = setEncoderStmt.run(encoder, id);
    if (result.changes !== 1) return null;
    return findByIdStmt.get(id) ?? null;
  }

  function setCrf(id: number, crf: number | null): JobRow | null {
    const result = setCrfStmt.run(crf, id);
    if (result.changes !== 1) return null;
    return findByIdStmt.get(id) ?? null;
  }

  function setPresetUsed(id: number, preset: string | null): JobRow | null {
    const result = setPresetUsedStmt.run(preset, id);
    if (result.changes !== 1) return null;
    return findByIdStmt.get(id) ?? null;
  }

  function moveBefore(
    jobId: number,
    beforeJobId: number | null,
    order: QueueOrder,
  ): MoveBeforeResult {
    const tx = db.transaction((): MoveBeforeResult => {
      const wanted = beforeJobId === null ? [jobId] : [jobId, beforeJobId];
      const unknown = wanted.filter((id) => jobStatusStmt.get(id) === undefined);
      if (unknown.length > 0) return { unknown };
      const conflict = wanted.filter((id) => jobStatusStmt.get(id)?.status !== 'queued');
      if (conflict.length > 0) return { conflict };

      const current = queuedIdsStmts[order].all();
      const fromIndex = current.findIndex((r) => r.id === jobId);
      const moved = current[fromIndex];
      const list = current.filter((r) => r.id !== jobId);
      const insertAt =
        beforeJobId === null ? list.length : list.findIndex((r) => r.id === beforeJobId);
      list.splice(insertAt, 0, moved);

      let lastPinned = -1;
      list.forEach((r, i) => {
        if (r.queue_pinned === 1) lastPinned = i;
      });
      const k = Math.max(insertAt, lastPinned);
      for (let i = 0; i <= k; i++) {
        if (setQueuedPositionStmt.run(i, list[i].id).changes !== 1) {
          throw new ReorderRollback([list[i].id]);
        }
      }
      return {
        ok: true,
        fromIndex,
        toIndex: insertAt,
        pinnedCount: k + 1,
        queueLength: list.length,
      };
    });
    try {
      return tx();
    } catch (err) {
      if (err instanceof ReorderRollback) return { conflict: err.conflictingJobIds };
      throw err;
    }
  }

  function enqueue(
    file_id: number,
    encoder: string,
    expectedFileVersion: number,
    crf: number | null,
    force_container?: string | null,
  ): JobRow | null {
    if (!deps) {
      throw new Error(
        'jobRepo.enqueue requires JobRepoDeps.setFileStatus — wire via makeJobRepo(db, deps)',
      );
    }
    const setStatus = deps.setFileStatus;
    // Wrap both writes so a stale file.version (or active-job conflict) rolls
    // back the partial INSERT — no half-state where job exists but file is still
    // 'pending'. better-sqlite3 transactions auto-rollback on throw.
    const tx = db.transaction((): JobRow | null => {
      const job = create({ file_id, encoder, crf, force_container: force_container ?? null });
      if (!job) {
        throw new EnqueueRollback('active_job_exists');
      }
      const ok = setStatus(file_id, 'queued', expectedFileVersion);
      if (!ok) {
        throw new EnqueueRollback('file_version_stale');
      }
      return job;
    });
    try {
      return tx();
    } catch (err) {
      if (err instanceof EnqueueRollback) return null;
      throw err;
    }
  }

  return {
    create,
    claimNext,
    recoverStaleEncoding,
    markCompleted,
    markFailed,
    markCancelled,
    markCancelledBulk,
    cancelJobsAndPendFilesTx,
    listActive,
    listRecent,
    listRecentPaginated,
    findByFileId,
    findLatestDoneByFileId: (file_id: number) => findLatestDoneByFileIdStmt.get(file_id),
    findLatestByFileId: (file_id: number) => findLatestByFileIdStmt.get(file_id),
    findPreviousFinishedByFileId: (file_id: number, beforeJobId: number) =>
      findPreviousFinishedByFileIdStmt.get(file_id, beforeJobId),
    // setQueuedPositionStmt also pins the job.
    moveToFront: db.transaction((id: number): boolean => {
      if (findByIdStmt.get(id)?.status !== 'queued') return false;
      const min = minOtherQueuedPositionStmt.get(id)?.m ?? null;
      if (min !== null && min <= 0) shiftOtherQueuedStmt.run(id);
      const target = min === null ? 0 : Math.max(0, min - 1);
      return setQueuedPositionStmt.run(target, id).changes === 1;
    }),
    listFinishedByFileId: (file_id: number, uptoJobId: number, limit: number) =>
      listFinishedByFileIdStmt.all(file_id, uptoJobId, limit),
    markInterruptedFailed: (id: number, errorMsg: string): JobRow | null =>
      markInterruptedFailedStmt.run(errorMsg, id).changes === 1
        ? (findByIdStmt.get(id) ?? null)
        : null,
    setInterruptedNote: (id: number, note: string): boolean =>
      setInterruptedNoteStmt.run(note, id).changes === 1,
    runInTransaction: <T>(fn: () => T): T => db.transaction(fn)(),
    enqueue,
    countByStatus,
    setEncoder,
    setCrf,
    setPresetUsed,
    peekQueued,
    claimById,
    findById: (id: number) => findByIdStmt.get(id),
    moveBefore,
    clearManualOrder: (): number => clearManualOrderStmt.run().changes,
    countPinnedQueued: (): number => countPinnedQueuedStmt.get()?.n ?? 0,
  };
}

// Internal sentinel used to roll back the enqueue transaction. Only thrown
// inside the tx body and caught immediately afterwards — never escapes the
// repo module.
class EnqueueRollback extends Error {
  constructor(public readonly kind: 'active_job_exists' | 'file_version_stale') {
    super(`enqueue rolled back: ${kind}`);
  }
}

// Sentinel for a moveBefore rollback. Carries the jobIds whose status was no
// longer 'queued' at UPDATE time so the caller can return them as
// conflictingJobIds in the 409 response.
class ReorderRollback extends Error {
  constructor(public readonly conflictingJobIds: number[]) {
    super(`reorder rolled back: ${conflictingJobIds.length} conflict(s)`);
  }
}
