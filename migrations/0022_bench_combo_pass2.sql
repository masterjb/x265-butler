-- 11-03 AC-1: Pass-2 full-file verify metrics on bench_combo.
-- NULL-safe additive ALTER TABLE — legacy rows retain prior data with new
-- columns NULL. Caller (orchestrator.runFullFileVerify → markPass2Complete)
-- writes all 4 in a single UPDATE post-encode/vmaf.
ALTER TABLE bench_combo ADD COLUMN pass2_vmaf REAL NULL;
ALTER TABLE bench_combo ADD COLUMN pass2_size_bytes INTEGER NULL;
ALTER TABLE bench_combo ADD COLUMN pass2_encode_seconds REAL NULL;
ALTER TABLE bench_combo ADD COLUMN pass2_completed_at INTEGER NULL;
