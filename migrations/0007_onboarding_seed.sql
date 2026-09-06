-- Phase 3 Plan 03-05: onboarding gate flag for first-run wizard.
-- INSERT OR IGNORE preserves operator-set value across MIGRATION RE-RUNS
-- (audit S9 pattern from migration 0005 — forward-only runner re-applies if
-- the schema_migrations row is missing on disaster recovery).
-- Pure-data migration, no schema change.

INSERT OR IGNORE INTO setting (key, value) VALUES
  ('onboarding_completed', 'false');
