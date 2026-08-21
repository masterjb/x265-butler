-- 02-01: encoding-loop foundation — job + trash_entry tables, file.version OCC,
-- 4 new seed settings (cache_pool_path, default_crf, min_savings_percent, trash_retention_days).
-- See internal design notes for design rationale.

-- audit-added (resolves 01-03 D3): version column for Optimistic Concurrency Control.
-- fileRepo.setStatus(id, status, expectedVersion) does:
--   UPDATE file SET status=?, version = version + 1 WHERE id=? AND version=?
-- Stale callers see changes === 0 and back off without overwriting fresher state.
ALTER TABLE file ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE job (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id      INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('queued','encoding','done','failed','cancelled','interrupted')),  -- audit-added S1
  started_at   INTEGER,
  finished_at  INTEGER,
  encoder      TEXT,
  bytes_in     INTEGER CHECK (bytes_in IS NULL OR bytes_in >= 0),
  bytes_out    INTEGER CHECK (bytes_out IS NULL OR bytes_out >= 0),
  duration_ms  INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  exit_code    INTEGER CHECK (exit_code IS NULL OR exit_code >= 0),
  error_msg    TEXT,
  log_tail     TEXT,
  created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  FOREIGN KEY (file_id) REFERENCES file(id) ON DELETE CASCADE
);

CREATE INDEX idx_job_file_id    ON job(file_id);
CREATE INDEX idx_job_status     ON job(status);
CREATE INDEX idx_job_created_at ON job(created_at);

-- audit-added M4: partial UNIQUE INDEX prevents double-enqueue at SQL layer.
-- Two simultaneous orchestrators trying to create active jobs for the same
-- file_id race; the second INSERT raises SQLITE_CONSTRAINT_UNIQUE which
-- jobRepo.create catches and surfaces as null return. Once a job moves to a
-- terminal state ('done'/'failed'/'cancelled'/'interrupted') the row leaves
-- the partial-index domain and a new active job for the same file is allowed.
CREATE UNIQUE INDEX idx_job_active_per_file ON job(file_id)
  WHERE status IN ('queued','encoding');

CREATE TABLE trash_entry (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id       INTEGER,
  original_path TEXT NOT NULL CHECK (length(original_path) <= 4096),  -- audit-added S6
  trash_path    TEXT NOT NULL UNIQUE CHECK (length(trash_path) <= 4096),  -- audit-added S6
  size_bytes    INTEGER NOT NULL CHECK (size_bytes >= 0),
  trashed_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  restored_at   INTEGER,
  FOREIGN KEY (file_id) REFERENCES file(id) ON DELETE SET NULL
);

CREATE INDEX idx_trash_expires_at ON trash_entry(expires_at);
CREATE INDEX idx_trash_file_id    ON trash_entry(file_id);

INSERT OR IGNORE INTO setting (key, value) VALUES
  ('cache_pool_path',      '/mnt/cache/x265-butler'),
  ('default_crf',          '23'),
  ('min_savings_percent',  '5'),
  ('trash_retention_days', '30');
