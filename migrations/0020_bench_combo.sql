-- 11-01: bench_combo table — one row per (file × encoder × preset × nativeValue × sampleIdx).
-- Pareto flag + top3_role written at recomputePareto time (after all combos complete).
-- ON DELETE CASCADE: removing a bench_run removes all its combos.

CREATE TABLE bench_combo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES bench_run(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES file(id),
  encoder TEXT NOT NULL,
  preset TEXT,
  native_quality_param TEXT NOT NULL,
  native_quality_value INTEGER NOT NULL,
  vmaf_target REAL,
  sample_idx INTEGER NOT NULL,
  vmaf REAL,
  size_bytes INTEGER,
  encode_seconds REAL,
  status TEXT NOT NULL CHECK(status IN ('pending','encoding','complete','failed','skipped')),
  error_reason TEXT,
  is_pareto INTEGER NOT NULL DEFAULT 0,
  top3_role TEXT CHECK(top3_role IN ('quality','balanced','size') OR top3_role IS NULL),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX idx_bench_combo_run ON bench_combo(run_id);
CREATE INDEX idx_bench_combo_run_file ON bench_combo(run_id, file_id);
