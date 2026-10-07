-- Per-encoder preset override (mirrors 0005 crf_<encoder> pattern).
-- Defaults match current PROFILE_BUILDERS hardcoded preset per encoder so
-- output stays byte-identical for operators who never
-- touch the Settings UI. INSERT OR IGNORE preserves operator-edited values
-- across re-runs (disaster-recovery race).
INSERT OR IGNORE INTO setting (key, value) VALUES
  ('preset_libx265', 'medium'),
  ('preset_nvenc',   'p5'),
  ('preset_qsv',     'slow'),
  ('preset_vaapi',   'slow');
