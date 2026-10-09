-- Roadmap fields for promoted ideas.
-- Applied via: wrangler d1 migrations apply <db> --remote/--local

ALTER TABLE inbox_items ADD COLUMN roadmap INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inbox_items ADD COLUMN roadmap_status TEXT NOT NULL DEFAULT '';
ALTER TABLE inbox_items ADD COLUMN roadmap_date TEXT NOT NULL DEFAULT '';
