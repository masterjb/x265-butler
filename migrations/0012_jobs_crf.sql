-- Plan 05-08: B4 — sidecar V2 schema captures encoder + quality value used at encode time.
-- jobs.encoder already present (migration 0002); jobs.crf added here so V2 sidecar payloads
-- can be reconstructed at scan-time from the latest done job row (selfHealSidecar V2).
-- Legacy rows (pre-0012) leave crf NULL — selfHeal degrades to V1 payload for those files.
ALTER TABLE job ADD COLUMN crf INTEGER CHECK (crf IS NULL OR (crf >= 0 AND crf <= 51));
