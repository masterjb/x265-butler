-- 04-02: blocklist_entry table — operator-managed skip pipeline step 7.
-- Exclusivity invariant: each row is EITHER pinned to a file_id OR a
-- path_pattern. file_id rows survive renames via FK CASCADE; pattern rows
-- catch subtrees (e.g. /movies/Samples/*).
--
-- See internal design notes §2 for design rationale.

CREATE TABLE blocklist_entry (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id       INTEGER,
  path_pattern  TEXT,
  reason        TEXT NOT NULL DEFAULT 'operator',
  created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  CHECK (
    (file_id IS NOT NULL AND path_pattern IS NULL)
    OR (file_id IS NULL AND path_pattern IS NOT NULL)
  ),
  CHECK (path_pattern IS NULL OR length(path_pattern) <= 4096),
  -- audit-added S5: forward-compat — SQL accepts all 3 reason values.
  -- v1 API endpoints only allow 'operator'; future Plan 04-03 + Phase 5
  -- auto-blocklisting will populate 'auto-failure' / 'auto-skip' WITHOUT
  -- requiring a future migration.
  CHECK (reason IN ('operator', 'auto-failure', 'auto-skip')),
  FOREIGN KEY (file_id) REFERENCES file(id) ON DELETE CASCADE
);

CREATE INDEX idx_blocklist_file_id ON blocklist_entry(file_id);
CREATE INDEX idx_blocklist_created_at ON blocklist_entry(created_at);

-- audit-added M1: partial UNIQUE INDEX on file_id prevents race-condition
-- duplicate inserts under concurrent POST. Pattern from 02-01 audit M4
-- (job table partial UNIQUE on file_id WHERE status IN active states).
-- BlocklistRepo.add catches SQLITE_CONSTRAINT_UNIQUE + returns existing row.
CREATE UNIQUE INDEX idx_blocklist_file_id_unique
  ON blocklist_entry(file_id)
  WHERE file_id IS NOT NULL;
