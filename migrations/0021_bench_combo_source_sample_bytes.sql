-- 11-02-FIX-V2 UAT-003: source sample size for compression-ratio + projected full-file savings.
-- NULL-safe: legacy rows have unknowable source size; aggregation tolerates NULL.
ALTER TABLE bench_combo ADD COLUMN source_sample_bytes INTEGER NULL;
