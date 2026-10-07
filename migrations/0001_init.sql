-- PowerCordKit Mail schema (D1 / SQLite)
-- Applied via: wrangler d1 migrations apply powercordkit-mail --local

CREATE TABLE IF NOT EXISTS inbox_items (
  id TEXT PRIMARY KEY,
  server TEXT NOT NULL DEFAULT 'tep.one',
  type TEXT NOT NULL DEFAULT 'idea',
  tag TEXT NOT NULL DEFAULT 'idea',
  author TEXT NOT NULL DEFAULT 'unknown',
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  time TEXT NOT NULL DEFAULT '',
  prio TEXT NOT NULL DEFAULT 'normal',
  src TEXT NOT NULL DEFAULT 'discord',
  by TEXT NOT NULL DEFAULT 'manual',
  url TEXT NOT NULL DEFAULT '#',
  assigned TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_inbox_archived_created ON inbox_items(archived, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_server_type ON inbox_items(server, type);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inbox_items(id) ON DELETE CASCADE,
  by TEXT NOT NULL DEFAULT 'mod',
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_notes_item ON notes(item_id, created_at);
