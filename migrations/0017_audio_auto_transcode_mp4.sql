-- 10-02 E-D3: audio auto-transcode toggle for explicit-MP4 path.
-- INSERT OR IGNORE preserves operator-edited values on re-run.
-- Boolean-string encoding 'true'/'false' per 0011 convention.
-- Default 'true' is operator-friendly default; 1.x → 2.x behavior change
-- disclosed in CHANGELOG (audit-fix:M6): on first encode-after-upgrade with
-- explicit-MP4 + incompatible audio, orchestrator auto-transcodes to AAC
-- instead of the 05-14 fail-fast. Set to 'false' via PUT /api/settings to
-- opt out (Settings-page UI lands in P12 Encoder-Profile-Editor).
INSERT OR IGNORE INTO setting (key, value) VALUES ('audio_auto_transcode_mp4', 'true');
