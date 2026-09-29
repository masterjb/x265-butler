-- 05-bonus: encode-behavior settings.
-- Pure-data migration mirroring 0003/0004/0005/0007/0010 — INSERT OR IGNORE
-- so re-running on an existing DB never overwrites operator-edited values.
--
-- Factory defaults preserve 1.4.0 behavior:
--   delete_original_after_encode='false' → originals go to trash (existing)
--   output_suffix='.x265.mkv'             → existing output naming convention

INSERT OR IGNORE INTO setting (key, value) VALUES ('delete_original_after_encode', 'false');
INSERT OR IGNORE INTO setting (key, value) VALUES ('output_suffix', '.x265.mkv');
