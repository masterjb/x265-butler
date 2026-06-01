-- 02-04 follow-up: auto-enqueue pending files after scan complete (Phase-2 polish).
-- Pure-data migration, no schema change. Default 'false' preserves existing behavior;
-- INSERT OR IGNORE preserves operator-set values across re-runs.

INSERT OR IGNORE INTO setting (key, value) VALUES ('auto_enqueue_after_scan', 'false');
