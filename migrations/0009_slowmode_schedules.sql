-- Time-based slowmode: the bot adjusts rate_limit_per_user on a UTC window.
-- One row per channel: outside [start_utc, end_utc) it enforces day_secs,
-- inside it enforces night_secs. last_applied avoids redundant Discord calls.
-- Times are "HH:MM" UTC (overnight wrap supported, e.g. 22:00–07:00).

CREATE TABLE IF NOT EXISTS slowmode_schedules (
  id TEXT PRIMARY KEY,
  server TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL DEFAULT '',
  day_secs INTEGER NOT NULL DEFAULT 0,
  night_secs INTEGER NOT NULL DEFAULT 10,
  start_utc TEXT NOT NULL DEFAULT '22:00',
  end_utc TEXT NOT NULL DEFAULT '07:00',
  last_applied INTEGER,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_sched_server ON slowmode_schedules(server, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sched_channel ON slowmode_schedules(server, channel_id);
