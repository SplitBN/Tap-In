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

-- ---- AI agent (docs/agent-contract.md). Credentials are AES-GCM encrypted with the AI_ENC_KEY secret. ----
CREATE TABLE IF NOT EXISTS ai_config (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  config TEXT NOT NULL DEFAULT '{}', -- AIConfig JSON (merged over server defaults)
  openrouter_key TEXT,               -- encrypted OpenRouter API key, NULL = none
  updated_at INTEGER NOT NULL
);

-- Index of ChatGPT (SIWC) connections; the tokens themselves live encrypted in the per-user AiAuth Durable Object.
CREATE TABLE IF NOT EXISTS ai_chatgpt (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,            -- ext_agent_host_id, stable per user (kept across disconnects)
  client_id TEXT,                   -- issued oaiapp_… client id (kept across disconnects)
  email TEXT,
  connected_at INTEGER,             -- NULL = not connected
  refreshed_at INTEGER,             -- last successful token refresh (cron refreshes after 20 days)
  attempt_at INTEGER                -- last refresh attempt (cron retries at most hourly)
);
CREATE INDEX IF NOT EXISTS ai_chatgpt_stale ON ai_chatgpt (refreshed_at) WHERE connected_at IS NOT NULL;

-- PKCE state for the paste-the-URL sign-in, single use, ~10 min.
CREATE TABLE IF NOT EXISTS ai_oauth_pending (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  client_id TEXT NOT NULL,          -- client id used in the authorize URL
  expires_at INTEGER NOT NULL
);
