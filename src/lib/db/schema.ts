// audit-added S13: compile-time guard for the file.status enum.
// SQLite cannot ALTER CHECK constraints without table rebuild, so the DB
// stays free-text on `status`; the literal-union enforces at TypeScript
// boundaries (repo input shapes, orchestrator return types).
export type FileStatus =
  | 'pending'
  | 'queued'
  | 'encoding'
  | 'done-smaller'
  | 'done-larger'
  | 'skipped-codec'
  | 'skipped-bitrate'
  | 'skipped-suffix'
  | 'skipped-tag'
  | 'skipped-sidecar'
  | 'skipped-blocklist'
  // 04-02: blocklist_entry types co-located with FileStatus union for repo+API consumers.
  | 'failed'
  | 'blocklisted'
  | 'interrupted'
  // 05-bonus: row's path no longer exists on disk at scan time. Soft-deleted —
  // Library default-list excludes these; explicit filter or operator toggle
  // surfaces them. Auto-revive: upsertByPath flips back to 'pending' when the
  // file reappears on disk. FK CASCADE NOT triggered → job/blocklist/trash
  // history stays intact.
  | 'vanished'
  // 05-13: 3-bucket verdict split + sidecar-driven skip evolution.
  // 'done-not-worth' = encode succeeded but savings < min_savings_percent;
  // output discarded, source kept, sidecar written next to source for
  // scan-time short-circuit. 'done-already-evaluated' = scan-time verdict
  // when skip-pipeline finds prior-evaluation evidence (sidecar.outcome ∈
  // {done-larger, done-not-worth} OR step-4 DB-hash enrichment for
  // pre-05-13 corpus / read-only-source soft-degrade case). FileStatus
  // remains TS-only literal-union — no SQL CHECK, no migration. See
  // internal design notes §5–§6: sidecar is the
  // file-traveling fallback signal; never touch MKV body during self-heal.
  | 'done-not-worth'
  | 'done-already-evaluated';

export interface FileRow {
  id: number;
  path: string;
  size_bytes: number;
  mtime: number;
  content_hash: string;
  codec: string | null;
  bitrate: number | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  container: string | null;
  status: FileStatus;
  last_scanned_at: number;
  created_at: number;
  updated_at: number;
  // 02-01: OCC bump on every fileRepo.setStatus call.
  version: number;
  // 10-02 E-D1: per-file container override. NULL = inherit global output_container setting.
  container_override: 'mkv' | 'mp4' | 'match-source' | null;
  // 14-01: per-file Share-Anker via FK shares(id) ON DELETE SET NULL.
  // Pre-0026 legacy rows = NULL until next-scan picks them up (14-02).
  // ON DELETE SET NULL → orphaned-no-share bucket per R4.
  share_id: number | null;
}

export interface FileUpsertInput {
  path: string;
  size_bytes: number;
  mtime: number;
  content_hash: string;
  codec: string | null;
  bitrate: number | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  container: string | null;
  last_scanned_at: number;
  // 14-02: per-share anchor at write-time. Orchestrator passes the current
  // shareRepo loop-iteration id; legacy callers (none post-14-02 — /api/scan
  // is the only caller) pass null when shareRepo is empty.
  share_id: number | null;
}

export interface SettingRow {
  key: string;
  value: string;
  updated_at: number;
}

// 02-01: encoding-loop schema — `job` + `trash_entry` tables introduced in
// migration 0002. JobStatus is the SQL-CHECK-enforced enum; FileStatus stays
// the broader literal union (file.status is set by orchestrator transitions).

export type JobStatus = 'queued' | 'encoding' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface JobRow {
  id: number;
  file_id: number;
  status: JobStatus;
  started_at: number | null;
  finished_at: number | null;
  encoder: string | null;
  // 05-08 B4 (migration 0012): quality-mode value (CRF for libx265, CQ for
  // hevc_nvenc, QP for hevc_qsv/hevc_vaapi). Range 0..51 enforced by SQL CHECK.
  // NULL for pre-0012 legacy rows AND for queued rows whose encoder has not
  // resolved yet (orchestrator dispatch writes the resolved value via setCrf
  // before ffmpeg spawn). Sidecar V2 commit step reads this back.
  crf: number | null;
  // 12-03 (migration 0025, Route-1 inline-extend): resolved preset persisted
  // at dispatch boundary via setPresetUsed. NULL for pre-0025 legacy rows +
  // for queued rows whose encoder has not resolved yet. Free-form TEXT —
  // Catalog-validation lives at orchestrator + zod boundary, NOT in DB.
  preset_used?: string | null;
  bytes_in: number | null;
  bytes_out: number | null;
  duration_ms: number | null;
  exit_code: number | null;
  error_msg: string | null;
  log_tail: string | null;
  created_at: number;
  // 05-12 (migration 0014): operator-controlled pick order. queue_position
  // 1..N for status='queued' rows; 0 (default) for any other status. The three
  // pick paths (claimSelect / peekQueued / listActive) now ORDER BY
  // queue_position ASC, created_at ASC, id ASC — backwards-compatible because
  // 0014 backfills queued rows from (created_at, id) ranking, so pre-0014
  // pick order is preserved post-migration.
  queue_position: number;
  // 10-03 E-D5 (migration 0018): explicit container override for force-retry.
  // NULL = inherit normal resolution chain (container_override → output_container).
  // Optional in TS: pre-0018 rows lack the column; runtime access guards with typeof check.
  force_container?: string | null;
}

// 05-12 (B3 Queue Reorder): repo-level input shape for reorderQueueTx.
// Caller validates duplicates + jobId existence + status='queued' pre-flight;
// reorderQueueTx returns { conflict } when any id is no longer 'queued' at
// TX time (race against claimNext).
export interface JobReorderInput {
  orderedJobIds: number[];
}

export interface JobCreateInput {
  file_id: number;
  encoder: string;
  // 05-08 B4: required at type level — `null` reserved for queued rows where
  // encoder has not resolved yet (typical at /api/queue + /api/scan enqueue
  // entry points). Production orchestrator dispatch path then writes the
  // resolved value via setCrf before spawn. SQL CHECK keeps `0..51 OR NULL`.
  crf: number | null;
  // 10-03 E-D5: optional force_container from retry API. Undefined → NULL in DB.
  force_container?: string | null;
}

export interface JobCompleteInput {
  bytes_in: number;
  bytes_out: number;
  duration_ms: number;
}

export interface JobFailInput {
  exit_code: number;
  error_msg: string;
  log_tail: string | null;
}

// 05-01: user rows — single-user optional auth (off by default).
export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: number;
  last_login_at: number | null;
}

export interface UserCreateInput {
  username: string;
  password_hash: string;
}

// 04-02: blocklist_entry rows. Each row is EITHER file-pinned (file_id set,
// path_pattern null) OR path-pattern (path_pattern set, file_id null) —
// CHECK constraint enforces exactly-one. FK CASCADE on file_id.
export type BlocklistReason = 'operator' | 'auto-failure' | 'auto-skip';

export interface BlocklistRow {
  id: number;
  file_id: number | null;
  path_pattern: string | null;
  reason: BlocklistReason;
  created_at: number;
}

export interface BlocklistAddInput {
  file_id?: number;
  path_pattern?: string;
  reason?: BlocklistReason;
}

export interface TrashEntryRow {
  id: number;
  file_id: number | null;
  original_path: string;
  trash_path: string;
  size_bytes: number;
  trashed_at: number;
  expires_at: number;
  restored_at: number | null;
}

export interface TrashEntryCreateInput {
  file_id: number;
  original_path: string;
  trash_path: string;
  size_bytes: number;
  retention_days: number;
}

// 01-03 CONTEXT.md §6.3 — orchestrator return shape.
// /api/scan augments this with `requestId` (audit S7) and `effectiveFilters`
// (audit S4) before responding to the client.
export interface ScanResult {
  rootPath: string;
  filesScanned: number;
  filesAdded: number;
  filesUpdated: number;
  filesUnchanged: number;
  filesFailed: number;
  // 05-bonus: rows previously known but absent from disk at this scan, marked
  // status='vanished'. Excludes rows whose status is encoding/queued/blocklisted
  // (operator-controlled state preserved).
  filesVanished: number;
  // 14-02: per-share counter aggregation. Present iff shareRepo.listAll() was
  // non-empty at scan start (empty-shares fallback omits this field).
  // Order matches shareRepo.listAll() (id ASC). Sum across the array equals
  // the top-level counter invariant (AC-5).
  byShare?: Array<{
    shareId: number;
    name: string;
    rootPath: string;
    filesScanned: number;
    filesAdded: number;
    filesUpdated: number;
    filesUnchanged: number;
    filesFailed: number;
  }>;
  durationMs: number;
  startedAt: number;
  finishedAt: number;
}

// 11-01: Encoder-Benchmark types — bench_run + bench_combo tables.

export type BenchMode = 'native-sweep' | 'vmaf-anchored';
export type BenchRunStatus = 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
export type BenchComboStatus = 'pending' | 'encoding' | 'complete' | 'failed' | 'skipped';
export type Top3Role = 'quality' | 'balanced' | 'size';

export interface BenchMatrixNativeSweep {
  encoders: string[];
  presets: string[];
  nativeValues: number[];
}

export interface BenchMatrixVmafAnchored {
  encoders: string[];
  presets: string[];
  vmafTargets: number[];
}

export type BenchMatrix = BenchMatrixNativeSweep | BenchMatrixVmafAnchored;

export interface BenchRunRow {
  id: number;
  mode: BenchMode;
  status: BenchRunStatus;
  fileIds: number[];
  matrix: BenchMatrix;
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

export interface BenchRunCreateInput {
  mode: BenchMode;
  fileIds: number[];
  matrix: BenchMatrix;
  sampleCount?: number;
  sampleDurationSec?: number;
  vmafBuckets?: number[];
  vmafModel?: string;
  actorId?: number | null;
}

export interface BenchComboRow {
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
  // 11-02-FIX-V2 UAT-003: source-sample bytes for compression-ratio computation.
  // NULL on legacy rows (pre-migration 0021); aggregation skips nulls explicitly.
  source_sample_bytes: number | null;
  // 11-03: Pass-2 full-file verify metrics (migration 0022).
  // NULL until orchestrator.runFullFileVerify writes via markPass2Complete.
  pass2_vmaf: number | null;
  pass2_size_bytes: number | null;
  pass2_encode_seconds: number | null;
  pass2_completed_at: number | null;
  status: BenchComboStatus;
  error_reason: string | null;
  is_pareto: number;
  top3_role: Top3Role | null;
  created_at: number;
  completed_at: number | null;
}

export interface BenchComboCreateInput {
  file_id: number;
  encoder: string;
  preset: string | null;
  native_quality_param: string;
  native_quality_value: number;
  vmaf_target: number | null;
  sample_idx: number;
}

export interface AggregatedCombo {
  encoder: string;
  preset: string | null;
  native_quality_param: string;
  native_quality_value: number;
  vmaf_target: number | null;
  vmaf: number;
  sizeBytes: number;
  encodeSec: number;
  // 11-02-FIX-V2 UAT-003: averaged source-sample bytes across grouped raws.
  // null when ALL grouped raws have null source_sample_bytes (legacy data).
  // Mixed null + non-null: averaged over non-null subset only (audit M2 explicit null-skip).
  sourceSampleBytes: number | null;
  sampleIds: number[];
}

export interface AggregatedComboView extends AggregatedCombo {
  is_pareto: boolean;
  top3_role: Top3Role | null;
}

// 14-01: Multi-Share foundation. shares-Table introduced in migration 0026.
// share_id is file-row-derived: pipeline + skip + sidecar don't touch it,
// they propagate it via fileRepo upsert (planned for 14-02 scan-loop wire).
// FK ON DELETE SET NULL means orphaned files stay queryable in Library
// under the "no share" implicit bucket (R4 mitigation; 14-03 surfaces it).
export interface ShareRow {
  id: number;
  name: string;
  path: string;
  min_size_mb: number;
  extensions_csv: string;
  max_depth: number | null;
  created_at: number;
  updated_at: number;
}

export interface ShareCreateInput {
  name: string;
  path: string;
  min_size_mb: number;
  extensions_csv: string;
  max_depth: number | null;
}

export interface ShareUpdateInput {
  name?: string;
  path?: string;
  min_size_mb?: number;
  extensions_csv?: string;
  max_depth?: number | null;
}

// 14-03: share-axis filter shape used by ListOptions + LibraryQuery + repo
// signatures. Numeric id targets a specific share; the literal 'orphan' selects
// rows whose share_id IS NULL. `undefined` (no filter) is encoded by omission.
export type ShareIdFilter = number | 'orphan';
