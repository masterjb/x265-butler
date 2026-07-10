-- 11-01: Encoder-Benchmark backend foundation.
-- bench_run: one row per operator-initiated benchmark run.
-- bench_combo: one row per (file × encoder × preset × nativeValue × sampleIdx) combination.
-- 6 bench-settings seeded INSERT OR IGNORE (preserves operator-edited values on re-run).

CREATE TABLE bench_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL CHECK(mode IN ('native-sweep','vmaf-anchored')),
  status TEXT NOT NULL CHECK(status IN ('pending','running','complete','failed','cancelled')),
  file_ids_json TEXT NOT NULL,
  matrix_json TEXT NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 3,
  sample_duration_seconds INTEGER NOT NULL DEFAULT 20,
  vmaf_buckets_json TEXT,
  vmaf_model TEXT NOT NULL DEFAULT 'vmaf_v0.6.1',
  actor_id INTEGER,
  error_reason TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO setting (key, value) VALUES ('bench_sample_count', '3');
INSERT OR IGNORE INTO setting (key, value) VALUES ('bench_sample_duration_seconds', '20');
INSERT OR IGNORE INTO setting (key, value) VALUES ('bench_default_mode', 'native-sweep');
INSERT OR IGNORE INTO setting (key, value) VALUES ('bench_vmaf_model', 'vmaf_v0.6.1');
-- 16-04: VMAF-Pareto-Buckets shape narrowed 4 → 3. INSERT OR IGNORE is
-- no-op on existing DBs (legacy operator-seed '95,92,88,85' recovers via
-- reject-fallback-banner per AC-4); fresh-installs seed canonical 3-csv.
INSERT OR IGNORE INTO setting (key, value) VALUES ('bench_vmaf_buckets', '95,92,88');
INSERT OR IGNORE INTO setting (key, value) VALUES ('bench_max_concurrent_runs', '1');
