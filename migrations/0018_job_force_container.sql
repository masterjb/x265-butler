-- 10-03 E-D5: force_container for operator-explicit retry after match-source fallback.
-- Written at retry time via POST /api/library/[id]/retry { forceContainer }.
-- Read by orchestrator dispatch before container_override / output_container resolution.
-- NULL = no force (preserves 10-02 semantics byte-identical).
ALTER TABLE job ADD COLUMN force_container TEXT NULL CHECK (force_container IN ('mp4', 'mkv'));
