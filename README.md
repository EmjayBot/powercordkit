# PowerCordKit

Discord mod tools suite + Unified Mod Inbox.

- **Tools** — self-contained labs (Embed, Color, Markdown, Timestamp, Snowflake, Webhook, Slowmode) that run anywhere static.
- **Mail** — a unified mod inbox for Discord servers + forums: tickets, support threads, ideas, a roadmap, Discord login, and webhooks, on Cloudflare Workers + D1.

Stack: Cloudflare **Workers** (Hono) + Static Assets (`./public`) + **D1** (`migrations/`).

> Setting up with an AI assistant? Point it at **[`AI_SETUP.md`](AI_SETUP.md)** (also served at `/ai-setup.md`). Human walkthrough: `/mail-setup/`.

## Copy it and make it yours

Two deployable pieces, each with its own `wrangler` config. Fill in **your** values and keep a private copy locally so you can pull updates without losing them:

| File | Purpose | Keep your values in (gitignored) |
|------|---------|----------------------------------|
| `wrangler.community.jsonc` | Mail inbox Worker (D1 + static UI) | `wrangler.community.local.jsonc` |
| `wrangler.tools.jsonc` | Tools-only static Worker | `wrangler.tools.local.jsonc` |
| `wrangler.jsonc` | Personal single instance | `wrangler.local.jsonc` |

The committed configs are generic placeholders (no account IDs, no domains, `REPLACE_WITH_YOUR_D1_ID`). Deploy your filled-in copy with `npm run deploy:community:local` (etc.), or just edit the committed files if you don't expect to pull template updates.

## Tools (`/` hub)

| Tool | Route | Backend |
|------|-------|---------|
| Mod Mail — Overview | `/mail/` | D1 (`/api/inbox` stats + queues) |
| Mod Mail — Unified Inbox | `/mail/inbox/` | D1 (`/api/inbox`, `/hooks/*`) |
| Color Lab | `/color/` | Static only (clipboard) |
| Embed Lab | `/embeds/` | Static + optional POST to Mail |
| Slowmode Planner | `/slowmode/` | Static + optional POST to Mail |
| Ticket Triage | `/tickets/` | D1 via Mail API (`type=ticket`) |
| Idea Capture | `/ideas/` | D1 via Mail API (`type=idea`) |
| Roadmap | `/roadmap/` | D1 via Mail API (`/api/roadmap`) |
| Timestamp Lab | `/timestamp/` | Static only (clipboard) |
| Snowflake Lab | `/snowflake/` | Static only |
| Markdown Lab | `/markdown/` | Static only (clipboard) |
| Webhook Lab | `/webhook/` | Direct browser POST to Discord |

## Quick start (local)

```powershell
git clone https://github.com/EmjayBot/powercordkit.git
cd powercordkit
npm install
Copy-Item .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
# open http://localhost:8787/ and http://localhost:8787/mail/
```

Community config locally (no login needed for local D1):

```powershell
npm run db:migrate:local:community
npm run dev:community
```

## Deploy the Mail inbox

Fill in `wrangler.community.jsonc` (or your `wrangler.community.local.jsonc`), then:

```powershell
npm run db:create:community          # paste the printed database_id into the config
npm run db:migrate:remote:community
# set secrets (wrangler secret put <NAME> --config wrangler.community.jsonc):
#   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, SESSION_SECRET, DISCORD_GUILD_ID,
#   DISCORD_MOD_ROLE_IDS, DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN,
#   DISCORD_WEBHOOK_SECRET, DISCOURSE_WEBHOOK_SECRET, ...
npm run deploy:community
```

Full, accurate steps (Discord app, login, poller, "Save as Idea", webhooks, roadmap, verification, troubleshooting) live in **[`AI_SETUP.md`](AI_SETUP.md)** / `/mail-setup/`.

## Deploy the tools-only site

Anyone can run the labs without the Mail backend:

```powershell
npm run build:tools        # → dist/tools/ (gitignored)
npm run preview:tools      # local check on :8792
npm run deploy:tools       # Worker "powercordkit-tools" (static only)
```

`build-tools` packages `./public` into `dist/tools/`, dropping Mail/Tickets/Ideas and generating a clean hub (tool cards + the setup card + the Powered-by-PowerCordKit footer — no hero, no marketing). Branding comes from `public/site.config.json` (`siteName`, `accent`, `header { brand, logo, home, links[] }`, `footerNote`, `creditUrl`) and `tools.config.json`. Forks set their own name/links; `baseUrl: "/"` for a domain root or `"/my-tools/"` for a subpath (also makes GitHub Pages project sites work).

```powershell
node scripts/build-tools.mjs --config tools.my.json --out dist/tools
```

## Configuration & toggles

- **`public/site.config.json`** — header/links/accent/footer for Tools + Mail (`creditUrl` is where the footer credit links). Edit directly, or set `configUrl` to a raw GitHub URL for live edits without redeploying.
  - `"features": { "mailSetup": false }` hides the setup guide link/card and turns the `/mail-setup/` page into an "off" notice.
- **`PUBLIC_ROADMAP`** (wrangler var) — `1` (default) public roadmap, `0` requires login.
- **`MAX_PAYLOAD_BYTES`** — webhook body cap, default 256 KB.

## Webhooks

- Discord: `POST /hooks/discord` header `X-Powercordkit-Secret`, JSON `{server,type,title,content,author,by,url,prio}`.
- Discourse: `POST /hooks/discourse`, secret = `DISCOURSE_WEBHOOK_SECRET` (`X-Discourse-Event-Signature`).
- Other forums: `POST /hooks/:name` for `nodebb`, `flarum`, `lemmy`, `custom` (header `X-Forum-Secret`). Extend `FORUM_ADAPTERS` in `src/index.ts` to add one.

## GitHub Pages (static labs)

Everything in `./public` except Mail's `/api` + `/hooks` is static and runs on GitHub Pages (`.nojekyll` + `404.html` included). Mail pages load but show their offline state (no D1). Requires root hosting (custom domain or a user site) — project subpaths aren't supported.

## Hardening

- Security headers on `/api/*` + `/hooks/*`; 413 over `MAX_PAYLOAD_BYTES` (256 KB).
- Content is truncated (poller 4000, webhook 20000); prepared statements only.
- Discord login is role-gated; sessions are signed (`HttpOnly; Secure; SameSite=Lax`).
- Retention: daily cron (`0 3 * * *`) deletes items + notes older than 90 days.

## Credit

MIT (`LICENSE.md`). The one condition: keep the **"Powered by PowerCordKit"** footer credit and link-back on any copy, embed, or self-hosted toolset.
