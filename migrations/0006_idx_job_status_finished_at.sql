-- Covering index for /api/stats KPI + trend queries.
-- Existing migration 0002 created idx_job_status (single-column on status)
-- but no composite. The recompute-on-read promise of the stats design
-- ("≤10k rows sufficient for v1.0") is honest only with a covering index
-- on (status, finished_at) — without it, every /api/stats call full-scans
-- all done rows. SQLite query planner uses this composite for the predicate
--   WHERE status='done' AND finished_at >= ?
-- which is shared by all four KPI queries + the trend group-by.
-- IF NOT EXISTS guard makes this safe to re-run on disaster recovery.
CREATE INDEX IF NOT EXISTS idx_job_status_finished_at ON job(status, finished_at);
