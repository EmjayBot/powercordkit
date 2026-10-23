-- Appeal invite links: mods mint an expiring, single-use link per ban and DM it
-- to the banned user. The link opens the public appeal form without exposing
-- ban IDs. Only the SHA-256 hash is stored; the plaintext token shows once.
-- Applied via: wrangler d1 migrations apply <db> --remote/--local

CREATE TABLE IF NOT EXISTS appeal_links (
  token_hash TEXT PRIMARY KEY,
  ban_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_appeal_links_ban ON appeal_links(ban_id);
CREATE INDEX IF NOT EXISTS idx_appeal_links_user ON appeal_links(user_id);
