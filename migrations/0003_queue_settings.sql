-- Persist queue_paused across container restart.
-- Pure-data migration — no schema changes. The `setting` table from 0001 already
-- has the right shape; this migration just seeds a default row.
--
-- INSERT OR IGNORE preserves any existing user-set value (e.g. an operator who
-- manually flipped queue_paused to 'true' as a workaround before this row
-- existed). tests/db/migrate.test.ts verifies this.

INSERT OR IGNORE INTO setting (key, value) VALUES ('queue_paused', 'false');
