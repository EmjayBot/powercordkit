-- Mod tools schema: Ban Sync, Timeouts, Infractions, Appeals, User Notes, Audit log.
-- Applied via: wrangler d1 migrations apply <db> --remote/--local

CREATE TABLE IF NOT EXISTS bans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  mod_id TEXT NOT NULL,
  servers_json TEXT NOT NULL DEFAULT '[]',
  evidence_mail_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_bans_user ON bans(user_id);
CREATE INDEX IF NOT EXISTS idx_bans_active ON bans(is_active);

CREATE TABLE IF NOT EXISTS timeouts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  mod_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_timeouts_user ON timeouts(user_id);
CREATE INDEX IF NOT EXISTS idx_timeouts_active ON timeouts(is_active);

CREATE TABLE IF NOT EXISTS infractions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  reason TEXT NOT NULL,
  mod_id TEXT NOT NULL,
  server_id TEXT,
  mail_item_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_infractions_user ON infractions(user_id);

CREATE TABLE IF NOT EXISTS appeals (
  id TEXT PRIMARY KEY,
  ban_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  answers_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open',
  ip_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_appeal_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_appeals_ban ON appeals(ban_id);
CREATE INDEX IF NOT EXISTS idx_appeals_user ON appeals(user_id);

CREATE TABLE IF NOT EXISTS user_notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  mod_id TEXT NOT NULL,
  note TEXT NOT NULL,
  mail_item_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_notes_user ON user_notes(user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  user_id TEXT,
  mod_id TEXT,
  target TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_mod ON audit_log(mod_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);