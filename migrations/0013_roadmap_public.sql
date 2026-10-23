-- Public vs private roadmap: mods see the full board, logged-out visitors
-- only see items flagged public. Defaults to private (existing items stay
-- mod-only until a mod ticks "Public"). Applied via:
-- wrangler d1 migrations apply <db> --remote/--local

ALTER TABLE inbox_items ADD COLUMN roadmap_public INTEGER NOT NULL DEFAULT 0;
