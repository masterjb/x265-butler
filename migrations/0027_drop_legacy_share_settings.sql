-- Plan 14-04 (Phase 14 close): drop legacy single-share settings.
-- Source of truth shifted to the `shares` table (introduced in migration 0026).
-- Forward-only, idempotent: DELETE on absent rows is a no-op.
--
-- audit-added M2 (audit): SAFETY pre-check via temp-trigger pattern.
-- SQLite RAISE() is only valid inside trigger bodies (https://sqlite.org/lang_createtrigger.html),
-- so a `SELECT CASE … RAISE(ABORT, …) END` would not actually fire. We instead
-- plant a TEMP TRIGGER on a TEMP table; one INSERT trips the BEFORE INSERT
-- guard. When shares-table is empty AND legacy keys are still present (the
-- partial-rollback / forensic-snapshot scenario), the trigger RAISEs ABORT and
-- better-sqlite3 surfaces it as a SqliteError. migrate.ts:63-66 wraps each
-- db.exec(sql) in db.transaction(...), so the ABORT rolls back BOTH the would-
-- be DELETE and the schema_migrations row insert (version 27 not recorded).
--
-- migrate.ts owns the outer TX; BEGIN/COMMIT intentionally omitted here.
-- audit-fix (audit): legacy setting key is `extensions`
-- (per 0001_initial.sql:35 + 0026_shares_foundation.sql:33), NOT
-- `extensions_csv` (which is the new shares-table COLUMN name). The plan-text
-- conflated the two; this migration uses the correct legacy key.

CREATE TEMP TABLE _migration_0027_safety (placeholder INTEGER);

CREATE TEMP TRIGGER _migration_0027_safety_guard
BEFORE INSERT ON _migration_0027_safety
WHEN (SELECT COUNT(*) FROM shares) = 0
 AND (SELECT COUNT(*) FROM setting
      WHERE key IN ('scan_root', 'min_size_mb', 'extensions', 'max_depth')) > 0
BEGIN
  SELECT RAISE(ABORT, 'migration_0027_unsafe_shares_empty_legacy_present: run migration 0026 first to backfill shares from setting');
END;

INSERT INTO _migration_0027_safety (placeholder) VALUES (1);

DROP TRIGGER _migration_0027_safety_guard;
DROP TABLE _migration_0027_safety;

DELETE FROM setting WHERE key IN (
  'scan_root',
  'min_size_mb',
  'extensions',
  'max_depth'
);
