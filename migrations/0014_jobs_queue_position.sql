-- Plan 05-12: B3 Queue Reorder Feature — operator-controlled pick order.
-- Adds queue_position column + backfills existing 'queued' rows from
-- (created_at ASC, id ASC) ranking + creates partial index for picks.
--
-- Backwards-compat: the three pick paths (claimSelect / peekQueued / listActive)
-- gain `ORDER BY queue_position ASC, created_at ASC, id ASC`. The backfill
-- makes pre-0014 ordering identical to post-0014 ordering on initial state,
-- so the ORDER BY change is monotone — no operator-visible reordering on
-- first run.
--
-- Operational note (S2 audit): this migration acquires a write lock on the
-- `job` table for the backfill duration. On a live server with active
-- orchestrator, this introduces a brief (ms-scale for typical queues;
-- sub-second for <=100k pending rows) pause where claimNext + reorder TXs
-- queue behind the migration. No data loss. Run during scheduled restart
-- per release-engineering convention (Plan 05-05).
--
-- See: internal design notes AC-1 / AC-3.

ALTER TABLE job ADD COLUMN queue_position INTEGER NOT NULL DEFAULT 0 CHECK (queue_position >= 0);

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS pos
  FROM job
  WHERE status = 'queued'
)
UPDATE job
SET queue_position = (SELECT pos FROM ranked WHERE ranked.id = job.id)
WHERE id IN (SELECT id FROM ranked);

CREATE INDEX idx_job_queued_position
  ON job(queue_position, created_at, id)
  WHERE status = 'queued';
