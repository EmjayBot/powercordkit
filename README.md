# PowerCordKit

Discord mod tools suite + Unified Mod Inbox.

Repo: **https://github.com/EmjayBot/powercordkit** · Live labs: `emjaybot.github.io/powercordkit` (attach a custom domain — project subpaths aren't supported, see below).

- Personal suite: **https://powercordkit.emjay.fyi** (`/` hub, `/mail/` inbox) — `wrangler.jsonc`, your personal Cloudflare account
- Community mail: **https://mod.tep.one** — `wrangler.community.jsonc`, the **community's own Cloudflare account** (separate Worker, separate D1, separate secrets)

Stack: Cloudflare Workers (Hono) + Static Assets (`./public`) + D1 (`migrations/`). Same codebase, two configs, two accounts.

## Tools (`/` hub)

| Tool | Route | Backend |
|------|-------|---------|
| Mod Mail — Overview dashboard | `/mail/` | D1 (`/api/inbox` stats + queues) |
| Mod Mail — Unified Inbox | `/mail/inbox/` | D1 (`/api/inbox`, `/hooks/*`) |
| Color Lab | `/color/` | Static only (clipboard) |
| Embed Lab | `/embeds/` | Static + optional POST to Mail |
| Slowmode Planner | `/slowmode/` | Static + optional POST to Mail |
| Ticket Triage | `/tickets/` | D1 via Mail API (`type=ticket`) |
| Idea Capture | `/ideas/` | D1 via Mail API (`type=idea`) |
| Timestamp Lab | `/timestamp/` | Static only (clipboard) |
| Snowflake Lab | `/snowflake/` | Static only |
| Markdown Lab | `/markdown/` | Static only (clipboard) |
| Webhook Lab | `/webhook/` | Direct browser POST to Discord |

## Tools-only site (e.g. tools.tep.one)

Anyone can run the labs without the Mail backend. `npm run build:tools`
packages `./public` into `dist/tools/`: drops Mail/Tickets/Ideas, swaps the
hub's Mail + API sections for a **Mail setup guide** card (`/mail-setup/`,
included), repoints Mail links to the guide.

```powershell
npm run build:tools        # → dist/tools/ (gitignored)
npm run preview:tools     # local check on :8792
npm run deploy:tools      # Worker "powercordkit-tools" (wrangler.tools.jsonc, static only)
```

`deploy:tools` serves `dist/tools` from a backend-free Worker
(`src/tools.ts`) in the community account — no D1, no secrets — with
`tools.tep.one` attached via routes. Then add DNS: `CNAME tools →
&lt;worker&gt;.workers.dev`, proxied ON. Same root-hosting rule as below:
custom domain or user site, no project subpaths. To run with a different
inbox later, just deploy the full
Worker (Mail setup guide at `/mail-setup/`) — the labs are identical.

## Use it anywhere (with credit)

The labs are free to use on the hosted site, embed via iframe, or self-host
(`npm run build:tools`, guide at `/mail-setup/#tools-only`). The only
condition (`LICENSE.md`, MIT + credit): keep the **“Powered by PowerCordKit”**
footer credit and link-back on any copy, embed, or self-hosted toolset.

## GitHub Pages (static labs)

Everything in `./public` except Mail's `/api` + `/hooks` is pure static and
runs on GitHub Pages: push to `main` and `.github/workflows/pages.yml`
publishes `./public` (`.nojekyll` + `404.html` included).

- Works fully on Pages: Color, Embed, Timestamp, Snowflake, Markdown,
  Webhook, Slowmode, hub. Mail/Tickets/Ideas load but show their offline
  demo state (no D1 on Pages).
- Requires root hosting: a **custom domain** (e.g. `powercordkit.emjay.fyi`)
  or a user site (`<user>.github.io`). Project subpaths
  (`<user>.github.io/<repo>/`) are not supported (absolute paths).

## Hardening (per full-bundle spec)

- Security headers on `/api/*` + `/hooks/*` (HSTS, nosniff, DENY framing,
  `default-src 'none'`), 413 over 256KB (`MAX_PAYLOAD_BYTES`).
- Generic forum adapters: `POST /hooks/:name` for `discord`, `discourse`,
  `nodebb`, `flarum`, `lemmy`, `custom` (content truncated to 4000,
  `X-Forum-Secret` vs `FORUM_WEBHOOK_SECRET`, falls back to
  `DISCORD_WEBHOOK_SECRET`). To add a forum: extend `FORUM_ADAPTERS` in
  `src/index.ts` — no other changes needed.
- Retention: daily cron (`0 3 * * *`) deletes inbox items + notes older
  than 90 days.
- Webhook Lab guards: https-only, Discord hosts only, no private targets.

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

Community config locally (same machine, no login needed for local D1):

```powershell
npm run db:migrate:local:community
npm run dev:community
```

## Personal deploy (your account — already live)

Worker `powercordkit` → https://powercordkit.emjay-74c.workers.dev, D1 `powercordkit-mail`.

```powershell
npm run db:migrate:remote
npm run deploy
wrangler secret put DISCOURSE_WEBHOOK_SECRET
wrangler secret put DISCORD_WEBHOOK_SECRET
```

Custom domain: add `powercordkit.emjay.fyi` via dashboard (Workers > powercordkit > Settings > Domains) once the zone is in your account.

## Community deploy (community account — handoff)

Run these **logged in as the community account** (`wrangler logout && wrangler login`):

```powershell
# 1. Create + wire the community D1 (paste database_id into wrangler.community.jsonc)
npm run db:create:community
npm run db:migrate:remote:community

# 2. Fresh webhook secrets (generate new — do NOT reuse personal secrets)
#    Save values for the Discourse/Discord config below, then:
wrangler secret put DISCOURSE_WEBHOOK_SECRET --config wrangler.community.jsonc
wrangler secret put DISCORD_WEBHOOK_SECRET --config wrangler.community.jsonc

# 3. Deploy
npm run deploy:community
```

Then log back into your account (`wrangler logout && wrangler login`) for personal work.

Custom domain: add `mod.tep.one` via dashboard in the community account, or uncomment the `routes` line in `wrangler.community.jsonc` once `tep.one` zone is there.

> Note: `e18ad581-…` (powercordkit-mail-community) and Worker `powercordkit-community` currently exist in the **personal** account from initial setup. Delete them there after the community account is live to avoid confusion.

## Webhooks

- Discourse: Admin > Webhooks > `POST https://<host>/hooks/discourse` with `X-Discourse-Event-Signature: sha256=<hmac>`, secret = that env's `DISCOURSE_WEBHOOK_SECRET`.
- Discord bot / context menu: `POST https://<host>/hooks/discord` with header `X-Powercordkit-Secret`, JSON `{server,type,title,content,author,by,url,prio}`.

Personal host today: `powercordkit.emjay-74c.workers.dev` (later `powercordkit.emjay.fyi`).
Community host: workers.dev URL printed by `deploy:community` (later `mod.tep.one`).
