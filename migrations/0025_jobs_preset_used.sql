-- Per-job preset record via DB column. Mirrors 0012's `crf` column
-- ALTER TABLE pattern. Orchestrator dispatch writes the resolved preset
-- (post-Catalog-validator-fallback) via JobRepo.setPresetUsed at the same
-- boundary that already calls setEncoder + setCrf. NULL for pre-0025 legacy
-- rows + for any future encoder that doesn't carry a preset semantic.
-- Free-form TEXT (no CHECK constraint) — Catalog-validation lives at the
-- orchestrator + zod boundary, NOT here. The per-job preset is a first-class
-- DB column instead of a log-only record.
ALTER TABLE job ADD COLUMN preset_used TEXT;
