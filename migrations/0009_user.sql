-- user table — single-user optional auth.
-- Auth backend foundation.
--
-- Off-by-default: the table exists even when auth_enabled='false' so the
-- toggle can flip without a migration. Empty table + auth_enabled='false'
-- is the factory default; auth_setup_completed='false' gates the setup endpoint.
--
-- See internal design notes.

CREATE TABLE user (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  last_login_at   INTEGER,
  CHECK (length(username) >= 3 AND length(username) <= 64),
  -- bcryptjs $2a$ output is exactly 60 chars; CHECK guards against partial writes.
  CHECK (length(password_hash) = 60)
);

CREATE INDEX idx_user_username ON user(username);
