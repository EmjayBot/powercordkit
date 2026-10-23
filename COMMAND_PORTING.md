# Command upgrades — porting notes for the main repo

Everything below shipped on `mod.tep.one` (community) and `powercordkit.emjay.fyi`
(personal, dormant — `MOD_TOOL_SERVERS` is `{}` there). Copy the file changes,
apply the migration, set the vars, redeploy.

## 1. Files changed

| File | What |
|---|---|
| `migrations/0010_user_records.sql` | **New.** `user_records` table (new — apply with `wrangler d1 migrations apply`) |
| `migrations/0011_appeal_links.sql` | **New.** `appeal_links` table (invite tokens) |
| `migrations/0012_ban_appeal_wait.sql` | **New.** `bans.appeal_wait_days` (appeal delay per ban) |
| `migrations/0013_roadmap_public.sql` | **New.** `inbox_items.roadmap_public` (public roadmap slice) |
| `public/appeals/index.html` | **New.** Public expiring-link appeal form (pruned from tools-only build in `scripts/build-tools.mjs`) |
| `public/assets/notice.png` | **New.** Banner image used by the DM card (`image.url`) |
| `src/modtools.ts` | Record-thread helpers + hooks on every write path, `GET/POST /api/records/*`, `POST /api/dm`, `name`/`records_forum`/`records_tag` config keys, `discordMsg()` error surfacing, embed builder |
| `src/index.ts` | `/api/servers` now includes `name` per server (from `MOD_TOOL_SERVERS`); `/api/roadmap` is scope-aware (`?scope=full` for mods, public slice for guests) + `public` flag on promote |
| `public/modtools/index.html` | Reworked Command UI (see §7) |
| `public/mail/inbox/index.html` | Server filter + compose dropdown show display names |
| `public/slowmode/index.html`, `public/lockdown/index.html` | Server picker shows display names (values stay slugs) |
| `AI_SETUP.md`, `public/ai-setup.md` | `MOD_TOOL_SERVERS` keys, records setup, DM row, `:local` config note |
| `public/mail-setup/index.html` | Multi-server + records walkthrough, slowmode table, `:local` note |

No changes to `src/poll.ts`, `src/discord-oauth.ts`, auth, or the inbox API.

## 2. Config (`MOD_TOOL_SERVERS` var, JSON string)

```json
{"the-east-pacific": {"guild": "633351482128728064", "name": "The East Pacific", "records_forum": "1350279828313735191", "records_tag": "<tag-id>"},
 "tep-urth": {"guild": "508790398873894915", "name": "TEP Urth"}}
```

| Key | Required | Effect |
|---|---|---|
| `guild` | yes | Enables bans/timeouts/apply for the slug |
| `name` | no | Display label in dropdowns, chips, status bar, inbox filters. Slugs stay the API values |
| `records_forum` | no | Staff-only forum channel ID → per-user record threads (see §3) |
| `records_tag` | no | Forum tag ID applied to every record thread (only needed if the forum **requires** a tag) |

In `wrangler.*.jsonc` the value is an escaped JSON string:
`"MOD_TOOL_SERVERS": "{\"slug\": {\"guild\": \"...\", \"name\": \"...\"}}"`.

## 3. Record threads (per-user forum threads)

- **Table** (`0010_user_records.sql`): `(user_id, slug)` PK → `thread_id, forum_id, guild_id, created_at, last_post_at`.
- **Create-on-first-action:** any ban / unban / timeout / timeout-remove / infraction / note / appeal-submit / appeal-decide / temp-ban-expiry / DM looks up `user_records`; missing → `POST /channels/{forum}/threads` with `{name: "{username} ({id})" (≤100 chars), auto_archive_duration: 1440 (falls back to 60 on 400), applied_tags: [records_tag] if set, message: {embeds: [intro card]}}`, then stores the row.
- **Post:** `POST /channels/{thread}/messages {embeds: [card]}`. On failure → unarchive (`PATCH {archived:false}`, needs Manage Threads) and retry once.
- **Never blocks the action:** every record call is best-effort; failures land in the API response's `record` field, e.g. `"record": {"the-east-pacific": {"error": "..."}}`.
- **Helpful errors:** tag-required forums without `records_tag` return the forum's available tags + IDs (fetched live) so the mod knows what to configure. Thread-create/post failures include Discord's message, not just the status.
- **Bot needs on the records forum:** View Channel + Send Messages + Read Message History + Manage Threads. Forum must not require tags unless `records_tag` is set.
- **Manual provision:** `POST /api/records/:user/ensure {"slug"}` creates/links on demand (Records tab → "Create / link thread").

## 4. Embed cards

Builder: `recordEmbed({title, color, userId, mod?, server?, reason?, expires?, evidenceUrl?})`.
User/mod render as `<@id>` mentions — **mentions inside embeds don't ping**, safe for staff channels. Evidence links point at `/mail/inbox/?q={id}` on the community domain.

| Card | Color |
|---|---|
| Ban permanent / temporary | `0xED4245` |
| Unban, timeout-removed, appeal-approved | `0x3BA55D` |
| Timeout (`Timeout — {mins} min`, expires field) | `0xE8913A` |
| Infraction (`Infraction ({type})`) | `0xFEE75C` |
| Mod note | `0x99AAB5` |
| Appeal submitted / decided | `0x5865F2` / red on deny |
| Temp ban expired | `0x808080` |
| DM sent (mirror, includes full message) | `0x5865F2` |
| Record opened (thread intro) | `0x5865F2` |

DM-to-user card: title `Notice from {Server Name} Moderation Team`, description = message, fields Server + Action (inline), `image: {url: "https://<host>/assets/notice.png"}` (repo-hosted banner, `public/assets/notice.png`), footer **"Do Not Reply: replies to this bot are not monitored."**, color `5793266`, timestamp. Mentions aren't used in the user-facing card.

## 5. New endpoints (all behind existing mod auth)

| Endpoint | Use |
|---|---|
| `GET /api/records/:user` | Record threads (`slug, thread_id, url, last_post_at`) + full D1 timeline |
| `POST /api/records/:user/ensure {"slug"}` | Create/link a thread now |
| `GET /api/records?limit=` | Recent record threads |
| `POST /api/dm {user_id, server?, action?, message}` | Bot DM (see §8) |
| `GET /api/modtools/servers` | Unchanged shape `{servers: [slugs], names: {slug: label}}` (+ `discourse` entry when configured) |
| `GET /api/servers` | Each entry now also has `name` |

Timeline builder was extracted to shared `buildTimeline(db, user)` (bans+timeouts+infractions+appeals+notes, newest first). Ban/timeout/unban execution was extracted to shared `coreCreateBan` / `coreCreateTimeout` / `coreUnbanRow` / `coreUnbanUser` used by both REST and slash paths.

## 6. Discord slash commands (/ban, /timeout, /unban)

- `src/index.ts` handles interaction type 2 (application command) in `/hooks/discord-interactions`: verifies the caller holds a `DISCORD_MOD_ROLE_IDS` role from the interaction member list, then **defers** (`type: 5`, ephemeral) and runs `handleSlashCommand()` from `modtools.ts` inside `waitUntil`, editing the deferred message with the result via webhook PATCH. Never blocks the 3s window.
- Server picker: static `choices` built from `MOD_TOOL_SERVERS` at registration; omitting it defaults to the guild the command was used in (matched to a slug), else the first configured server.
- Registration (`POST /api/admin/register-commands`, mod session): bulk PUTs the guild command set (Save as Idea + 3 slash commands with `default_member_permissions` and `dm_permission: false`) and deletes stray globals. Re-running is idempotent. Needs the `applications.commands` scope in the guild.

## 7. Command UI (`public/modtools/index.html`)

- Tabs: Bans · Timeouts · **History** (was Infractions, now **read-only lookup** — the Add form is gone) · Appeals · Notes · Records · **DM** (new).
- Status bar appears only when something needs attention (loading failure / no servers + **Retry**); when healthy it hides — the server names are already visible in every dropdown and chip. Selects ship with a `Loading servers…` option so they are never blank; action buttons stay disabled until servers load; ban chips show a hint instead of emptiness.
- Toasts replace `alert()` popups; kind badges styled; sticky tabs; per-pane hint lines.
- Infractions/Notes pick a server (routes the record-thread post; falls back to the first forum-configured server).
- History + Records panes share `detailFor()` rendering; `?user=` deep-links into History/Notes/Records.
- Slowmode/Lockdown planners + inbox filters: option **labels** are display names, **values** stay slugs.
- Inbox detail Moderate row (`public/mail/inbox/index.html`): server picker (defaults to the item's server), inline Ban (confirm dialog, auto-DM invite on) and Timeout (minutes prompt), Notes lookup, and Command ↗ opening a new tab with `?user=` prefilled. Appeal items get inline **Approve + unban / Deny** (matched to the open appeal by author ID) and **no** Moderate row; deciding auto-completes the item like pressing E. Visibility: tickets (incl. staff-server), support, and mailed items show Moderate; appeals show only Approve/Deny; ideas and roadmap-flagged items show neither. Roadmap section itself shows only on forum/bot-captured ideas, all support items, and already-flagged items.
- Inbox detail (`public/mail/inbox/index.html` `toolCard`): any JSON content without a `tool` card (appeal answers, mailed plans, apply results) renders as key/value rows only — raw JSON is hidden. List previews show the apology text for appeals, labels for tool exports, and a placeholder for anything else.
- Timestamps: `time` columns now store real ISO datetimes; the inbox renders relative dates from `created_at` ("just now" → "Mar 4, 2026"), fixing the old literal "now" labels on every mailed item, retroactively.

## 8. DM behavior (one-way by design)

`POST /api/dm` opens/creates the DM channel (`POST /users/@me/channels`) and sends the card. Replies from users are **not** monitored — the card and the UI say so. Closed DMs return `DMs closed — …` (HTTP 403 from Discord); unknown users return `Unknown user`. 10/min per-mod rate limit, audit-logged (`dm` / `dm_failed`), mirrored to the record thread when the slug has a forum.

## 9. Appeal invite links (expiring, single-use)

- **Table** (`migrations/0011_appeal_links.sql`): `token_hash` PK (SHA-256, plaintext shown once) → `ban_id, user_id, created_by, created_at, expires_at, used_at`.
- **Mint:** `POST /api/appeal-links {ban_id, days?}` (mod auth; ban must be active; days 1–30, default 7) → `{url: "https://<host>/appeals/?token=…", expires_at}`. Ban rows have an **Invite** button that mints and pre-fills the DM tab with the link. **Auto-DM on ban:** `POST /api/bans` accepts `dm_invite` (default true; uncheck "DM appeal link" to skip) — mints the link and DMs it in the same second the ban lands, mirrors the outcome to the record thread. One live link per ban: minting supersedes (retires) previous unused links. `GET /api/bans` flags live links (`invite_active`, `invite_expires_at`), shown as a 🔗 badge; the button reads "New link" when one exists.
- **Use:** public `/appeals/` form (`public/appeals/index.html`, pruned from the tools-only build). With `?token=` it shows ban context via `GET /hooks/appeal-link?token=` (reason, dates, expiry, 404/410 on bad/used/expired), then submits `{token, answers}` to `POST /hooks/appeal`, which validates the token and marks it used. **Without a token** the form finds active bans by user ID via `GET /hooks/appeal-lookup?user_id=` (20/min per IP) and submits `{ban_id, user_id, answers}` through the same guarded endpoint. No link delivery needed — the URL is static and can live in the rules.
- **Rules:** one appeal per user, ever (`403` afterwards); per-ban wait via `bans.appeal_wait_days` (`migration 0012`, set from the Ban form, 0 = immediate, enforced server-side + shown on the form as "Appeals open {date}").
- **Routing fix (`src/index.ts`):** `app.route('/', modTools)` is mounted *before* the generic `POST /hooks/:name` adapter — Hono matches overlapping routes in registration order, so the adapter was swallowing `POST /hooks/appeal*` ("Unknown adapter: appeal"). No path overlaps with the inbox's own `/api/*` routes, so the move is safe.
- No new bot permissions (DM channel already works).

## 10. Appeals: waits, one-per-user, login gates

- **Table** (`migrations/0012_ban_appeal_wait.sql`): `bans.appeal_wait_days INTEGER NOT NULL DEFAULT 0`.
- **Wait:** Ban form "Appeal wait days" → `POST /api/bans {appeal_wait_days}` (0–3650, default 0). `POST /hooks/appeal` rejects early submits (`403 Appeals open {date}`); tokeninfo/lookup responses carry `eligible_at`, and the form disables submit until open.
- **One appeal per user, ever:** second submits get `403 You have already used your one appeal` (replaces the old 24h rule).
- **Login gates:** `/mail/`, `/mail/inbox/`, `/ideas/` skip the demo fallback when `GET /api/health` reports `env: community` — logged-out visitors get the locked screen instead. Marketing/personal keeps the badged demo.
- **Forum log storage:** `archiveToDiscourse()` in `src/index.ts` posts one topic per purged item to a staff-only subcategory (`DISCOURSE_BASE_URL` + `DISCOURSE_ADMIN_KEY` — same key as suspend sync — + `DISCOURSE_ARCHIVE_CATEGORY_ID` var; any configured backend — GitHub, Discord, Discourse — runs each purge). `POST /api/admin/archive-test` (mod auth) posts one clearly-labelled topic to verify base URL + key + category + permissions. Set the three values, redeploy, run archive-test, check the subcategory, delete the test topic.

## 11. Roadmap: public slice vs full board

- **Table** (`migrations/0013_roadmap_public.sql`): `inbox_items.roadmap_public INTEGER NOT NULL DEFAULT 0` (existing items stay mod-only).
- **API:** `GET /api/roadmap` returns the full board for authed mods (`?scope=full` explicit), only `roadmap_public = 1` for guests; `?scope=full` logged-out → 401. `PUBLIC_ROADMAP=0` still 401s guests entirely (middleware). `POST /api/inbox/:id/roadmap` accepts `public: boolean` (Inbox detail → Public checkbox).
- **UI:** `/roadmap/` detects the session — mods see "Full board (mod view)" with 🌐 badges on public items, guests see the public slice with a log-in nudge.

## 12. Deploy + verify

```powershell
npm run db:migrate:remote:community   # applies 0010 (and any pending)
npm run deploy:community
curl https://<host>/api/health        # {"ok":true,...}
# logged in: /modtools/ status bar green, both names listed
# Records tab → Create/link thread on a throwaway → thread appears in the forum
# Timeout the throwaway → card lands in the same thread
```

Rollback: `npx wrangler versions list --config wrangler.community.jsonc` → `wrangler rollback <id>`.
