-- D1-backed fixed-window rate limits (Workers isolates don't share memory).
-- Keyed by e.g. 'ban:<mod>' or 'appeal-ip:<hash>'. One row per key.
-- Applied via: wrangler d1 migrations apply <db> --remote/--local

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);
