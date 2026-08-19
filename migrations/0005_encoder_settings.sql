-- Phase 3 Plan 03-01: encoder selection + concurrency + per-encoder CRF defaults.
-- Pure-data migration, no schema change. INSERT OR IGNORE preserves operator-set
-- values across MIGRATION RE-RUNS (audit S9 — forward-only runner re-applies if
-- the schema_migrations row is missing on disaster recovery).
-- See internal design notes for rationale.
--
-- 49-05: crf_qsv 22 -> 26. THE SEED IS EDITED IN PLACE, DELIBERATELY.
--   Why in place and not a new migration: the runner (src/lib/db/migrate.ts:52-69)
--   gates purely on the schema_migrations row and computes NO checksum. An
--   existing installation already carries the 0005 row, so this file never runs
--   there again and its stored crf_qsv is untouched (AC-8/AC-8b). A NEW migration
--   would be a no-op for EVERYONE: on a fresh install 0005 runs first and has
--   already inserted the value, and on an existing install the row is there
--   anyway. An UPDATE is ruled out by D4 — no existing setting row is rewritten.
--   In-place edit is the only mechanism that hits exactly the intended
--   population: NEW INSTALLATIONS ONLY.
--
--   Where the 26 comes from: it is a conservative ESTIMATE, taken from the
--   unRAID-forum recommendation 26-28 (2026-08-19, lower end chosen). It is NOT
--   a VMAF measurement — there is no Intel hardware locally. A measured value
--   comes from the vmaf-anchored /bench run. crf_vaapi stays 22 because there is
--   no evidence against that number.
--
--   Kept in sync with DEFAULT_CRF_BY_ENCODER (src/lib/encode/crf-defaults.ts) by
--   tests/encode/default-crf-consistency.test.ts, which parses THIS file.

INSERT OR IGNORE INTO setting (key, value) VALUES
  ('encoder',       'auto'),
  ('concurrency',   'auto'),
  ('crf_libx265',   '23'),
  ('crf_nvenc',     '23'),
  ('crf_qsv',       '26'),
  ('crf_vaapi',     '22');
