-- Track completion separately so the original forum tag is preserved.
-- Applied via: wrangler d1 migrations apply <db> --remote/--local

ALTER TABLE inbox_items ADD COLUMN completed INTEGER NOT NULL DEFAULT 0;