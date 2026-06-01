-- 11-06: Bench default-matrix settings (encoders + presets + native_values).
-- Komplementär zu 0019 das mode/sampleCount/sampleDuration/vmafModel/vmafBuckets seedete.
INSERT OR IGNORE INTO setting (key, value) VALUES ('bench_default_encoders', 'libx265');
INSERT OR IGNORE INTO setting (key, value) VALUES ('bench_default_presets', 'veryfast,medium,slow');
INSERT OR IGNORE INTO setting (key, value) VALUES ('bench_default_native_values', '23,28');
