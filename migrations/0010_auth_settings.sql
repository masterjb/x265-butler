-- Auth-related settings seed.
-- Pure-data migration mirroring 0003/0004/0005/0007 — INSERT OR IGNORE so
-- re-running on an existing DB never overwrites operator-edited values.
--
-- Factory defaults (zero-regression contract):
--   auth_enabled='false'          → all 15 protected handlers behave byte-identically to 1.4.0
--   auth_setup_completed='false'  → /api/auth/setup is the only writeable auth path
--   session_secret=''             → generated atomically at first /api/auth/setup
--   session_ttl_seconds='604800'  → 7 days; rolling renewal at <50% remaining
--   auth_trust_proxy_xff='false'  → LAN-default-secure; XFF ignored unless explicit opt-in
--   password_pepper=''            → generated atomically at first /api/auth/setup
--   bcrypt_cost='12'              → operator-tunable 10..14 at hashPassword call site

INSERT OR IGNORE INTO setting (key, value) VALUES ('auth_enabled', 'false');
INSERT OR IGNORE INTO setting (key, value) VALUES ('auth_setup_completed', 'false');
INSERT OR IGNORE INTO setting (key, value) VALUES ('session_secret', '');
INSERT OR IGNORE INTO setting (key, value) VALUES ('session_ttl_seconds', '604800');
-- Default-secure XFF
INSERT OR IGNORE INTO setting (key, value) VALUES ('auth_trust_proxy_xff', 'false');
-- Server-side pepper mixed into password before bcrypt
INSERT OR IGNORE INTO setting (key, value) VALUES ('password_pepper', '');
-- Operator-tunable bcrypt cost (range 10 to 14 enforced at hashPassword call site)
INSERT OR IGNORE INTO setting (key, value) VALUES ('bcrypt_cost', '12');
