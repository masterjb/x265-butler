-- Where the trash lives when no explicit trash_path is set (setting
-- trash_location): 'share' = hidden folder inside the share of the file, so
-- moving an original is a rename instead of a copy; 'cache' = under the cache
-- path, the place every install used before this setting existed.
--
-- New installs: 'share'. Existing installs: 'cache', so nothing changes for
-- them after the update. No UPDATE: both statements are INSERT OR IGNORE, so an
-- existing value is never touched and a re-run is a no-op.
--
-- "Existing install" = onboarding finished OR at least one job row (same rule
-- as the auto_encode seed). On a fresh DB onboarding_completed is 'false' and
-- job is empty, so the first statement inserts nothing and the seed below wins.
INSERT OR IGNORE INTO setting (key, value)
SELECT 'trash_location', 'cache'
 WHERE EXISTS (SELECT 1 FROM setting WHERE key = 'onboarding_completed' AND value = 'true')
    OR EXISTS (SELECT 1 FROM job);

INSERT OR IGNORE INTO setting (key, value) VALUES ('trash_location', 'share');
