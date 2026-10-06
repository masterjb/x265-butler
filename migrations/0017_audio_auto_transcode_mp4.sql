-- Audio auto-transcode toggle for explicit-MP4 path.
-- INSERT OR IGNORE preserves operator-edited values on re-run.
-- Boolean-string encoding 'true'/'false' per 0011 convention.
-- Default 'true' is operator-friendly default; 1.x → 2.x behavior change
-- disclosed in CHANGELOG: on first encode-after-upgrade with
-- explicit-MP4 + incompatible audio, orchestrator auto-transcodes to AAC
-- instead of failing fast. Set to 'false' via PUT /api/settings to
-- opt out.
INSERT OR IGNORE INTO setting (key, value) VALUES ('audio_auto_transcode_mp4', 'true');
