-- 05-14: output-container operator-selectable setting.
-- Pure-data migration mirroring 0011 — INSERT OR IGNORE so re-running on an
-- existing DB never overwrites operator-edited values.
--
-- Factory default preserves 1.4.0 / pre-05-14 behavior:
--   output_container='mkv' → existing .x265.mkv output naming convention
--
-- Supersedes 2026-04-24 PROJECT.md Decision "Output format always MKV": the
-- operator can now flip to 'mp4' via Settings → Encoder tab. The legacy
-- `output_suffix` setting (0011) stays as a free-form override for any
-- installation that already customized it; when `output_suffix` is left at
-- its '.x265.mkv' default, the orchestrator auto-derives the suffix from
-- `output_container` instead.
--
-- ROLLBACK: DELETE FROM setting WHERE key='output_container';

INSERT OR IGNORE INTO setting (key, value) VALUES ('output_container', 'mkv');
