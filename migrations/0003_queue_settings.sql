-- 02-03: persist queue_paused across container restart (resolves 02-02 deferral D10).
-- Pure-data migration — no schema changes. The `setting` table from 0001 already
-- has the right shape; this migration just seeds a default row.
--
-- INSERT OR IGNORE preserves any existing user-set value (e.g. an operator who
-- manually flipped queue_paused to 'true' as a workaround during the 02-02→02-03
-- ship gap). audit-added S8 verifies this in tests/db/migrate.test.ts.

INSERT OR IGNORE INTO setting (key, value) VALUES ('queue_paused', 'false');
