# PowerCordKit Mail — AI Setup Guide

For AI coding agents (opencode, Cursor, Claude Code, Codex, Freebuff, etc.).
Goal: help a user **self-host the Mail inbox** end to end.

- Servable copy: `GET https://<deployed-host>/ai-setup.md`
- Human guide: `/mail-setup/`
- Repo: Cloudflare **Worker (Hono) + D1 + static assets** in `public/`.

## How the agent should work

1. **Collect inputs first** (see "Inputs to collect"). Ask the user; don't guess.
2. **Run the steps in order.** After each, run its verification and stop on failure.
3. **Never print secrets.** Use `wrangler secret put` (write-only, prompts). Keep secrets out of chat, logs, and git.
4. **One community = one Cloudflare account + one D1 + one Worker.** Community config: `wrangler.community.jsonc`. Personal: `wrangler.jsonc`.
5. Prefer the user's own `wrangler` login; if you lack access, give them the exact commands to run.

## Where things live

| Path | What |
|------|------|
| `src/index.ts` | Hono app: `/api/*` (inbox, servers, roadmap, auth, admin), `/hooks/*` (Discord/Discourse/forums/interactions) |
| `src/poll.ts` | Cloudflare cron poller (channels + threads), backfill |
| `src/discord-oauth.ts` | Discord login + signed session cookies |
| `src/ed25519.ts` | Verifies Discord interaction signatures |
| `src/access.ts` | Optional Cloudflare Access JWT verification |
| `public/` | Static UI (hub, mail, ideas, roadmap, mail-setup, tools) |
| `public/site.config.json` + `public/assets/site.js` | Header/links/accent/footer shell |
| `migrations/*.sql` | D1 schema |
| `scripts/build-tools.mjs` | Builds the backend-free tools site |

## Configuration & toggles

- **`public/site.config.json`** (served; also at `/site.config.json`) drives branding for Tools + Mail: `siteName` (your site title), `accent`, `header { brand, logo, home, links[] }`, `footerNote`, `creditUrl`, and `features`. Edit it directly, or set `configUrl` to a raw GitHub URL for live edits (no redeploy).
  - **First config (what to pick):** title → `siteName`; which tools to enable → `features`; your nav → `header.links`:
    ```jsonc
    {
      "siteName": "MyCommunity Tools",
      "features": { "mailSetup": false, "tools": true, "inbox": true, "modtools": false },
      "header": { "brand": "MyCommunity Tools", "links": [ { "label": "Home", "href": "https://mine.example" } ] }
    }
    ```
    `features.tools` shows/hides the Labs hub, `features.inbox` the Community Inbox (nav + hub), `features.modtools` the Mod Tools. `mailSetup: false` turns the setup guide off once you're set up (link, hub card, and the guide page itself).
  - Per-deployment branding: add `"environments": { "personal": { "siteName": "PowerCordKit", "header": { "brand": "PowerCordKit" } } }`. The shell reads `ENVIRONMENT` from `/api/health` and merges the matching block, so one shared `public/` can brand each deployment differently.
- **`PUBLIC_ROADMAP`** (wrangler var, default `1`): set to `0` to make `GET /api/roadmap` require login (private roadmap). The `/roadmap/` page then shows a log-in prompt.
- **`DEFAULT_SERVER`**, **`FEED_MAP`**, **`POLL_DEBUG`** (wrangler vars) — see below.

## Inputs to collect (ask the user)

| Input | Required | How to get | Format |
|---|---|---|---|
| Cloudflare account access | yes | `npx wrangler login` (their account) | — |
| `DEFAULT_SERVER` | yes | a slug for mail with no server (e.g. `main`) | `[a-z0-9-]` |
| Discord app **Client ID** | yes (login) | Dev Portal → app → OAuth2 | digits |
| Discord app **Client Secret** | yes (login) | Dev Portal → OAuth2 → Reset Secret | string |
| `DISCORD_GUILD_ID` | yes (login) | the server members must be in | snowflake |
| `DISCORD_MOD_ROLE_IDS` | yes (login) | role IDs allowed in (comma-sep) | snowflakes |
| Discord app **Public Key** | yes ("Save as Idea") | Dev Portal → General Information | hex |
| **Bot token** | yes (poller) | Dev Portal → Bot → Reset Token | string |
| `FEED_MAP` | yes (poller) | channels/threads to watch (see below) | JSON |
| Discord webhook secret | optional | generate random | hex |
| Discourse webhook secret | optional | generate random | hex |
| `DISCORD_IDEA_ROLE_IDS` | optional | roles allowed to save ideas | snowflakes |
| `DISCORD_COMPLETE_TAG` | optional | forum tag name on complete (default `Completed`) | string |
| Zone/domain | optional | to serve on a custom host | e.g. `mail.example.com` |

## Steps

### 0. Preflight
```powershell
node -v                 # need >= 22.12
npx wrangler whoami     # confirm the RIGHT account (community account!)
```
If the wrong account: `npx wrangler logout; npx wrangler login`.

### 1. Install
```powershell
git clone https://github.com/EmjayBot/powercordkit.git
cd powercordkit
npm install
```

### 2. Database
```powershell
npm run db:create:community
# copy the printed database_id into wrangler.community.jsonc -> d1_databases[0].database_id
npm run db:migrate:remote:community
```
Verify: `npx wrangler d1 execute powercordkit-mail-community --remote --config wrangler.community.jsonc --command "SELECT count(*) FROM inbox_items"` → returns a number.

### 3. Secrets
Set each with `wrangler secret put <NAME> --config wrangler.community.jsonc` (prompts; never inline the value). Required set:

- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `SESSION_SECRET` (random 32 bytes hex)
- `DISCORD_GUILD_ID`, `DISCORD_MOD_ROLE_IDS`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_BOT_TOKEN`
- `DISCORD_WEBHOOK_SECRET`, `DISCOURSE_WEBHOOK_SECRET` (only if using those webhooks)
- optional: `DISCORD_IDEA_ROLE_IDS`, `DISCORD_COMPLETE_TAG`, `MOD_API_KEY`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`

Generate a random secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

### 4. Vars (`wrangler.community.jsonc` → `"vars"`)
Set `DEFAULT_SERVER`. For the poller, set `FEED_MAP` (JSON, in `vars`, NOT a secret):
```json
{"channels":[{"guild":"<guild-id>","channel":"<channel-id>","server":"<slug>","type":"ticket"}],
 "threads":[{"guild":"<guild-id>","parent":"<forum-channel-id>","server":"<slug>","type":"support"}]}
```
`type` is any of `idea|support|ticket|mailed`. `channels` = plain text channels; `threads` = forum channels or channels that hold threads.

### 5. Discord app configuration (Dev Portal → your app)
- **Bot** → enable **Message Content Intent** (required to read message text); **Reset Token** → `DISCORD_BOT_TOKEN`; copy **Application ID** → `DISCORD_CLIENT_ID`.
- **OAuth2** → add redirect `https://<host>/api/auth/callback`; copy **Client Secret**.
- **General Information** → copy **Public Key** → `DISCORD_PUBLIC_KEY`.
- **Interactions Endpoint URL** → `https://<host>/hooks/discord-interactions` → Save (Discord sends a PING; the Worker replies PONG).
- Invite the bot with `scope=bot applications.commands` and permissions **View Channel, Read Message History, Manage Threads** on watched channels. Required for reading archived/private ticket threads and for the complete/tag/close actions.

### 6. Deploy
```powershell
npm run deploy:community
curl https://<worker>.workers.dev/api/health   # {"ok":true,"env":"community",...}
```

### 7. Custom domain (optional)
If the zone is in this account, add to `wrangler.community.jsonc` and redeploy:
```json
"routes": [{ "pattern": "mail.example.com/*", "zone_name": "example.com" }]
```
Then DNS: proxied `CNAME mail → <worker>.workers.dev`.

### 8. Auth verify
```powershell
curl https://<host>/api/health          # ok
curl https://<host>/api/auth/me         # {"authenticated":false}
```
Load `https://<host>/mail/` in a browser → it should show **Log in with Discord** → authorize → land in the inbox if the account holds a role in `DISCORD_MOD_ROLE_IDS`. A `?denied=role` redirect means the role/guild don't match.

### 9. Poller verify
Wait ~2 min for the cron (`*/2 * * * *`), or check Worker logs: `npx wrangler tail --config wrangler.community.jsonc`. Expect `{"msg":"discord poll","mailed":N}`. If nothing arrives:
- bot missing **View Channel / Read Message History / Manage Threads**, or
- feed not in `FEED_MAP`, or
- empty message text ⇒ **Message Content Intent** is off.

Repair/backfill existing items: `POST /api/admin/backfill-threads?limit=12` (auth: session or `X-Mod-Key`), repeat until `remaining` is 0.

### 10. "Save as Idea" command
```powershell
curl -X POST https://<host>/api/admin/register-commands -H "X-Mod-Key: <MOD_API_KEY>"
```
Registers a guild message command (instant). Requires the `applications.commands` scope in the guild.

### 11. Webhooks (optional)
- Discord: `POST https://<host>/hooks/discord` header `X-Powercordkit-Secret: <DISCORD_WEBHOOK_SECRET>`, JSON `{server,type,title,content,author,by,url,prio}`.
- Discourse: Admin → Webhooks → `POST https://<host>/hooks/discourse`, secret = `DISCOURSE_WEBHOOK_SECRET`.
- Other forums: `POST https://<host>/hooks/<nodebb|flarum|lemmy|custom>` header `X-Forum-Secret`.

### 12. Roadmap (optional)
Promote an idea: `POST /api/inbox/<id>/roadmap` with `{"status":"planned|in-progress|shipped","date":"YYYY-MM-DD"}`. Public read at `GET /api/roadmap`; UI at `/roadmap/`.

## Verification checklist
- [ ] `GET /api/health` → `{"ok":true}`
- [ ] `GET /api/auth/me` → `200`
- [ ] Discord login lands in `/mail/inbox/`
- [ ] Poller `mailed` > 0 for at least one feed (or webhook test item appears)
- [ ] Inbox shows real items; `E` completes (tag + thread closed where applicable)
- [ ] `POST /api/admin/register-commands` succeeded and the command appears

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| `401 Mod key required` on `/api/*` | No auth method matches. Log in via `/api/auth/login`, or set/use `MOD_API_KEY` as `X-Mod-Key`. |
| Login loops back | Redirect URI mismatch, or no `DISCORD_MOD_ROLE_IDS` role. |
| `?denied=role` / `?denied=notmember` | Role/guild mismatch in the callback. |
| Poller silent, `wallTime` ~0 | `DISCORD_BOT_TOKEN` missing → `wrangler secret list` to confirm. |
| Messages empty | **Message Content Intent** off. |
| Ticket threads missing | bot lacks **Manage Threads** (private threads) — poller reads `threads/archived/private`. |
| Tag won't apply / 403 on PATCH | bot lacks **Manage Threads** on that forum. |
| Webhook 401 | wrong secret or wrong header name. |
| 413 | payload over 256 KB (`MAX_PAYLOAD_BYTES`). |

## Rollback
- Redeploy the previous version: `npx wrangler versions list --config wrangler.community.jsonc` then `npx wrangler rollback <id> --config wrangler.community.jsonc`.
- Remove the Worker/D1 from the Cloudflare dashboard; secrets disappear with the Worker.

## Machine-readable inputs (for tooling)
```json
{
  "required": ["DEFAULT_SERVER", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "SESSION_SECRET", "DISCORD_GUILD_ID", "DISCORD_MOD_ROLE_IDS", "DISCORD_PUBLIC_KEY", "DISCORD_BOT_TOKEN"],
  "optional": ["DISCORD_IDEA_ROLE_IDS", "DISCORD_COMPLETE_TAG", "DISCORD_WEBHOOK_SECRET", "DISCOURSE_WEBHOOK_SECRET", "FORUM_WEBHOOK_SECRET", "MOD_API_KEY", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD"],
  "vars": ["DEFAULT_SERVER", "FEED_MAP", "ENVIRONMENT", "COMMUNITY_DOMAIN"],
  "secrets": ["DISCORD_CLIENT_SECRET", "DISCORD_PUBLIC_KEY", "DISCORD_BOT_TOKEN", "SESSION_SECRET", "DISCORD_WEBHOOK_SECRET", "DISCOURSE_WEBHOOK_SECRET", "MOD_API_KEY"],
  "config": "wrangler.community.jsonc"
}
```

## Mod tools (Ban Sync · Timeouts · Infractions · Appeals · Notes)

Moderate across multiple Discord servers (and Discourse) from one place, on the
same Mail D1 + Worker. Product naming has no "Lab".

**Database** — `migrations/0006_modtools.sql` adds `bans`, `timeouts`,
`infractions`, `appeals`, `user_notes`, `audit_log` (counts as the foundation).

**Config**
- `MOD_TOOL_SERVERS` (wrangler var, JSON): map of `"<slug>": { "guild": "<guild-id>" }`
  for each server you moderate via Discord.
- Secrets: if syncing suspends to Discourse, add `DISCOURSE_BASE_URL` and
  `DISCOURSE_ADMIN_KEY` (Admin → API → Create key, `suspend` permission).

**Bot permissions** — the bot needs **Ban Members** (bans) and
**Moderate Members / Manage Members** (timeouts) on every guild in
`MOD_TOOL_SERVERS`, plus View Channel on the mod channels.

**Endpoints** (auth = mod session / Access / `MOD_API_KEY`, role-gated; each
write is audited and rate-limited):

| Tool | Route | Notes |
|---|---|---|
| Bans | `POST/GET /api/bans` · `POST /api/bans/:id/unban` | `PUT/DELETE /guilds/{g}/bans/{u}` (parallel, retry); `POST /admin/users/{id}/suspend` on Discourse |
| Timeouts | `POST/GET /api/timeouts` · `POST /api/timeouts/:id/remove` | `PATCH /guilds/{g}/members/{u}` `communication_disabled_until`; 5-min cron expires + deactivates |
| Infractions | `POST/GET /api/infractions` · `GET /api/infractions/:user/timeline` | Adds warnings; timeline merges bans/timeouts/warnings/mail/appeals for a user |
| Appeals | `POST /hooks/appeal` (public) · `GET /api/appeals` · `POST /api/appeals/:id/approve|deny` | Public form (ban validated, 1 per ban/24h, honeypot, IP *hash*); creates a Mail item `type=appeal`; Approve triggers the Ban Sync unban |
| Notes | `POST/GET /api/user-notes` · `GET /api/user-notes/:user` | Per-user private notes surfaced in Mail detail + every tool |

**Rates:** bans 5/min, timeouts 10/min, appeals 1 per ban per 24h, notes
20/min (per mod).

**Workflow:** Mail is the hub — approve an appeal from the inbox to trigger the
unban; "archive → link infraction" records it on the user; user notes follow the
user across servers and appear in Mail detail, Infractions, Bans, and Timeouts.

## Suggested prompt to start

> Read `AI_SETUP.md` in this repo. Help me self-host the Mail inbox on my Cloudflare account. Ask me for every required input first (I'll provide a Discord app and server). Run the setup steps, verify each, and keep all secrets out of the chat.
