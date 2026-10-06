-- Master switch "Automatisch encodieren" (setting auto_encode) gating
-- every AUTOMATIC enqueue path (watcher ingest, reconcile orphan sweep,
-- auto-enqueue after POST /api/scan). Manual paths are never gated.
--
-- New installs: OFF. Existing installs: keep what they effectively had.
-- No UPDATE: both statements are INSERT OR IGNORE, so an operator value
-- that already exists is never touched and a re-run is a no-op.
--
-- "Existing install" = onboarding finished OR at least one job row. On a fresh
-- DB 0007 has just seeded onboarding_completed='false' and job is empty, so the
-- first statement inserts nothing and the seed below wins.
--
-- Effective old behaviour: the watcher's reconcile enqueued every pending file
-- whenever auto-scan ran (autoScan.enabled missing counts as ON, the boot seed
-- in service.ts writes 'true'); without the watcher only
-- auto_enqueue_after_scan='true' enqueued automatically.
INSERT OR IGNORE INTO setting (key, value)
SELECT 'auto_encode',
       CASE
         WHEN COALESCE((SELECT value FROM setting WHERE key = 'autoScan.enabled'), 'true') = 'true'
           OR (SELECT value FROM setting WHERE key = 'auto_enqueue_after_scan') = 'true'
         THEN 'true'
         ELSE 'false'
       END
 WHERE EXISTS (SELECT 1 FROM setting WHERE key = 'onboarding_completed' AND value = 'true')
    OR EXISTS (SELECT 1 FROM job);

INSERT OR IGNORE INTO setting (key, value) VALUES ('auto_encode', 'false');
