-- force_container for operator-explicit retry after match-source fallback.
-- Written at retry time via POST /api/library/[id]/retry { forceContainer }.
-- Read by orchestrator dispatch before container_override / output_container resolution.
-- NULL = no force (container_override / output_container resolution unchanged).
ALTER TABLE job ADD COLUMN force_container TEXT NULL CHECK (force_container IN ('mp4', 'mkv'));
