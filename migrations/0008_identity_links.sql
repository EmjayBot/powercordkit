-- Link Discord users to forum accounts with different usernames/IDs.
-- One row per (discord_id, platform). platform e.g. 'discourse', 'nodebb'.
-- external_id is the forum's user id (for suspend/unsuspend calls);
-- external_username is display only. verified=1 when auto-confirmed
-- (Discourse custom field / webhook match), 0 for manual mod link.

CREATE TABLE IF NOT EXISTS identity_links (
  discord_id TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'discourse',
  external_id TEXT NOT NULL,
  external_username TEXT NOT NULL DEFAULT '',
  verified INTEGER NOT NULL DEFAULT 0,
  linked_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (discord_id, platform)
);
CREATE INDEX IF NOT EXISTS idx_identity_external ON identity_links(platform, external_id);
