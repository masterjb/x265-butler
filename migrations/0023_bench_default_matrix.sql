-- Bench default-matrix settings (encoders + presets + native_values).
-- Complements 0019, which seeded mode/sampleCount/sampleDuration/vmafModel/vmafBuckets.
INSERT OR IGNORE INTO setting (key, value) VALUES ('bench_default_encoders', 'libx265');
INSERT OR IGNORE INTO setting (key, value) VALUES ('bench_default_presets', 'veryfast,medium,slow');
INSERT OR IGNORE INTO setting (key, value) VALUES ('bench_default_native_values', '23,28');
