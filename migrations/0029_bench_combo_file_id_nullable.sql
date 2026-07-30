-- Plan 47-03: bench_combo.file_id NOT NULL REFERENCES file(id) [NO ACTION]
--             ->  NULL REFERENCES file(id) ON DELETE SET NULL
--
-- WHY: a library entry held ONLY by a terminal bench run (complete/failed/
-- cancelled) was permanently undeletable — DELETE FROM file raised
-- SQLITE_CONSTRAINT_FOREIGNKEY because bench_combo was the single NO-ACTION FK
-- on file. With SET NULL the file row can go while the bench measurements
-- (vmaf / size_bytes / encode_seconds) survive with file_id IS NULL.
--
-- ============================================================================
-- FIRST TABLE REBUILD IN THIS REPO. Every prior migration was
-- `ALTER TABLE … ADD COLUMN`. Future rebuilds should follow this file.
-- ============================================================================
--
-- WHY NO `PRAGMA foreign_keys=OFF` (the textbook 12-step rebuild):
--   src/lib/db/index.ts:170-171 calls applyPragmas (foreign_keys = ON) BEFORE
--   migrate(db), and src/lib/db/migrate.ts:79-83 wraps every migration in
--   db.transaction(). `PRAGMA foreign_keys` is a NO-OP inside a transaction
--   (https://sqlite.org/pragma.html#pragma_foreign_keys), so the OFF/ON rebuild
--   is simply not available here. Reworking the runner to allow
--   outside-transaction migrations was rejected in D1: it touches all 29
--   migrations and strips their auto-rollback. This rebuild therefore MUST work
--   with FK enforcement ACTIVE.
--
-- INVARIANTS that make the FK-active rebuild safe (both verified 2026-07-29,
-- re-verify before copying this pattern):
--   1. `grep -rn "REFERENCES bench_combo" migrations/` is EMPTY -> bench_combo
--      has no child table -> DROP TABLE (step 3) violates no FK.
--   2. The schema contains no CREATE VIEW and no CREATE TRIGGER -> the
--      ALTER TABLE … RENAME TO in step 4 cannot damage a dependent object
--      (SQLite >= 3.25 rewrites references on RENAME).
--
-- Deliberately NOT used: PRAGMA legacy_alter_table, PRAGMA foreign_key_check
-- (the latter is powerless inside the transaction for what is guarded here, and
-- the self-healing CASE in step 2 makes it redundant).
--
-- FORWARD-ONLY. There is no 0030 rollback and this plan writes none: a NOT NULL
-- return would be undoable on a DB that already carries NULLed rows without
-- destroying bench results. A downgrade to a v2.43.x image simply omits this
-- file — the DB stays nullable and the old code blocks every bench reference
-- again. The severed file_id values are NOT reconstructable
-- (bench_run.file_ids_json holds the run level, not the per-combo mapping).

-- Step 1: new table. file_id nullable + ON DELETE SET NULL; run_id unchanged.
-- Column set is the sum of THREE migrations — 0020 (18 columns),
-- 0021 (source_sample_bytes) and 0022 (the four pass2_* columns) = 23 columns,
-- in their original physical order. A missing column here silently destroys
-- operator data.
CREATE TABLE bench_combo_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES bench_run(id) ON DELETE CASCADE,
  file_id INTEGER NULL REFERENCES file(id) ON DELETE SET NULL,
  encoder TEXT NOT NULL,
  preset TEXT,
  native_quality_param TEXT NOT NULL,
  native_quality_value INTEGER NOT NULL,
  vmaf_target REAL,
  sample_idx INTEGER NOT NULL,
  vmaf REAL,
  size_bytes INTEGER,
  encode_seconds REAL,
  status TEXT NOT NULL CHECK(status IN ('pending','encoding','complete','failed','skipped')),
  error_reason TEXT,
  is_pareto INTEGER NOT NULL DEFAULT 0,
  top3_role TEXT CHECK(top3_role IN ('quality','balanced','size') OR top3_role IS NULL),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  source_sample_bytes INTEGER NULL,
  pass2_vmaf REAL NULL,
  pass2_size_bytes INTEGER NULL,
  pass2_encode_seconds REAL NULL,
  pass2_completed_at INTEGER NULL
);

-- Step 1b: carry the AUTOINCREMENT high-water mark over BEFORE any row is
-- copied. DROP TABLE (step 3) deletes bench_combo's sqlite_sequence row; the
-- new table would otherwise derive its seq purely from the copied explicit ids
-- and would REUSE ids as soon as anything had been purged before. Since
-- 47-01/47-02 (bench-run purge -> CASCADE onto the combos) `seq > MAX(id)` is
-- the NORMAL state on operator DBs, not an edge case.
-- This works because an explicit-id INSERT into an AUTOINCREMENT table raises
-- seq to max(seq, inserted id) but never lowers it, and ALTER TABLE … RENAME TO
-- (step 4) renames the sqlite_sequence row along with the table.
-- sqlite_sequence is explicitly writable via INSERT/UPDATE/DELETE
-- (https://sqlite.org/autoinc.html). If no row exists (table never populated)
-- the INSERT … SELECT inserts nothing — the correct no-op.
-- NOT `INSERT OR REPLACE`: sqlite_sequence has neither PK nor UNIQUE on `name`,
-- so OR REPLACE would append a duplicate instead of replacing.
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'bench_combo_new', seq FROM sqlite_sequence WHERE name = 'bench_combo';

-- Step 2: copy. EXPLICIT column lists on BOTH sides, never SELECT * — the
-- 0021/0022 columns are physically appended and a positional copy breaks
-- silently the moment the order diverges.
-- file_id is remapped self-healingly: with FKs active the INSERT validates
-- immediately, so an old DB carrying an orphaned file_id — exactly the
-- reporter's DB state — would make this migration throw, migrate() would
-- rethrow, and THE CONTAINER WOULD NO LONGER BOOT. The CASE is not optional.
INSERT INTO bench_combo_new (
  id, run_id, file_id, encoder, preset, native_quality_param,
  native_quality_value, vmaf_target, sample_idx, vmaf, size_bytes,
  encode_seconds, status, error_reason, is_pareto, top3_role, created_at,
  completed_at, source_sample_bytes, pass2_vmaf, pass2_size_bytes,
  pass2_encode_seconds, pass2_completed_at
)
SELECT
  bc.id,
  bc.run_id,
  CASE WHEN EXISTS(SELECT 1 FROM file f WHERE f.id = bc.file_id)
       THEN bc.file_id ELSE NULL END,
  bc.encoder,
  bc.preset,
  bc.native_quality_param,
  bc.native_quality_value,
  bc.vmaf_target,
  bc.sample_idx,
  bc.vmaf,
  bc.size_bytes,
  bc.encode_seconds,
  bc.status,
  bc.error_reason,
  bc.is_pareto,
  bc.top3_role,
  bc.created_at,
  bc.completed_at,
  bc.source_sample_bytes,
  bc.pass2_vmaf,
  bc.pass2_size_bytes,
  bc.pass2_encode_seconds,
  bc.pass2_completed_at
FROM bench_combo bc;

-- Step 2b: row-count guard, BEFORE the destructive DROP. Tests run on synthetic
-- DBs, never on the operator's. These three statements turn a partial copy from
-- silent into loud: on a count mismatch the INSERT violates the CHECK,
-- db.exec(sql) throws, migrate.ts:79-83 rolls back the whole transaction
-- INCLUDING the schema_migrations row, and the container refuses to start with
-- `migration failed: 0029_… — CHECK constraint failed` on an UNCHANGED DB.
-- For the repo's first destructive migration a loud boot stop with an intact DB
-- beats silent data loss.
CREATE TEMP TABLE _m0029_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _m0029_guard (ok)
  SELECT CASE WHEN (SELECT COUNT(*) FROM bench_combo_new)
                 = (SELECT COUNT(*) FROM bench_combo)
              THEN 1 ELSE 0 END;
DROP TABLE _m0029_guard;

-- Step 3: drop the old table (FK-safe per invariant 1).
DROP TABLE bench_combo;

-- Step 4: rename into place (safe per invariant 2; also renames the
-- sqlite_sequence row written in step 1b).
ALTER TABLE bench_combo_new RENAME TO bench_combo;

-- Step 5: recreate both indexes verbatim from 0020:26-27. DROP TABLE took the
-- originals with it; without this countByRun (47-01) loses its index and the
-- purge path degrades to a full scan.
CREATE INDEX idx_bench_combo_run ON bench_combo(run_id);
CREATE INDEX idx_bench_combo_run_file ON bench_combo(run_id, file_id);
