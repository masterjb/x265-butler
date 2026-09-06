-- Plan 14-01 (Phase 14 foundation): Multi-Share schema + Backfill.
-- See internal design notes §Migration + Backfill for rationale.
--
-- 1. CREATE shares table — operator-managed share definitions.
-- 2. ALTER file ADD share_id FK (ON DELETE SET NULL → orphan-no-share bucket).
-- 3. CREATE INDEX idx_file_share_id BEFORE Backfill (speeds UPDATE … WHERE share_id IS NULL).
-- 4. INSERT "Library" share from legacy settings (conditional — skipped on empty/deleted scan_root).
-- 5. UPDATE file SET share_id via longest-prefix-match against the single inserted share.
--
-- Atomic via migrate.ts:63-66 db.transaction wrapper — partial failure rolls back as a unit.
-- Legacy setting rows scan_root/min_size_mb/extensions/max_depth REMAIN — drop deferred to 14-04.

CREATE TABLE shares (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL UNIQUE,
  path            TEXT    NOT NULL UNIQUE,
  min_size_mb     INTEGER NOT NULL CHECK (min_size_mb >= 0),
  extensions_csv  TEXT    NOT NULL,
  max_depth       INTEGER CHECK (max_depth IS NULL OR max_depth >= 0),
  created_at      INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  updated_at      INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

ALTER TABLE file ADD COLUMN share_id INTEGER REFERENCES shares(id) ON DELETE SET NULL;

CREATE INDEX idx_file_share_id ON file(share_id);

INSERT INTO shares (name, path, min_size_mb, extensions_csv, max_depth, created_at, updated_at)
SELECT
  'Library',
  (SELECT value FROM setting WHERE key='scan_root'),
  CAST(COALESCE((SELECT value FROM setting WHERE key='min_size_mb'), '50') AS INTEGER),
  COALESCE((SELECT value FROM setting WHERE key='extensions'), 'mp4,mkv,avi,mov,m4v,webm,ts,m2ts,wmv'),
  CASE
    WHEN (SELECT value FROM setting WHERE key='max_depth') IS NULL THEN NULL
    ELSE CAST((SELECT value FROM setting WHERE key='max_depth') AS INTEGER)
  END,
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER)
WHERE EXISTS (SELECT 1 FROM setting WHERE key='scan_root' AND value <> '');

-- audit-fix:SR1 — CTE-hoist removes 3× repeated subquery, planner evaluates
-- library once for the whole UPDATE pass (matters on 10k+ corpora per CONTEXT R1).
WITH library AS (SELECT id, path FROM shares ORDER BY id LIMIT 1)
UPDATE file
SET share_id = (SELECT id FROM library)
WHERE EXISTS (SELECT 1 FROM library)
  AND (
    file.path = (SELECT path FROM library)
    OR file.path LIKE (SELECT path FROM library) || '/%'
  );
