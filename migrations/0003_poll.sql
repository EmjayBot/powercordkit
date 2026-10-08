-- PowerCordKit Discord poller state (no-hosting bot alternative).
-- The scheduled worker polls watched channels/threads via Discord REST and
-- mails new items straight into inbox_items. Tracks progress here.
-- Applied via: wrangler d1 migrations apply <db> --local/--remote

CREATE TABLE IF NOT EXISTS poll_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Seen thread IDs for THREAD_CREATE-equivalent polling (report-a-concern).
CREATE TABLE IF NOT EXISTS seen_threads (
  thread_id TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
