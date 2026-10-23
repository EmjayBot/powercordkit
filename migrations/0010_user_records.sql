-- Per-user mod record threads: Command <-> Discord forum channel.
-- One row per (user, server slug); the thread is created on first action and
-- every later action posts into the same thread. Applied via:
-- wrangler d1 migrations apply <db> --remote/--local

CREATE TABLE IF NOT EXISTS user_records (
  user_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  forum_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_post_at TEXT,
  PRIMARY KEY (user_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_user_records_user ON user_records(user_id);
