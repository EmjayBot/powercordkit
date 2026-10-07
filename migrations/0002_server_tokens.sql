-- PowerCordKit multi-server support (per-server ingestion tokens).
-- Servers themselves need no registry row: any `server` string sent by a
-- webhook is accepted, and GET /api/servers derives the live registry
-- (with counts) from inbox_items. This table only stores optional
-- per-server locks: when a row exists, ingestion for that server requires
-- either the global webhook secret or its X-Server-Token.
-- Applied via: wrangler d1 migrations apply powercordkit-mail --local/--remote

CREATE TABLE IF NOT EXISTS server_tokens (
  server TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
