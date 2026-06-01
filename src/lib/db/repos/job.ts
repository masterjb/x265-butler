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

type Db = InstanceType<typeof Database>;

const NOW_SECONDS = (): number => Math.floor(Date.now() / 1000);

// audit-added S2: DI for the OCC-aware fileRepo.setStatus, used inside the
// transactional `enqueue` helper. Avoids a circular import between the job
// and file repo modules.
//
// 05-09 audit M2: bulkSetFileStatusToPending DI wires fileRepo's bulk helper
// into the cancelJobsAndPendFilesTx atomic-batch path so cancel-all happens
// in ONE TX (markCancelledBulk + bulk file→pending → all-or-nothing).
export interface JobRepoDeps {
  setFileStatus(id: number, status: FileStatus, expectedVersion: number): boolean;
  bulkSetFileStatusToPending(ids: number[], expectedStates: readonly FileStatus[]): number;
}

export interface JobRepo {
  create(input: JobCreateInput): JobRow | null;
  claimNext(): JobRow | undefined;
  // audit-added M1: orphaned-encoding recovery on orchestrator startup.
  recoverStaleEncoding(now: number, staleThresholdSeconds: number): number;
  markCompleted(id: number, input: JobCompleteInput): JobRow | null;
  markFailed(id: number, input: JobFailInput): JobRow | null;
  // audit-added M2: terminal-state guard.
  markCancelled(id: number): JobRow | null;
  // 05-09 audit M2: bulk cancel for /api/queue/cancel-all single-TX path.
  // Single SQL UPDATE with WHERE id IN (...) AND status IN ('queued','encoding').
  // Returns affected row count. Empty array = NO SQL execution → returns 0.
  markCancelledBulk(ids: number[]): number;
  // 05-09 audit M2: atomic bulk cancel + file→pending wrapped in a single
  // db.transaction(). All-or-nothing — both writes commit together OR neither.
  // Empty arrays → NO TX execution → returns {cancelled:0, fileChanges:0}.
  cancelJobsAndPendFilesTx(
    jobIds: number[],
    fileIds: number[],
    expectedFileStates: readonly FileStatus[],
  ): { cancelled: number; fileChanges: number };
  listActive(): JobRow[];
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
  // 05-08 B4: latest `done` job row for self-heal V2 payload reconstruction.
  // Returns the most-recent successful encode (for selfHealSidecar's V2 path).
  // Pre-0012 legacy rows return `crf: null`; the caller degrades to V1 then.
  findLatestDoneByFileId(file_id: number): JobRow | undefined;
  // 12-03 inline-extend Route-1: latest job row regardless of status for
  // operator-facing Detail-Panel. Failed / cancelled jobs ARE visible so a
  // pinned preset that didn't make it through (e.g. output_path_exists) is
  // still surfaced to the operator.
  findLatestByFileId(file_id: number): JobRow | undefined;
  // audit-added S2: transactional create + setFileStatus, requires JobRepoDeps.
  // 05-08 B4: crf threaded through; routes pass `null` (encoder not yet
  // resolved); orchestrator pin paths pass the resolved value; requestStopAll
  // re-queue passes the prior row's crf to preserve the encode intent.
  enqueue(
    file_id: number,
    encoder: string,
    expectedFileVersion: number,
    crf: number | null,
    force_container?: string | null,
  ): JobRow | null;
  // audit-added M2 (02-03): exact count by status — replaces
  // listRecent(500).filter(...) which silently undercounts past 500 rows
  // (Library bulk-enqueue scenario). Single SELECT COUNT(*) WHERE status = ?.
  countByStatus(status: JobStatus): number;
  // audit-added M4 (03-01): orchestrator writes the RESOLVED encoder back
  // AT DISPATCH (after auto-detect / fallback resolution), before any ffmpeg
  // spawn. Guarantees job.encoder reflects what actually ran, not the
  // enqueue-time intent. Caller MUST pass an EncoderId-validated string;
  // this method does NOT validate.
  setEncoder(id: number, encoder: string): JobRow | null;
  // 05-08 B4: orchestrator dispatch persists the resolved CRF value so the
  // commit-step sidecar V2 payload (and any restart-from-DB self-heal) can
  // reconstruct the encode intent. SQL CHECK constrains 0..51 OR NULL; this
  // method does not re-validate — caller already resolves from settings.
  setCrf(id: number, crf: number | null): JobRow | null;
  // 12-03 (migration 0025): orchestrator dispatch persists the resolved
  // preset_<encoder> value alongside setCrf + setEncoder. Allowed for queued +
  // encoding rows so a mid-flow flip is valid; terminal rows are guarded
  // by status check. Free-form string; caller already Catalog-validated.
  setPresetUsed(id: number, preset: string | null): JobRow | null;
  // audit-added M4 (03-02): peek queued rows WITHOUT claiming + atomic claim by id.
  // Multi-slot orchestrator uses peek+filter+claim to skip saturated-encoder jobs
  // without permanent removal from the queue. Default limit 100 per audit M4 in
  // 03-02 PLAN — covers >99% of operator workloads (typical bulk-enqueue ≤50).
  peekQueued(limit: number): JobRow[];
  claimById(id: number): JobRow | undefined;
  // 05-03 audit M2: sweep needs to skip active jobs.
  findById(id: number): JobRow | undefined;
  // 05-12 (B3 Queue Reorder): atomically rewrite queue_position for a list of
  // queued jobIds. Returns { applied } on success or { conflict } when any id
  // is no longer status='queued' at TX time (race against claimNext). Empty
  // input -> no-op { applied: [] }. Caller MUST validate duplicates +
  // existence pre-flight; this method does NOT.
  reorderQueueTx(
    orderedJobIds: number[],
  ): { applied: Array<{ jobId: number; queuePosition: number }> } | { conflict: number[] };
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
  // 05-12 (migration 0014): queue_position auto-assigned to MAX(queue_position) + 1
  // over status='queued' rows, all inside one INSERT statement. better-sqlite3
  // is single-process + single-writer; the COALESCE subquery + INSERT execute
  // as one statement, making the assignment race-free against any other writer
  // in the same DB connection. Empty queue -> COALESCE returns 1.
  const insertStmt = db.prepare(
    `INSERT INTO job (file_id, status, encoder, created_at, crf, queue_position, force_container)
     VALUES (?, 'queued', ?, ?, ?, COALESCE((SELECT MAX(queue_position) + 1 FROM job WHERE status = 'queued'), 1), ?)`,
  );
  const findByIdStmt = db.prepare<[number], JobRow>('SELECT * FROM job WHERE id = ?');
  // 05-12: pick order now governed by queue_position (operator-controlled).
  // Tie-break preserves existing (created_at, id) ASC semantics; backfill in
  // migration 0014 makes the change monotone for the initial state.
  const claimSelectStmt = db.prepare<[], { id: number }>(
    "SELECT id FROM job WHERE status = 'queued' ORDER BY queue_position ASC, created_at ASC, id ASC LIMIT 1",
  );
  const claimUpdateStmt = db.prepare(
    "UPDATE job SET status = 'encoding', started_at = ? WHERE id = ? AND status = 'queued'",
  );
  const recoverStaleStmt = db.prepare(
    "UPDATE job SET status = 'interrupted', finished_at = ? WHERE status = 'encoding' AND started_at IS NOT NULL AND started_at <= ?",
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
  const listActiveStmt = db.prepare<[], JobRow>(
    "SELECT * FROM job WHERE status IN ('queued','encoding') ORDER BY queue_position ASC, created_at ASC, id ASC",
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
  // audit-added M2 (02-03): exact COUNT for /api/queue/status pendingJobs +
  // POST /api/queue queue.updated emit + orchestrator queue.updated emit.
  const countByStatusStmt = db.prepare<[string], { n: number }>(
    'SELECT COUNT(*) as n FROM job WHERE status = ?',
  );
  // audit-added M4 (03-01): orchestrator dispatch write-back of resolved encoder.
  const setEncoderStmt = db.prepare('UPDATE job SET encoder = ? WHERE id = ?');
  // 05-08 B4: dispatch write-back of the resolved CRF value (companion to
  // setEncoder). Allowed for queued + encoding rows so a mid-flow flip is
  // valid; terminal rows are guarded by status check.
  const setCrfStmt = db.prepare(
    "UPDATE job SET crf = ? WHERE id = ? AND status IN ('queued','encoding')",
  );
  // 12-03 migration 0025: dispatch write-back of resolved preset (companion
  // to setCrf + setEncoder). Same status guard.
  const setPresetUsedStmt = db.prepare(
    "UPDATE job SET preset_used = ? WHERE id = ? AND status IN ('queued','encoding')",
  );
  // 05-08 B4: latest done row per file_id for selfHealSidecar V2 payload.
  const findLatestDoneByFileIdStmt = db.prepare<[number], JobRow>(
    "SELECT * FROM job WHERE file_id = ? AND status = 'done' ORDER BY finished_at DESC, id DESC LIMIT 1",
  );
  // 12-03 inline-extend Route-1: latest job row per file_id REGARDLESS of
  // status — for operator-facing Detail-Panel that needs to show the most
  // recent encode attempt (including failed/cancelled), so a pinned preset
  // setting is visible even when the encode failed (e.g. output_path_exists).
  // Done-jobs prefer finished_at; non-done rows fall back to created_at.
  const findLatestByFileIdStmt = db.prepare<[number], JobRow>(
    'SELECT * FROM job WHERE file_id = ? ORDER BY COALESCE(finished_at, started_at, created_at) DESC, id DESC LIMIT 1',
  );
  // audit-added M4 (03-02): peek queued rows WITHOUT claiming.
  const peekQueuedStmt = db.prepare<[number], JobRow>(
    "SELECT * FROM job WHERE status = 'queued' ORDER BY queue_position ASC, created_at ASC, id ASC LIMIT ?",
  );
  // audit-added M4 (03-02): atomic claim by specific id (handles claim races).
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

  function claimNext(): JobRow | undefined {
    const claim = db.transaction((): JobRow | undefined => {
      const candidate = claimSelectStmt.get();
      if (!candidate) return undefined;
      const result = claimUpdateStmt.run(NOW_SECONDS(), candidate.id);
      if (result.changes !== 1) return undefined;
      return findByIdStmt.get(candidate.id);
    });
    return claim();
  }

  function recoverStaleEncoding(now: number, staleThresholdSeconds: number): number {
    const cutoff = now - staleThresholdSeconds;
    const result = recoverStaleStmt.run(now, cutoff);
    return result.changes;
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

  // 05-09 audit M2: bulk cancel — single-TX-friendly. Empty array short-circuits
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

  // 05-09 audit M2: atomic cancel-all wrapper. Wraps markCancelledBulk +
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

  function listActive(): JobRow[] {
    return withQueryTiming('jobRepo.listActive', () => listActiveStmt.all());
  }

  function listRecent(limit: number): JobRow[] {
    // audit-added S9: clamp [1, 1000] defends against pathological clients.
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 1000);
    return listRecentStmt.all(safeLimit);
  }

  // 05-bonus: status-group filter for Queue page (Option B).
  // 05-12 B3 (B-layout): added 'completed' (all 4 terminal) + 'cancelled' (cancelled+interrupted).
  // 'failed' semantics CHANGED — now ['failed'] alone (was ['failed','cancelled','interrupted']).
  // The split-layout completed-pane chips done/failed/cancelled need disjoint groups so the
  // operator can no longer misread a user-cancelled job as an encoder-failed one (S10 finding).
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

  function peekQueued(limit: number): JobRow[] {
    // audit S9 / M4-03-02: same clamp pattern as listRecent.
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 1000);
    return peekQueuedStmt.all(safeLimit);
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

  // 05-12 (B3 Queue Reorder): rewrite-position UPDATE statement reused inside
  // the reorderQueueTx transaction. The status guard `AND status = 'queued'`
  // is the authoritative race-safety net against claimNext() — a row that
  // moved to 'encoding' (or any terminal state) between the route's
  // pre-check `peekQueued` snapshot and this UPDATE returns changes=0, which
  // we surface as a conflict and roll back the entire TX.
  const reorderUpdateStmt = db.prepare(
    "UPDATE job SET queue_position = ? WHERE id = ? AND status = 'queued'",
  );

  function reorderQueueTx(
    orderedJobIds: number[],
  ): { applied: Array<{ jobId: number; queuePosition: number }> } | { conflict: number[] } {
    if (orderedJobIds.length === 0) return { applied: [] };
    const tx = db.transaction((): { applied: Array<{ jobId: number; queuePosition: number }> } => {
      const applied: Array<{ jobId: number; queuePosition: number }> = [];
      const conflict: number[] = [];
      orderedJobIds.forEach((jobId, idx) => {
        const result = reorderUpdateStmt.run(idx + 1, jobId);
        if (result.changes !== 1) conflict.push(jobId);
        else applied.push({ jobId, queuePosition: idx + 1 });
      });
      if (conflict.length > 0) {
        // Throwing rolls back the partial UPDATEs (better-sqlite3 auto-rollback).
        throw new ReorderRollback(conflict);
      }
      return { applied };
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
    enqueue,
    countByStatus,
    setEncoder,
    setCrf,
    setPresetUsed,
    peekQueued,
    claimById,
    findById: (id: number) => findByIdStmt.get(id),
    reorderQueueTx,
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

// 05-12 (B3 Queue Reorder): sentinel for reorderQueueTx rollback. Carries the
// list of jobIds whose status was no longer 'queued' at UPDATE time so the
// caller can return them as conflictingJobIds in the 409 response.
class ReorderRollback extends Error {
  constructor(public readonly conflictingJobIds: number[]) {
    super(`reorder rolled back: ${conflictingJobIds.length} conflict(s)`);
  }
}
