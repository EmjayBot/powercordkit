-- Per-ban appeal wait: days after the ban before the user may appeal
-- (0 = immediately). Enforced in POST /hooks/appeal alongside the
-- one-appeal-per-user rule. Applied via:
-- wrangler d1 migrations apply <db> --remote/--local

ALTER TABLE bans ADD COLUMN appeal_wait_days INTEGER NOT NULL DEFAULT 0;
