-- Phase 3 Plan 03-01: encoder selection + concurrency + per-encoder CRF defaults.
-- Pure-data migration, no schema change. INSERT OR IGNORE preserves operator-set
-- values across MIGRATION RE-RUNS (audit S9 — forward-only runner re-applies if
-- the schema_migrations row is missing on disaster recovery).
-- See internal design notes for rationale.

INSERT OR IGNORE INTO setting (key, value) VALUES
  ('encoder',       'auto'),
  ('concurrency',   'auto'),
  ('crf_libx265',   '23'),
  ('crf_nvenc',     '23'),
  ('crf_qsv',       '22'),
  ('crf_vaapi',     '22');
