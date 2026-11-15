-- Tap In backend schema (Cloudflare D1 / SQLite).
-- The app owns its data model; the server stores each synced record as JSON, keyed per user,
-- so new app features never need a server migration.

-- No passwords: high-entropy random keys (device token, recovery key, pairing code) only need a fast hash,
-- which fits the Workers free-tier CPU budget (~10 ms/request) — slow password hashing would not.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  recovery_hash TEXT NOT NULL UNIQUE, -- SHA-256 of the recovery key shown once at sign-up
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pair_codes (
  code_hash TEXT PRIMARY KEY,       -- SHA-256 of a one-time code to sign in another device
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,    -- SHA-256 of the bearer token (the token itself is never stored)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  device TEXT
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by TEXT,                -- user id, or NULL for the bootstrap invite
  used_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  user_id TEXT NOT NULL,
  tbl TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,             -- the record as JSON
  updated_at INTEGER NOT NULL,    -- client timestamp (last-write-wins)
  server_seq INTEGER NOT NULL,    -- monotonically increasing per write; the pull cursor
  PRIMARY KEY (user_id, tbl, id)
);
CREATE INDEX IF NOT EXISTS records_pull ON records (user_id, server_seq);

CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO counters (name, value) VALUES ('seq', 0);

CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  tz TEXT NOT NULL,               -- IANA zone, e.g. Asia/Jerusalem, so reminders fire at local times
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sent_reminders (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,              -- e.g. supp:<id>:<date>:<HH:MM>
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
