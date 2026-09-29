-- 01-03 initial schema: file + setting entities for the scan inventory.
-- See internal design notes §2.4 for design rationale.
-- audit-added S10: numeric CHECK constraints on size/bitrate/duration/width/height.

CREATE TABLE file (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  path              TEXT NOT NULL UNIQUE,
  size_bytes        INTEGER NOT NULL CHECK (size_bytes >= 0),
  mtime             INTEGER NOT NULL,
  content_hash      TEXT NOT NULL,
  codec             TEXT,
  bitrate           INTEGER CHECK (bitrate IS NULL OR bitrate >= 0),
  duration_seconds  REAL    CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  width             INTEGER CHECK (width IS NULL OR width >= 0),
  height            INTEGER CHECK (height IS NULL OR height >= 0),
  container         TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  last_scanned_at   INTEGER NOT NULL,
  created_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  updated_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

CREATE INDEX idx_file_content_hash ON file(content_hash);
CREATE INDEX idx_file_status       ON file(status);

CREATE TABLE setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

INSERT OR IGNORE INTO setting (key, value) VALUES
  ('scan_root',  '/media'),
  ('min_size_mb', '50'),
  ('extensions', 'mp4,mkv,avi,mov,m4v,webm,ts,m2ts,wmv'),
  ('max_depth',  '12');
