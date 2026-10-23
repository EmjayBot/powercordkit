// Mod tools: Ban Sync, Timeouts, Infractions, Appeals, User Notes.
// Mounted at app.route('/', modTools) so the existing /api auth + /hooks guards apply.
import { Hono } from 'hono';
import { verifySession, readCookie } from './discord-oauth';

type Env = {
  DB: D1Database;
  MOD_TOOL_SERVERS?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCOURSE_BASE_URL?: string;
  DISCOURSE_ADMIN_KEY?: string;
  SESSION_SECRET?: string;
  COMMUNITY_DOMAIN?: string;
  PERSONAL_DOMAIN?: string;
};

const mod = new Hono<{ Bindings: Env }>();

const newId = () => crypto.randomUUID();
const jsonLog = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, tool: 'modtools', ...extra }));
const bad = (msg: string, status = 400) => Response.json({ ok: false, error: msg }, { status });

async function readJson<T>(c: any): Promise<T> {
  const raw = await c.req.text();
  if (raw.length > 262144) throw new Response('Payload too large', { status: 413 });
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }
}

type ToolServers = Record<string, { guild?: string; records_forum?: string; records_tag?: string; name?: string }>;
function toolServers(env: Env): ToolServers {
  try {
    const v = JSON.parse(env.MOD_TOOL_SERVERS ?? '{}');
    return v && typeof v === 'object' ? (v as ToolServers) : {};
  } catch {
    return {};
  }
}

async function actingMod(env: Env, headers: Headers): Promise<string> {
  const sess = env.SESSION_SECRET ? await verifySession(readCookie(headers.get('cookie'), 'pck_session'), env.SESSION_SECRET) : null;
  return (sess?.uid as string) || 'mod-key';
}

// Identity links: Discord <-> forum accounts with different usernames.
// discord_id = Discord snowflake, platform = 'discourse' | 'nodebb' | ...,
// external_id = forum user id (for API suspend), external_username display only.
export async function upsertIdentityLink(
  db: D1Database,
  discordId: string,
  platform: string,
  externalId: string,
  externalUsername: string,
  verified: number,
  linkedBy: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO identity_links (discord_id, platform, external_id, external_username, verified, linked_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(discord_id, platform)
       DO UPDATE SET external_id = excluded.external_id, external_username = excluded.external_username,
         verified = MAX(identity_links.verified, excluded.verified), linked_by = excluded.linked_by`,
    )
    .bind(discordId, platform, externalId, externalUsername, verified, linkedBy, new Date().toISOString())
    .run();
}

async function resolveForumId(db: D1Database, discordId: string, platform: string): Promise<{ id: string; username: string } | null> {
  try {
    const row = await db
      .prepare('SELECT external_id, external_username FROM identity_links WHERE discord_id = ? AND platform = ?')
      .bind(discordId, platform)
      .first<{ external_id: string; external_username: string }>();
    return row ? { id: row.external_id, username: row.external_username } : null;
  } catch {
    // Pre-migration: no links table yet.
    return null;
  }
}

// Advertise the configured server slugs so the UI is never hardcoded to one community.
// `servers` stays a plain slug array (planner pages depend on it); `names` carries
// optional display labels ("slug" -> "The East Pacific") for dropdowns and filters.
mod.get('/api/modtools/servers', (c) => {
  const map = toolServers(c.env);
  const servers = Object.keys(map);
  const names: Record<string, string> = {};
  for (const slug of servers) if (map[slug]?.name) names[slug] = map[slug].name as string;
  if (c.env.DISCOURSE_BASE_URL && c.env.DISCOURSE_ADMIN_KEY && !servers.includes('discourse')) {
    servers.push('discourse');
    names['discourse'] = 'Discourse';
  }
  return c.json({ ok: true, servers, names });
});

function fixedWindowKey(key: string): string {
  return key;
}

// D1-backed fixed-window rate limit. Works across Workers isolates
// (the old in-memory Map did not). Returns true when allowed.
async function checkRateLimit(db: D1Database, key: string, max: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  try {
    const row = await db
      .prepare('SELECT count, window_start FROM rate_limits WHERE key = ?')
      .bind(fixedWindowKey(key))
      .first<{ count: number; window_start: string }>();
    const windowStart = row ? Date.parse(row.window_start) : NaN;
    if (!row || Number.isNaN(windowStart) || now - windowStart >= windowMs) {
      await db
        .prepare(
          'INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start',
        )
        .bind(fixedWindowKey(key), new Date(now).toISOString())
        .run();
      return true;
    }
    if (row.count >= max) return false;
    await db
      .prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?')
      .bind(fixedWindowKey(key))
      .run();
    return true;
  } catch {
    // Fail open if the table doesn't exist yet (pre-migration): don't block mods.
    return true;
  }
}

async function audit(db: D1Database, e: { action: string; user_id?: string; mod_id?: string; detail?: unknown }) {
  try {
    await db
      .prepare('INSERT INTO audit_log (id, action, user_id, mod_id, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(newId(), e.action, e.user_id ?? null, e.mod_id ?? null, null, JSON.stringify(e.detail ?? {}), new Date().toISOString())
      .run();
  } catch {
    /* audit best-effort */
  }
}

async function discordReq(token: string, method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number }> {
  const r = await fetch('https://discord.com/api/v10' + path, {
    method,
    headers: { Authorization: 'Bot ' + token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: r.ok, status: r.status };
}

// ------------------------------------------------------------------ Record threads
// Per-user mod record: each (user, server slug) links to one thread in a
// staff-only Discord forum channel (per slug via `records_forum` in
// MOD_TOOL_SERVERS). The first Command action creates the thread; every later
// action posts into the same thread, so the forum post mirrors the D1 history.
// Best-effort throughout: a record failure never fails the mod action itself.
function recordUrl(guildId: string, threadId: string): string {
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

// First slug with a records forum configured (fallback for server-less actions).
function recordSlug(env: Env, preferred?: string | null): string | null {
  const map = toolServers(env);
  if (preferred && map[preferred]?.records_forum) return preferred;
  return Object.keys(map).find((s) => map[s]?.records_forum) ?? null;
}

async function discordUsername(token: string, userId: string): Promise<string | null> {
  try {
    const r = await fetch(`https://discord.com/api/v10/users/${userId}`, {
      headers: { Authorization: 'Bot ' + token },
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const name = j?.global_name || j?.username;
    return typeof name === 'string' && name ? name : null;
  } catch {
    return null;
  }
}

// Find the record thread for (user, slug), creating it on first use.
async function ensureRecordThread(
  db: D1Database,
  env: Env,
  slug: string,
  userId: string,
): Promise<{ thread_id: string; guild: string; created: boolean } | { error: string }> {
  const cfg = toolServers(env)[slug];
  if (!cfg?.guild) return { error: 'unknown server slug' };
  if (!cfg.records_forum) return { error: `no records forum configured for ${slug}` };
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return { error: 'bot token not configured' };
  try {
    const existing = await db
      .prepare('SELECT thread_id FROM user_records WHERE user_id = ? AND slug = ?')
      .bind(userId, slug)
      .first<{ thread_id: string }>();
    if (existing?.thread_id) return { thread_id: existing.thread_id, guild: cfg.guild, created: false };
  } catch {
    return { error: 'records table not migrated (need 0010_user_records)' };
  }
  // Forum threads are created with an initial message. If the forum requires
  // tags, set `records_tag` (a tag ID from that forum) on the slug — it is
  // applied to every record thread. 1440 = auto-archive after 24h idle; any
  // new action post un-archives it.
  const uname = await discordUsername(token, userId);
  const name = `${uname ?? 'user'} (${userId})`.slice(0, 100);
  const intro = recordEmbed({
    title: '📋 Mod record opened',
    color: 0x5865f2,
    userId,
    reason: `Tracking history for ${uname ? `${uname} (${userId})` : userId}. Every Command action on this user is posted here as a card.`,
  });
  const discordErr = (r: { status: number; data?: any }) => {
    const d = r.data ?? {};
    const detail = typeof d === 'object' ? (d.message ?? JSON.stringify(d).slice(0, 300)) : String(d);
    return `${r.status}: ${detail}`;
  };
  const tagIds = cfg.records_tag ? [cfg.records_tag] : [];
  const makeThread = (archiveMins: number) =>
    discordJson(token, 'POST', `/channels/${cfg.records_forum}/threads`, {
      name,
      auto_archive_duration: archiveMins,
      ...(tagIds.length ? { applied_tags: tagIds } : {}),
      message: { embeds: [intro] },
    });
  let r = await makeThread(1440);
  if (!r.ok && r.status === 400) {
    // 1440 needs no boost on most guilds, but fall back to 60 (universal) once.
    r = await makeThread(60);
  }
  if (!r.ok && /tag/i.test(JSON.stringify(r.data ?? {})) && !tagIds.length) {
    // Forum requires a tag and none is configured: list what's available so the
    // mod knows which tag ID to put in records_tag.
    const ch = await discordJson(token, 'GET', `/channels/${cfg.records_forum}`);
    const tags = (ch.data as any)?.available_tags;
    const listing = Array.isArray(tags) && tags.length
      ? tags.map((t: any) => `${t?.name ?? '?'} (${t?.id ?? '?'})`).join(', ')
      : 'none visible';
    return { error: `forum requires a tag — add "records_tag": "<tag-id>" to slug ${slug} in MOD_TOOL_SERVERS. Available tags: ${listing}` };
  }
  if (!r.ok || !r.data?.id) return { error: `thread create failed (${discordErr(r)})` };
  const threadId = String(r.data.id);
  await db
    .prepare(
      'INSERT INTO user_records (user_id, slug, thread_id, forum_id, guild_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, slug) DO UPDATE SET thread_id = excluded.thread_id',
    )
    .bind(userId, slug, threadId, cfg.records_forum, cfg.guild, new Date().toISOString())
    .run();
  return { thread_id: threadId, guild: cfg.guild, created: true };
}

// Inbox deep-link for an evidence mail item.
function inboxUrl(env: Env, mailId: string): string {
  const host = env.COMMUNITY_DOMAIN || env.PERSONAL_DOMAIN || 'mod.tep.one';
  return `https://${host}/mail/inbox/?q=${encodeURIComponent(mailId)}`;
}

// Absolute URL for a file under /assets (Discord embeds need absolute URLs).
function assetUrl(env: Env, file: string): string {
  const host = env.COMMUNITY_DOMAIN || env.PERSONAL_DOMAIN || 'mod.tep.one';
  return `https://${host}/assets/${file}`;
}

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function mention(id: string): string {
  return /^\d{10,}$/.test(id) ? `<@${id}>` : `\`${id}\``;
}

// Rich record-thread card: clickable user/mod mentions, reason, server, expiry,
// evidence link. Colors follow Discord semantics (red = ban, green = resolved).
function recordEmbed(opts: {
  title: string;
  color: number;
  userId: string;
  mod?: string;
  server?: string;
  reason?: string;
  expires?: string | null;
  evidenceUrl?: string;
}): Record<string, unknown> {
  const fields: Record<string, unknown>[] = [
    { name: 'User', value: `${mention(opts.userId)} (\`${opts.userId}\`)`, inline: true },
  ];
  if (opts.mod) fields.push({ name: 'Moderator', value: mention(opts.mod), inline: true });
  if (opts.server) fields.push({ name: 'Server', value: opts.server, inline: true });
  if (opts.expires !== undefined) fields.push({ name: 'Expires', value: opts.expires ?? 'Permanent', inline: true });
  if (opts.evidenceUrl) fields.push({ name: 'Evidence', value: `[Open in inbox](${opts.evidenceUrl})` });
  return {
    title: opts.title.slice(0, 256),
    description: (opts.reason ?? '').slice(0, 4000) || undefined,
    color: opts.color,
    fields,
    timestamp: new Date().toISOString(),
  };
}

// Post one action line to the user's record thread (un-archiving first if needed).
async function postRecord(
  db: D1Database,
  env: Env,
  slug: string,
  userId: string,
  embed: Record<string, unknown>,
): Promise<{ thread_id?: string; error?: string }> {
  const ensured = await ensureRecordThread(db, env, slug, userId);
  if (!('thread_id' in ensured)) return { error: ensured.error };
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return { error: 'bot token not configured' };
  // Mentions inside embeds render clickable but never ping — safe in staff channels.
  const body = { embeds: [embed] };
  let r = await discordJson(token, 'POST', `/channels/${ensured.thread_id}/messages`, body);
  if (!r.ok) {
    // Thread probably archived: unarchive (needs Manage Threads) and retry once.
    await discordJson(token, 'PATCH', `/channels/${ensured.thread_id}`, { archived: false });
    r = await discordJson(token, 'POST', `/channels/${ensured.thread_id}/messages`, body);
  }
  if (!r.ok) return { error: `post failed (${r.status}: ${typeof r.data === 'object' ? (r.data?.message ?? JSON.stringify(r.data).slice(0, 200)) : String(r.data ?? '')})` };
  try {
    await db
      .prepare('UPDATE user_records SET last_post_at = ? WHERE user_id = ? AND slug = ?')
      .bind(new Date().toISOString(), userId, slug)
      .run();
  } catch {
    /* last_post_at best-effort */
  }
  return { thread_id: ensured.thread_id };
}

async function suspendDiscourse(
  db: D1Database,
  env: Env,
  discordId: string,
  opts: { suspend_until: string; reason: string },
): Promise<{ ok: boolean; status?: number; error?: string } | null> {
  const base = env.DISCOURSE_BASE_URL?.replace(/\/$/, '');
  if (!base || !env.DISCOURSE_ADMIN_KEY) return null;
  const link = await resolveForumId(db, discordId, 'discourse');
  if (!link) return { ok: false, error: 'no linked discourse account' };
  try {
    const r = await fetch(`${base}/admin/users/${link.id}/suspend.json`, {
      method: 'POST',
      headers: { 'Api-Key': env.DISCOURSE_ADMIN_KEY, 'Api-Username': 'system', 'content-type': 'application/json' },
      body: JSON.stringify({ suspend_until: opts.suspend_until, reason: opts.reason }),
    });
    return { ok: r.ok, status: r.status };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function unsuspendDiscourse(
  db: D1Database,
  env: Env,
  discordId: string,
): Promise<{ ok: boolean; status?: number; error?: string } | null> {
  const base = env.DISCOURSE_BASE_URL?.replace(/\/$/, '');
  if (!base || !env.DISCOURSE_ADMIN_KEY) return null;
  const link = await resolveForumId(db, discordId, 'discourse');
  if (!link) return { ok: false, error: 'no linked discourse account' };
  try {
    const r = await fetch(`${base}/admin/users/${link.id}/unsuspend.json`, {
      method: 'POST',
      headers: { 'Api-Key': env.DISCOURSE_ADMIN_KEY, 'Api-Username': 'system' },
    });
    return { ok: r.ok, status: r.status };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Unban everywhere a ban row covers (Discord guilds + Discourse).
// Best-effort: callers still deactivate the row even when a remote fails.
async function unbanEverywhere(
  db: D1Database,
  env: Env,
  ban: { user_id: string; servers_json?: string | null },
): Promise<Record<string, { ok: boolean; status?: number; error?: string }>> {
  const results: Record<string, { ok: boolean; status?: number; error?: string }> = {};
  const servers = JSON.parse(ban.servers_json || '[]') as string[];
  const map = toolServers(env);
  const token = env.DISCORD_BOT_TOKEN;
  if (token) {
    for (const slug of servers) {
      if (slug === 'discourse') continue;
      const g = map[slug];
      if (!g?.guild) {
        results[slug] = { ok: false, error: 'unknown server slug' };
        continue;
      }
      const r = await discordJson(token, 'DELETE', `/guilds/${g.guild}/bans/${ban.user_id}`);
      // 404 = already unbanned on Discord: treat as success so the row still clears.
      results[slug] = r.ok || r.status === 404
        ? { ok: true, status: r.status }
        : { ok: false, status: r.status, error: discordMsg(r) };
    }
  } else {
    for (const slug of servers) {
      if (slug !== 'discourse') results[slug] = { ok: false, error: 'bot token not configured' };
    }
  }
  if (servers.includes('discourse')) {
    const r = await unsuspendDiscourse(db, env, ban.user_id);
    results.discourse = r ?? { ok: false, error: 'discourse not configured' };
  }
  return results;
}

// Expire temp bans whose expires_at passed: unban remotely, deactivate,
// audit. Returns count deactivated.
export async function expireBans(db: D1Database, env: Env): Promise<number> {
  const now = new Date().toISOString();
  const rows = await db
    .prepare('SELECT id, user_id, servers_json FROM bans WHERE is_active = 1 AND expires_at IS NOT NULL AND expires_at < ? LIMIT 50')
    .bind(now)
    .all<{ id: string; user_id: string; servers_json: string }>();
  const list = rows.results ?? [];
  for (const row of list) {
    try {
      await unbanEverywhere(db, env, row);
    } catch (err) {
      jsonLog('warn', 'expire ban remote failed', { id: row.id, error: String(err) });
    }
    await db.prepare('UPDATE bans SET is_active = 0 WHERE id = ?').bind(row.id).run();
    await audit(db, { action: 'ban_expire', user_id: row.user_id, detail: { ban: row.id } });
    for (const slug of JSON.parse(row.servers_json || '[]')) {
      if (slug === 'discourse') continue;
      await postRecord(db, env, String(slug), row.user_id, recordEmbed({
        title: '⏳ Temp ban expired',
        color: 0x808080,
        userId: row.user_id,
        server: String(slug),
      }));
    }
  }
  return list.length;
}

// ------------------------------------------------------------------ Bans
mod.post('/api/bans', async (c) => {
  try {
    const token = c.env.DISCORD_BOT_TOKEN;
    if (!token) return bad('Bot token not configured', 400);
    const body = await readJson<{ user_id?: string; reason?: string; servers?: string[]; duration_minutes?: number; evidence_mail_id?: string; delete_days?: number; dm_invite?: boolean; appeal_wait_days?: number }>(c);
    const uid = (body.user_id ?? '').trim();
    const reason = (body.reason ?? '').slice(0, 1000);
    const servers = Array.isArray(body.servers) ? [...new Set(body.servers.filter(Boolean))] : [];
    if (!/^\d{10,}$/.test(uid)) return bad('valid user_id required', 400);
    if (!reason) return bad('reason required', 400);
    if (!servers.length) return bad('at least one server required', 400);
    const modId = await actingMod(c.env, c.req.raw.headers);
    if (!(await checkRateLimit(c.env.DB, 'ban:' + modId, 5, 60000)))
      return Response.json({ ok: false, error: 'Rate limited' }, { status: 429 });
    const map = toolServers(c.env);
    const results: Record<string, { ok: boolean; status?: number; error?: string }> = {};
    for (const slug of servers) {
      if (slug === 'discourse') continue;
      const g = map[slug];
      if (!g?.guild) {
        results[slug] = { ok: false, error: 'unknown server slug' };
        continue;
      }
      const r = await discordJson(token, 'PUT', `/guilds/${g.guild}/bans/${uid}`, { reason, delete_message_seconds: Math.min(Math.max(body.delete_days ?? 0, 0), 7) * 86400 });
      results[slug] = r.ok ? { ok: true, status: r.status } : { ok: false, status: r.status, error: discordMsg(r) };
    }
    if (servers.includes('discourse')) {
      const r = await suspendDiscourse(c.env.DB, c.env, uid, {
        suspend_until: body.duration_minutes ? new Date(Date.now() + body.duration_minutes * 60000).toISOString() : '2038-01-01T00:00:00Z',
        reason,
      });
      results.discourse = r ?? { ok: false, error: 'discourse not configured' };
    }
    if (!Object.values(results).some((x) => x.ok)) return c.json({ ok: false, results }, 400);
    const id = newId();
    const expires = body.duration_minutes ? new Date(Date.now() + body.duration_minutes * 60000).toISOString() : null;
    const waitDays = Math.min(Math.max(Number(body.appeal_wait_days ?? 0) || 0, 0), 3650);
    await c.env.DB.prepare(
      'INSERT INTO bans (id, user_id, reason, mod_id, servers_json, evidence_mail_id, created_at, expires_at, is_active, appeal_wait_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
    ).bind(id, uid, reason, modId, JSON.stringify(servers), body.evidence_mail_id ?? null, new Date().toISOString(), expires, waitDays).run();
    await audit(c.env.DB, { action: 'ban', user_id: uid, mod_id: modId, detail: { servers } });
    const record: Record<string, { thread_id?: string; error?: string }> = {};
    for (const slug of servers) {
      if (slug === 'discourse') continue;
      record[slug] = await postRecord(c.env.DB, c.env, slug, uid, recordEmbed({
        title: expires ? '🔨 Ban — temporary' : '🔨 Ban — permanent',
        color: 0xed4245,
        userId: uid,
        mod: modId,
        server: slug,
        reason,
        expires,
        evidenceUrl: body.evidence_mail_id ? inboxUrl(c.env, body.evidence_mail_id) : undefined,
      }));
    }
    // Auto appeal invite: mint the link and DM it in the same second the ban
    // lands (best deliverability — the user may never be reachable again).
    // Opt out per-ban with {"dm_invite": false}.
    let invite: { url?: string; expires_at?: string; error?: string } | undefined;
    let dm: { sent?: boolean; error?: string } | undefined;
    if (body.dm_invite !== false && c.env.DISCORD_BOT_TOKEN) {
      try {
        const link = await mintAppealLink(c.env.DB, c.env, modId, id, uid, 7);
        invite = { url: link.url, expires_at: link.expires_at };
        const first = servers.find((s) => s !== 'discourse') ?? '';
        const sname = toolServers(c.env)[first]?.name || first || 'the server';
        const res = await sendModDM(c.env, uid, {
          title: `Notice from ${sname} Moderation Team`,
          description: `You have been banned${expires ? ' until ' + expires : ''}. Reason: ${reason}\n\nYou can appeal here (one use, expires ${link.expires_at.slice(0, 10)}): ${link.url}`.slice(0, 4000),
          color: 5793266,
          fields: [
            { name: 'Server', value: sname === 'the server' ? '—' : sname, inline: true },
            { name: 'Action', value: expires ? 'Ban — temporary' : 'Ban — permanent', inline: true },
          ],
          image: { url: assetUrl(c.env, 'notice.png') },
          footer: { text: 'Do Not Reply: replies to this bot are not monitored.' },
          timestamp: new Date().toISOString(),
        });
        if (res.channel_id) {
          dm = { sent: true };
          await audit(c.env.DB, { action: 'dm', user_id: uid, mod_id: modId, detail: { server: first, auto: true, ban: id } });
        } else {
          dm = { error: res.error };
          await audit(c.env.DB, { action: 'dm_failed', user_id: uid, mod_id: modId, detail: { server: first, auto: true, ban: id } });
        }
        if (first && toolServers(c.env)[first]?.records_forum) {
          await postRecord(c.env.DB, c.env, first, uid, recordEmbed({
            title: '📩 Appeal invite auto-DM’d',
            color: 0x5865f2,
            userId: uid,
            mod: modId,
            server: first,
            reason: dm.sent ? `Invite link DM'd (expires ${link.expires_at.slice(0, 10)}).` : `Auto-DM failed: ${dm.error}`,
          })).catch(() => {});
        }
      } catch (err) {
        invite = { error: String(err) };
      }
    }
    return c.json({ ok: true, id, results, record, invite, dm });
  } catch (err) {
    jsonLog('error', 'ban create failed', { error: String(err) });
    return bad('Failed to create ban', 500);
  }
});

mod.get('/api/bans', async (c) => {
  const res = await c.env.DB.prepare('SELECT * FROM bans ORDER BY created_at DESC LIMIT 100').all();
  const items: any[] = res.results ?? [];
  // Flag bans with a live (unused, unexpired) invite link so the UI can show it.
  try {
    const links = await c.env.DB.prepare(
      'SELECT ban_id, expires_at FROM appeal_links WHERE used_at IS NULL AND expires_at > ?',
    ).bind(new Date().toISOString()).all<{ ban_id: string; expires_at: string }>();
    const live = new Map((links.results ?? []).map((l) => [l.ban_id, l.expires_at]));
    for (const b of items) {
      if (live.has(b.id)) {
        b.invite_active = true;
        b.invite_expires_at = live.get(b.id);
      }
    }
  } catch {
    /* pre-migration: no links table yet */
  }
  return c.json({ ok: true, items });
});

mod.post('/api/bans/:id/unban', async (c) => {
  try {
    const id = c.req.param('id');
    const row: any = await c.env.DB.prepare('SELECT * FROM bans WHERE id = ?').bind(id).first();
    if (!row) return bad('ban not found', 404);
    if (!row.is_active) return c.json({ ok: true, already: true });
    const results = await unbanEverywhere(c.env.DB, c.env, row);
    await c.env.DB.prepare('UPDATE bans SET is_active = 0 WHERE id = ?').bind(id).run();
    await audit(c.env.DB, { action: 'unban', user_id: row.user_id, detail: { servers: JSON.parse(row.servers_json || '[]') } });
    const record: Record<string, { thread_id?: string; error?: string }> = {};
    try {
      for (const slug of JSON.parse(row.servers_json || '[]')) {
        if (slug === 'discourse') continue;
        record[slug] = await postRecord(c.env.DB, c.env, String(slug), String(row.user_id), recordEmbed({
          title: '🔓 Unbanned',
          color: 0x3ba55d,
          userId: String(row.user_id),
          server: String(slug),
        }));
      }
    } catch (err) {
      jsonLog('warn', 'unban record post failed', { id, error: String(err) });
    }
    return c.json({ ok: true, results, record });
  } catch (err) {
    jsonLog('error', 'unban failed', { error: String(err) });
    return bad('Failed to unban', 500);
  }
});

// ------------------------------------------------------------------ Timeouts
mod.post('/api/timeouts', async (c) => {
  try {
    const token = c.env.DISCORD_BOT_TOKEN;
    if (!token) return bad('Bot token not configured', 400);
    const body = await readJson<{ user_id?: string; reason?: string; server?: string; duration_minutes?: number }>(c);
    const uid = (body.user_id ?? '').trim();
    const g = toolServers(c.env)[body.server ?? ''];
    if (!/^\d{10,}$/.test(uid)) return bad('valid user_id required', 400);
    if (!g?.guild) return bad('unknown server slug', 400);
    const mins = Math.min(Math.max(body.duration_minutes ?? 60, 1), 40320);
    const modId = await actingMod(c.env, c.req.raw.headers);
    if (!(await checkRateLimit(c.env.DB, 'timeout:' + modId, 10, 60000)))
      return Response.json({ ok: false, error: 'Rate limited' }, { status: 429 });
    const until = new Date(Date.now() + mins * 60000).toISOString();
    const r = await discordJson(token, 'PATCH', `/guilds/${g.guild}/members/${uid}`, { communication_disabled_until: until });
    if (!r.ok) return c.json({ ok: false, status: r.status, error: discordMsg(r) }, 400);
    const id = newId();
    await c.env.DB.prepare(
      'INSERT INTO timeouts (id, user_id, reason, mod_id, server_id, expires_at, created_at, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
    ).bind(id, uid, (body.reason ?? '').slice(0, 400), modId, body.server, until, new Date().toISOString()).run();
    await audit(c.env.DB, { action: 'timeout', user_id: uid, mod_id: modId, detail: { server: body.server, mins } });
    const record = await postRecord(c.env.DB, c.env, body.server ?? '', uid, recordEmbed({
      title: `⏱️ Timeout — ${mins} min`,
      color: 0xe8913a,
      userId: uid,
      mod: modId,
      server: body.server ?? '',
      reason: body.reason ?? '',
      expires: until,
    }));
    return c.json({ ok: true, id, expires_at: until, record });
  } catch (err) {
    jsonLog('error', 'timeout create failed', { error: String(err) });
    return bad('Failed to set timeout', 500);
  }
});

mod.get('/api/timeouts', async (c) => {
  const active = c.req.query('active') === '1';
  const q = active
    ? 'SELECT * FROM timeouts WHERE is_active = 1 ORDER BY expires_at ASC LIMIT 200'
    : 'SELECT * FROM timeouts ORDER BY created_at DESC LIMIT 200';
  const res = await c.env.DB.prepare(q).all();
  return c.json({ ok: true, items: res.results ?? [] });
});

mod.post('/api/timeouts/:id/remove', async (c) => {
  try {
    const token = c.env.DISCORD_BOT_TOKEN;
    if (!token) return bad('Bot token not configured', 400);
    const id = c.req.param('id');
    const row: any = await c.env.DB.prepare('SELECT * FROM timeouts WHERE id = ?').bind(id).first();
    if (!row) return bad('timeout not found', 404);
    const g = toolServers(c.env)[row.server_id];
    if (g?.guild) await discordReq(token, 'PATCH', `/guilds/${g.guild}/members/${row.user_id}`, { communication_disabled_until: null });
    await c.env.DB.prepare('UPDATE timeouts SET is_active = 0 WHERE id = ?').bind(id).run();
    await audit(c.env.DB, { action: 'timeout_remove', user_id: row.user_id, detail: { server: row.server_id } });
    const record = await postRecord(c.env.DB, c.env, String(row.server_id), String(row.user_id), recordEmbed({
      title: '⏱️ Timeout removed early',
      color: 0x3ba55d,
      userId: String(row.user_id),
      server: String(row.server_id),
    }));
    return c.json({ ok: true, record });
  } catch (err) {
    jsonLog('error', 'timeout remove failed', { error: String(err) });
    return bad('Failed to remove timeout', 500);
  }
});

export async function expireTimeouts(db: D1Database): Promise<number> {
  const expired = await db.prepare('SELECT id FROM timeouts WHERE is_active = 1 AND expires_at < ?').bind(new Date().toISOString()).all<{ id: string }>();
  const rows = expired.results ?? [];
  for (const row of rows) {
    await db.prepare('UPDATE timeouts SET is_active = 0 WHERE id = ?').bind(row.id).run();
  }
  return rows.length;
}

// ------------------------------------------------------------------ Infractions
mod.post('/api/infractions', async (c) => {
  try {
    const body = await readJson<{ user_id?: string; type?: string; reason?: string; server_id?: string; mail_item_id?: string }>(c);
    const type = (body.type ?? 'note').slice(0, 16);
    const allowed = ['warn', 'mute', 'kick', 'ban', 'note'];
    if (!allowed.includes(type)) return bad('invalid type', 400);
    if (!body.user_id || !body.reason) return bad('user_id and reason required', 400);
    const modId = await actingMod(c.env, c.req.raw.headers);
    if (!(await checkRateLimit(c.env.DB, 'infraction:' + modId, 20, 60000)))
      return Response.json({ ok: false, error: 'Rate limited' }, { status: 429 });
    const id = newId();
    await c.env.DB.prepare(
      'INSERT INTO infractions (id, user_id, type, reason, mod_id, server_id, mail_item_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, body.user_id, type, body.reason.slice(0, 1000), modId, body.server_id ?? null, body.mail_item_id ?? null, new Date().toISOString()).run();
    await audit(c.env.DB, { action: 'infraction_' + type, user_id: body.user_id, mod_id: modId, detail: { mail_item_id: body.mail_item_id } });
    const slug = recordSlug(c.env, body.server_id);
    const record = slug
      ? await postRecord(c.env.DB, c.env, slug, body.user_id, recordEmbed({
          title: `🗒️ Infraction (${type})`,
          color: 0xfee75c,
          userId: body.user_id,
          mod: modId,
          server: slug,
          reason: body.reason.slice(0, 1000),
          evidenceUrl: body.mail_item_id ? inboxUrl(c.env, body.mail_item_id) : undefined,
        }))
      : { error: 'no records forum configured' };
    return c.json({ ok: true, id, record });
  } catch (err) {
    jsonLog('error', 'infraction create failed', { error: String(err) });
    return bad('Failed to add infraction', 500);
  }
});

mod.get('/api/infractions', async (c) => {
  const user = c.req.query('user_id');
  if (!user) return bad('user_id required', 400);
  const res = await c.env.DB.prepare('SELECT * FROM infractions WHERE user_id = ? ORDER BY created_at DESC').bind(user).all();
  return c.json({ ok: true, items: res.results ?? [] });
});

// Shared user timeline (D1 history across all five tools).
async function buildTimeline(db: D1Database, user: string): Promise<any[]> {
  const [bans, timeouts, infs, appeals, notes] = await Promise.all([
    db.prepare('SELECT * FROM bans WHERE user_id = ? ORDER BY created_at DESC').bind(user).all(),
    db.prepare('SELECT * FROM timeouts WHERE user_id = ? ORDER BY created_at DESC').bind(user).all(),
    db.prepare('SELECT * FROM infractions WHERE user_id = ? ORDER BY created_at DESC').bind(user).all(),
    db.prepare('SELECT * FROM appeals WHERE user_id = ? ORDER BY created_at DESC').bind(user).all(),
    db.prepare('SELECT * FROM user_notes WHERE user_id = ? ORDER BY created_at DESC').bind(user).all().catch(() => ({ results: [] })),
  ]);
  const tagged = (rows: { results?: any[] }, kind: string) => (rows.results ?? []).map((r: any) => ({ kind, ...r, tag: kind }));
  return [
    ...tagged(bans, 'ban'),
    ...tagged(timeouts, 'timeout'),
    ...tagged(infs, 'infraction'),
    ...tagged(appeals, 'appeal'),
    ...tagged(notes as { results?: any[] }, 'note'),
  ].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

mod.get('/api/infractions/:user/timeline', async (c) => {
  const user = c.req.param('user');
  if (!/^\d{10,}$/.test(user)) return bad('valid user_id required', 400);
  return c.json({ ok: true, timeline: await buildTimeline(c.env.DB, user) });
});

// ------------------------------------------------------------------ Record threads API
// Search a user's record: linked forum thread(s) + full D1 timeline.
mod.get('/api/records/:user', async (c) => {
  const user = c.req.param('user');
  if (!/^\d{10,}$/.test(user)) return bad('valid user_id required', 400);
  let rows: any[] = [];
  try {
    const res = await c.env.DB.prepare(
      'SELECT slug, thread_id, forum_id, guild_id, created_at, last_post_at FROM user_records WHERE user_id = ? ORDER BY slug ASC',
    ).bind(user).all();
    rows = res.results ?? [];
  } catch {
    return c.json({ ok: false, error: 'records table not migrated (need 0010_user_records)' }, 400);
  }
  const records = rows.map((r: any) => ({ ...r, url: recordUrl(String(r.guild_id), String(r.thread_id)) }));
  return c.json({ ok: true, user_id: user, records, timeline: await buildTimeline(c.env.DB, user) });
});

// Manually create (or re-link) a user's record thread for a slug.
mod.post('/api/records/:user/ensure', async (c) => {
  const user = c.req.param('user');
  if (!/^\d{10,}$/.test(user)) return bad('valid user_id required', 400);
  const body = await readJson<{ slug?: string }>(c).catch(() => ({} as { slug?: string }));
  const slug = recordSlug(c.env, body.slug);
  if (!slug) return bad('unknown server slug, or no records forum configured', 400);
  const ensured = await ensureRecordThread(c.env.DB, c.env, slug, user);
  if (!('thread_id' in ensured)) return bad(ensured.error, 400);
  await audit(c.env.DB, { action: 'record_ensure', user_id: user, detail: { slug } });
  return c.json({ ok: true, slug, thread_id: ensured.thread_id, url: recordUrl(ensured.guild, ensured.thread_id), created: ensured.created });
});

// Browse recent record threads.
mod.get('/api/records', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200);
  try {
    const res = await c.env.DB.prepare(
      'SELECT user_id, slug, thread_id, forum_id, guild_id, created_at, last_post_at FROM user_records ORDER BY last_post_at DESC NULLS LAST, created_at DESC LIMIT ?',
    ).bind(limit).all();
    const records = (res.results ?? []).map((r: any) => ({ ...r, url: recordUrl(String(r.guild_id), String(r.thread_id)) }));
    return c.json({ ok: true, records });
  } catch {
    return c.json({ ok: false, error: 'records table not migrated (need 0010_user_records)' }, 400);
  }
});

// ------------------------------------------------------------------ Appeals
mod.post('/hooks/appeal', async (c) => {
  try {
    const body = await readJson<{ user_id?: string; ban_id?: string; token?: string; answers?: Record<string, string>; honeypot?: string }>(c);
    if (body.honeypot) return c.json({ ok: true }); // silent spam trap
    let uid = (body.user_id ?? '').trim();
    let banId = body.ban_id;
    let linkHash: string | null = null;
    if (body.token) {
      // Invite-link path: the token carries the ban + user, no IDs needed from the user.
      linkHash = await sha256hex(body.token);
      const link: any = await c.env.DB.prepare('SELECT * FROM appeal_links WHERE token_hash = ?').bind(linkHash).first().catch(() => null);
      if (!link) return bad('Invalid link', 404);
      if (link.used_at) return bad('This link has already been used', 410);
      if (link.expires_at < new Date().toISOString()) return bad('This link has expired', 410);
      uid = link.user_id;
      banId = link.ban_id;
    }
    if (!/^\d{10,}$/.test(uid)) return bad('valid user_id required', 400);
    if (!banId) return bad('ban_id required', 400);
    const ban: any = await c.env.DB.prepare('SELECT * FROM bans WHERE id = ? AND is_active = 1').bind(banId).first();
    if (!ban) return bad('No active ban found for that ID', 404);
    // The appeal must come from the banned user, not any user with a ban ID.
    if (ban.user_id !== uid) return bad('That ban does not belong to this user', 403);
    const last: any = await c.env.DB.prepare('SELECT id FROM appeals WHERE user_id = ? LIMIT 1').bind(uid).first().catch(() => null);
    if (last) return bad('You have already used your one appeal for this account', 403);
    const eligibleAt = appealEligibleAt(ban);
    if (eligibleAt > new Date().toISOString()) {
      return bad('Appeals open ' + eligibleAt.slice(0, 10) + ' for this ban', 403);
    }
    const cf = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? '';
    const ipHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cf || 'unknown')).then((d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''));
    // Per-IP spam brake: 5 appeal submits per hour (D1-backed, shared).
    if (!(await checkRateLimit(c.env.DB, 'appeal-ip:' + ipHash, 5, 3600000)))
      return Response.json({ ok: false, error: 'Too many appeals from this network, try later' }, { status: 429 });
    const entries = Object.entries(body.answers ?? {});
    if (entries.length > 20) return bad('too many answers', 400);
    const answers = entries.reduce<Record<string, string>>((o, [k, v]) => {
      o[String(k).slice(0, 80)] = String(v).slice(0, 2000);
      return o;
    }, {});
    const id = newId();
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      'INSERT INTO appeals (id, ban_id, user_id, answers_json, status, ip_hash, created_at, last_appeal_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, banId, uid, JSON.stringify(answers), 'open', ipHash, now, now).run();
    if (linkHash) {
      await c.env.DB.prepare('UPDATE appeal_links SET used_at = ? WHERE token_hash = ?').bind(now, linkHash).run();
    }
    // Create a Mail item (type=appeal) so it lands in the inbox.
    await c.env.DB.prepare(
      `INSERT INTO inbox_items (id, server, type, tag, author, title, content, time, prio, src, by, url, assigned, archived, completed, roadmap, roadmap_status, roadmap_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, '', '', ?)`,
    ).bind(newId(), 'appeals', 'appeal', 'appeal', uid, `Appeal for ban ${String(banId).slice(0, 8)}`, JSON.stringify(answers).slice(0, 4000), new Date().toISOString(), 'high', 'discord', 'appeal', '', null, now).run();
    await audit(c.env.DB, { action: 'appeal_submit', user_id: uid, detail: { ban_id: banId } });
    const record: Record<string, { thread_id?: string; error?: string }> = {};
    for (const slug of JSON.parse(ban.servers_json || '[]')) {
      if (slug === 'discourse') continue;
      record[slug] = await postRecord(c.env.DB, c.env, String(slug), uid, recordEmbed({
        title: `📩 Appeal submitted (ban ${String(banId).slice(0, 8)})`,
        color: 0x5865f2,
        userId: uid,
        server: String(slug),
      }));
    }
    return c.json({ ok: true, id, record });
  } catch (err) {
    jsonLog('error', 'appeal submit failed', { error: String(err) });
    return bad('Appeal failed', 500);
  }
});

mod.get('/api/appeals', async (c) => {
  const status = c.req.query('status') ?? 'open';
  const res = await c.env.DB.prepare('SELECT * FROM appeals WHERE status = ? ORDER BY created_at DESC LIMIT 200').bind(status).all();
  return c.json({ ok: true, items: res.results ?? [] });
});

async function decideAppeal(c: any, nextStatus: string, approve: boolean): Promise<Response> {
  try {
    const id = c.req.param('id');
    const row: any = await c.env.DB.prepare('SELECT * FROM appeals WHERE id = ?').bind(id).first();
    if (!row) return bad('appeal not found', 404);
    if (approve && row.status !== 'approved') {
      // Trigger the full unban flow for the linked ban (Discord + Discourse).
      const ban: any = await c.env.DB.prepare('SELECT * FROM bans WHERE id = ? AND is_active = 1').bind(row.ban_id).first();
      if (ban) {
        await unbanEverywhere(c.env.DB, c.env, ban);
        await c.env.DB.prepare('UPDATE bans SET is_active = 0 WHERE id = ?').bind(row.ban_id).run();
      }
    }
    const modId = await actingMod(c.env, c.req.raw.headers);
    await c.env.DB.prepare('UPDATE appeals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').bind(nextStatus, modId, new Date().toISOString(), id).run();
    await audit(c.env.DB, { action: 'appeal_' + nextStatus, user_id: row.user_id, mod_id: modId });
    const record: Record<string, { thread_id?: string; error?: string }> = {};
    const banRow: any = await c.env.DB.prepare('SELECT servers_json FROM bans WHERE id = ?').bind(row.ban_id).first().catch(() => null);
    for (const slug of JSON.parse(banRow?.servers_json || '[]')) {
      if (slug === 'discourse') continue;
      record[slug] = await postRecord(c.env.DB, c.env, String(slug), String(row.user_id), recordEmbed({
        title: approve ? '✅ Appeal approved' : '❌ Appeal denied',
        color: approve ? 0x3ba55d : 0xed4245,
        userId: String(row.user_id),
        mod: modId,
        server: String(slug),
        reason: approve ? 'Full unban triggered (Discord + forum).' : undefined,
      }));
    }
    return c.json({ ok: true, record });
  } catch (err) {
    jsonLog('error', 'appeal decide failed', { error: String(err) });
    return bad('Failed to decide appeal', 500);
  }
}
mod.post('/api/appeals/:id/approve', (c) => decideAppeal(c, 'approved', true));
mod.post('/api/appeals/:id/deny', (c) => decideAppeal(c, 'denied', false));
// Aliases for older cached UI builds that call /approved + /denied.
mod.post('/api/appeals/:id/approved', (c) => decideAppeal(c, 'approved', true));
mod.post('/api/appeals/:id/denied', (c) => decideAppeal(c, 'denied', false));

// ------------------------------------------------------------------ Appeal invite links
// Mods mint an expiring, single-use link per ban and DM it to the banned user.
// The link opens the public /appeals/ form — no ban IDs exposed. Only the
// SHA-256 hash is stored; the plaintext token is shown once at mint time.
async function mintAppealLink(
  db: D1Database,
  env: Env,
  modId: string,
  banId: string,
  userId: string,
  days: number,
): Promise<{ url: string; expires_at: string }> {
  const span = Math.min(Math.max(Number(days) || 7, 1), 30);
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const now = new Date();
  const expires = new Date(now.getTime() + span * 86400000).toISOString();
  // Supersede: one live link per ban — retire any previous unused ones first.
  await db.prepare('UPDATE appeal_links SET used_at = ? WHERE ban_id = ? AND used_at IS NULL').bind(now.toISOString(), banId).run().catch(() => {});
  await db.prepare(
    'INSERT INTO appeal_links (token_hash, ban_id, user_id, created_by, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
  ).bind(await sha256hex(token), banId, userId, modId, now.toISOString(), expires).run();
  await audit(db, { action: 'appeal_link_mint', user_id: userId, mod_id: modId, detail: { ban_id: banId, days: span } });
  const host = env.COMMUNITY_DOMAIN || env.PERSONAL_DOMAIN || 'mod.tep.one';
  return { url: `https://${host}/appeals/?token=${token}`, expires_at: expires };
}

// Open (or reuse) a DM channel with a user and send one embed. Never throws:
// returns { channel_id } or { error } (closed DMs, unknown user, …).
async function sendModDM(
  env: Env,
  userId: string,
  embed: Record<string, unknown>,
): Promise<{ channel_id?: string; error?: string }> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return { error: 'bot token not configured' };
  try {
    const dm = await discordJson(token, 'POST', '/users/@me/channels', { recipient_id: userId });
    if (!dm.ok || !dm.data?.id) return { error: dm.status === 404 ? 'Unknown user' : discordMsg(dm) };
    const sent = await discordJson(token, 'POST', `/channels/${dm.data.id}/messages`, { embeds: [embed] });
    if (!sent.ok) {
      const code = (sent.data as any)?.code;
      if (code === 50007) return { error: 'DMs closed — this user has DMs from server members off' };
      if (sent.status === 403) return { error: `Bot cannot message this user (${discordMsg(sent)})` };
      return { error: discordMsg(sent) };
    }
    return { channel_id: String(dm.data.id) };
  } catch (err) {
    return { error: String(err) };
  }
}
mod.post('/api/appeal-links', async (c) => {
  try {
    const body = await readJson<{ ban_id?: string; days?: number }>(c);
    const ban: any = await c.env.DB.prepare('SELECT * FROM bans WHERE id = ?').bind(body.ban_id ?? '').first();
    if (!ban) return bad('ban not found', 404);
    if (!ban.is_active) return bad('ban is not active', 400);
    const modId = await actingMod(c.env, c.req.raw.headers);
    const link = await mintAppealLink(c.env.DB, c.env, modId, ban.id, ban.user_id, Number(body.days ?? 7));
    return c.json({ ok: true, url: link.url, expires_at: link.expires_at });
  } catch (err) {
    jsonLog('error', 'appeal link mint failed', { error: String(err) });
    return bad('Failed to mint appeal link', 500);
  }
});

// Public: look up active bans for a user ID (link-free appeals). No auth —
// user IDs aren't secret; the submit path keeps the 24h + IP brakes.
mod.get('/hooks/appeal-lookup', async (c) => {
  try {
    const uid = (c.req.query('user_id') ?? '').trim();
    if (!/^\d{10,}$/.test(uid)) return bad('valid user_id required', 400);
    const cf = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? '';
    const ipHash = await sha256hex(cf || 'unknown');
    if (!(await checkRateLimit(c.env.DB, 'appeal-lookup:' + ipHash, 20, 60000)))
      return Response.json({ ok: false, error: 'Too many lookups, try again later' }, { status: 429 });
    const res = await c.env.DB.prepare(
      'SELECT id, reason, created_at, expires_at, servers_json, appeal_wait_days FROM bans WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC',
    ).bind(uid).all<any>().catch(() => ({ results: [] }));
    const bans = (res.results ?? []).map((b: any) => ({
      ban_id: b.id,
      reason: b.reason,
      created_at: b.created_at,
      expires_at: b.expires_at,
      servers: JSON.parse(b.servers_json || '[]'),
      eligible_at: appealEligibleAt(b),
    }));
    if (!bans.length) return bad('No active ban found for that user', 404);
    return c.json({ ok: true, user_id: uid, bans });
  } catch {
    return bad('Lookup failed', 500);
  }
});

// Public: describe a link for the /appeals/ form. No auth — the token is unguessable.
mod.get('/hooks/appeal-link', async (c) => {
  try {
    const token = c.req.query('token') ?? '';
    if (!token) return bad('token required', 400);
    const row: any = await c.env.DB.prepare('SELECT * FROM appeal_links WHERE token_hash = ?').bind(await sha256hex(token)).first().catch(() => null);
    if (!row) return bad('Invalid link', 404);
    if (row.used_at) return bad('This link has already been used', 410);
    if (row.expires_at < new Date().toISOString()) return bad('This link has expired', 410);
    const ban: any = await c.env.DB.prepare('SELECT reason, created_at, expires_at, servers_json, appeal_wait_days FROM bans WHERE id = ?').bind(row.ban_id).first().catch(() => null);
    const eligibleAt = ban ? appealEligibleAt(ban) : null;
    return c.json({
      ok: true,
      user_id: row.user_id,
      expires_at: row.expires_at,
      eligible_at: eligibleAt,
      appealable: !eligibleAt || eligibleAt <= new Date().toISOString(),
      ban: ban
        ? { reason: ban.reason, created_at: ban.created_at, expires_at: ban.expires_at, servers: JSON.parse(ban.servers_json || '[]') }
        : null,
    });
  } catch {
    return bad('Failed to read link', 500);
  }
});

// ------------------------------------------------------------------ User notes
mod.post('/api/user-notes', async (c) => {
  try {
    const body = await readJson<{ user_id?: string; note?: string; mail_item_id?: string; server?: string }>(c);
    const uid = (body.user_id ?? '').trim();
    if (!/^\d{10,}$/.test(uid)) return bad('valid user_id required', 400);
    if (!body.note?.trim()) return bad('user_id and note required', 400);
    const modId = await actingMod(c.env, c.req.raw.headers);
    if (!(await checkRateLimit(c.env.DB, 'note:' + modId, 20, 60000)))
      return Response.json({ ok: false, error: 'Rate limited' }, { status: 429 });
    const id = newId();
    await c.env.DB.prepare(
      'INSERT INTO user_notes (id, user_id, mod_id, note, mail_item_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(id, uid, modId, body.note.slice(0, 2000), body.mail_item_id ?? null, new Date().toISOString()).run();
    const slug = recordSlug(c.env, body.server);
    const record = slug
      ? await postRecord(c.env.DB, c.env, slug, uid, recordEmbed({
          title: '📝 Mod note',
          color: 0x99aab5,
          userId: uid,
          mod: modId,
          server: slug,
          reason: body.note.slice(0, 2000),
          evidenceUrl: body.mail_item_id ? inboxUrl(c.env, body.mail_item_id) : undefined,
        }))
      : { error: 'no records forum configured' };
    return c.json({ ok: true, id, record });
  } catch (err) {
    jsonLog('error', 'user note failed', { error: String(err) });
    return bad('Failed to add note', 500);
  }
});

mod.get('/api/user-notes', async (c) => {
  const user = c.req.query('user_id');
  if (!user) return bad('user_id required', 400);
  if (!/^\d{10,}$/.test(user)) return bad('valid user_id required', 400);
  const res = await c.env.DB.prepare('SELECT * FROM user_notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 200').bind(user).all();
  return c.json({ ok: true, items: res.results ?? [] });
});

// Alias for docs (`GET /api/user-notes/:user`); same as ?user_id=.
mod.get('/api/user-notes/:user', async (c) => {
  const user = c.req.param('user');
  if (!/^\d{10,}$/.test(user)) return bad('valid user_id required', 400);
  const res = await c.env.DB.prepare('SELECT * FROM user_notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 200').bind(user).all();
  return c.json({ ok: true, items: res.results ?? [] });
});

// ------------------------------------------------------------------ DM a user
// Mod-team DM via the bot. Mirrored to the user's record thread for
// accountability. Fails gracefully when the user has DMs closed.
mod.post('/api/dm', async (c) => {
  try {
    const token = c.env.DISCORD_BOT_TOKEN;
    if (!token) return bad('Bot token not configured', 400);
    const body = await readJson<{ user_id?: string; server?: string; action?: string; message?: string }>(c);
    const uid = (body.user_id ?? '').trim();
    const msg = (body.message ?? '').trim();
    if (!/^\d{10,}$/.test(uid)) return bad('valid user_id required', 400);
    if (!msg) return bad('message required', 400);
    if (msg.length > 2000) return bad('message too long (max 2000 chars)', 400);
    const slug = recordSlug(c.env, body.server) ?? (body.server ?? '').trim();
    const modId = await actingMod(c.env, c.req.raw.headers);
    if (!(await checkRateLimit(c.env.DB, 'dm:' + modId, 10, 60000)))
      return Response.json({ ok: false, error: 'Rate limited' }, { status: 429 });
    const serverName = toolServers(c.env)[slug]?.name || slug || 'the server';
    const sent = await sendModDM(c.env, uid, {
      title: `Notice from ${serverName} Moderation Team`,
      description: msg.slice(0, 4000),
      color: 5793266,
      fields: [
        { name: 'Server', value: serverName === 'the server' ? '—' : serverName, inline: true },
        { name: 'Action', value: (body.action ?? '').trim().slice(0, 100) || 'Notice', inline: true },
      ],
      image: { url: assetUrl(c.env, 'notice.png') },
      footer: { text: 'Do Not Reply: replies to this bot are not monitored.' },
      timestamp: new Date().toISOString(),
    });
    if (sent.error) {
      await audit(c.env.DB, { action: 'dm_failed', user_id: uid, mod_id: modId, detail: { server: slug } });
      return c.json({ ok: false, error: sent.error }, 400);
    }
    await audit(c.env.DB, { action: 'dm', user_id: uid, mod_id: modId, detail: { server: slug } });
    let record: { thread_id?: string; error?: string } | undefined;
    if (slug && toolServers(c.env)[slug]?.records_forum) {
      record = await postRecord(c.env.DB, c.env, slug, uid, recordEmbed({
        title: '📩 DM sent to user',
        color: 0x5865f2,
        userId: uid,
        mod: modId,
        server: slug,
        reason: msg,
      }));
    }
    return c.json({ ok: true, record });
  } catch (err) {
    jsonLog('error', 'dm failed', { error: String(err) });
    return bad('Failed to send DM', 500);
  }
});

// ------------------------------------------------------------------ Identity links
// Manual link first (mod UI), auto-verify later via forum webhook/custom field.
mod.get('/api/links/:discordId', async (c) => {
  const discordId = c.req.param('discordId');
  if (!/^\d{10,}$/.test(discordId)) return bad('valid discord id required', 400);
  try {
    const res = await c.env.DB.prepare('SELECT * FROM identity_links WHERE discord_id = ?').bind(discordId).all();
    return c.json({ ok: true, items: res.results ?? [] });
  } catch {
    return c.json({ ok: true, items: [] });
  }
});

mod.post('/api/links', async (c) => {
  try {
    const body = await readJson<{ discord_id?: string; platform?: string; external_id?: string; external_username?: string }>(c);
    const discordId = (body.discord_id ?? '').trim();
    const platform = (body.platform ?? 'discourse').trim().slice(0, 32) || 'discourse';
    const externalId = (body.external_id ?? '').trim().slice(0, 80);
    if (!/^\d{10,}$/.test(discordId)) return bad('valid discord_id required', 400);
    if (!externalId) return bad('external_id required', 400);
    const modId = await actingMod(c.env, c.req.raw.headers);
    if (!(await checkRateLimit(c.env.DB, 'link:' + modId, 20, 60000)))
      return Response.json({ ok: false, error: 'Rate limited' }, { status: 429 });
    await upsertIdentityLink(c.env.DB, discordId, platform, externalId, (body.external_username ?? '').slice(0, 80), 0, modId);
    await audit(c.env.DB, { action: 'link_upsert', user_id: discordId, mod_id: modId, detail: { platform, externalId } });
    const link = await resolveForumId(c.env.DB, discordId, platform);
    return c.json({ ok: true, link });
  } catch (err) {
    jsonLog('error', 'link upsert failed', { error: String(err) });
    return bad('Failed to save link', 500);
  }
});

mod.delete('/api/links/:discordId/:platform', async (c) => {
  const discordId = c.req.param('discordId');
  const platform = c.req.param('platform');
  await c.env.DB.prepare('DELETE FROM identity_links WHERE discord_id = ? AND platform = ?').bind(discordId, platform).run();
  await audit(c.env.DB, { action: 'link_delete', user_id: discordId, detail: { platform } });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ Apply plans via bot
// One-click apply for the Slowmode + Lockdown planners: the Worker (which
// already holds DISCORD_BOT_TOKEN) sets channel slowmode + @everyone
// overwrites directly. Needs channel IDs (Discord has no bulk import;
// #names alone can't be resolved without a channel list).
const SNOW = /^\d{10,}$/;

async function discordJson(token: string, method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data?: any }> {
  // No Content-Type on bodyless requests (notably DELETE): some Discord
  // endpoints reject a declared JSON type with an empty body.
  const headers: Record<string, string> = { Authorization: 'Bot ' + token };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch('https://discord.com/api/v10' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any = null;
  try {
    data = await r.json();
  } catch {
    /* non-JSON (e.g. 204) */
  }
  return { ok: r.ok, status: r.status, data };
}

// Short human-readable Discord API error (surfaced in UI toasts for faster fixes).
function discordMsg(r: { status: number; data?: any }): string {
  const d: any = r.data;
  if (d && typeof d === 'object') {
    if (typeof d.message === 'string' && d.message) return d.message;
    try {
      return JSON.stringify(d).slice(0, 300);
    } catch {
      /* fallthrough */
    }
  }
  return 'HTTP ' + r.status;
}

// Earliest moment a ban can be appealed (ban date + per-ban wait, default 0).
function appealEligibleAt(ban: { created_at?: string; appeal_wait_days?: unknown }): string {
  const wait = Math.max(Number((ban as any)?.appeal_wait_days ?? 0) || 0, 0);
  return new Date(Date.parse(ban?.created_at || new Date().toISOString()) + wait * 86400000).toISOString();
}

async function mailResult(
  db: D1Database,
  input: { server: string; title: string; content: string; by: string },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO inbox_items (id, server, type, tag, author, title, content, time, prio, src, by, url, assigned, archived, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId(), input.server.slice(0, 80), 'ticket', 'ticket', 'bot-apply', input.title.slice(0, 300),
        input.content.slice(0, 8000), new Date().toISOString(), 'normal', 'discord', input.by.slice(0, 80), '#', null, 0,
        new Date().toISOString(),
      )
      .run();
  } catch {
    /* mail best-effort */
  }
}

// Deny bitfields for lockdown modes (@everyone overwrite, type 0).
// readonly: SendMessages; locked: + AddReactions + thread creates/sends.
const DENY: Record<string, string> = {
  open: '0',
  slow: '0',
  readonly: '2048',
  locked: '377957128160',
};

mod.post('/api/apply/slowmode', async (c) => {
  try {
    const token = c.env.DISCORD_BOT_TOKEN;
    if (!token) return bad('Bot token not configured — set DISCORD_BOT_TOKEN', 400);
    const body = await readJson<{ server?: string; channels?: { channel_id?: string; slowmode_seconds?: number; note?: string }[] }>(c);
    const slug = (body.server ?? '').trim();
    const guild = toolServers(c.env)[slug]?.guild;
    if (!slug || !guild) return bad('unknown server slug — check MOD_TOOL_SERVERS', 400);
    const channels = Array.isArray(body.channels) ? body.channels.slice(0, 25) : [];
    if (!channels.length) return bad('at least one channel required (max 25)', 400);
    for (const ch of channels) {
      if (!ch || !SNOW.test(String(ch.channel_id ?? ''))) return bad('each channel needs a valid channel_id snowflake', 400);
      const s = Number(ch.slowmode_seconds ?? 0);
      if (!Number.isInteger(s) || s < 0 || s > 21600) return bad('slowmode_seconds must be 0–21600', 400);
    }
    const modId = await actingMod(c.env, c.req.raw.headers);
    if (!(await checkRateLimit(c.env.DB, 'apply:' + modId, 5, 60000)))
      return Response.json({ ok: false, error: 'Rate limited' }, { status: 429 });
    const results: Record<string, { ok: boolean; status?: number }> = {};
    for (const ch of channels) {
      const id = String(ch.channel_id);
      const r = await discordJson(token, 'PATCH', `/channels/${id}`, { rate_limit_per_user: Number(ch.slowmode_seconds ?? 0) });
      results[id] = { ok: r.ok, status: r.status };
    }
    const okCount = Object.values(results).filter((r) => r.ok).length;
    await audit(c.env.DB, { action: 'apply_slowmode', mod_id: modId, detail: { server: slug, okCount, total: channels.length } });
    await mailResult(c.env.DB, {
      server: slug,
      title: `Slowmode applied ${okCount}/${channels.length} by ${modId}`,
      content: JSON.stringify({ tool: 'slowmode-apply', server: slug, results }, null, 2),
      by: 'slowmode-apply',
    });
    return c.json({ ok: okCount > 0, results });
  } catch (err) {
    jsonLog('error', 'apply slowmode failed', { error: String(err) });
    return bad('Failed to apply slowmode', 500);
  }
});

mod.post('/api/apply/lockdown', async (c) => {
  try {
    const token = c.env.DISCORD_BOT_TOKEN;
    if (!token) return bad('Bot token not configured — set DISCORD_BOT_TOKEN', 400);
    const body = await readJson<{
      server?: string;
      exempt_roles?: string[];
      channels?: { channel_id?: string; mode?: string; slowmode_seconds?: number; note?: string }[];
    }>(c);
    const slug = (body.server ?? '').trim();
    const guild = toolServers(c.env)[slug]?.guild;
    if (!slug || !guild) return bad('unknown server slug — check MOD_TOOL_SERVERS', 400);
    const modes = ['open', 'slow', 'readonly', 'locked'];
    const channels = Array.isArray(body.channels) ? body.channels.slice(0, 25) : [];
    if (!channels.length) return bad('at least one channel required (max 25)', 400);
    for (const ch of channels) {
      if (!ch || !SNOW.test(String(ch.channel_id ?? ''))) return bad('each channel needs a valid channel_id snowflake', 400);
      if (!modes.includes(String(ch.mode ?? ''))) return bad('mode must be open|slow|readonly|locked', 400);
      const s = Number(ch.slowmode_seconds ?? 0);
      if (!Number.isInteger(s) || s < 0 || s > 21600) return bad('slowmode_seconds must be 0–21600', 400);
    }
    const modId = await actingMod(c.env, c.req.raw.headers);
    if (!(await checkRateLimit(c.env.DB, 'apply:' + modId, 5, 60000)))
      return Response.json({ ok: false, error: 'Rate limited' }, { status: 429 });
    // Resolve exempt role names -> IDs (best-effort; names that don't match are skipped).
    const wantNames = [...new Set((body.exempt_roles ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))].slice(0, 10);
    let exemptIds: { id: string; name: string }[] = [];
    if (wantNames.length) {
      const roles = await discordJson(token, 'GET', `/guilds/${guild}/roles`);
      const list = Array.isArray(roles.data) ? roles.data : [];
      exemptIds = list
        .filter((r: any) => r && wantNames.includes(String(r.name ?? '').toLowerCase()))
        .map((r: any) => ({ id: String(r.id), name: String(r.name) }));
    }
    const results: Record<string, any> = {};
    for (const ch of channels) {
      const id = String(ch.channel_id);
      const mode = String(ch.mode);
      const entry: any = {};
      const slow = await discordJson(token, 'PATCH', `/channels/${id}`, { rate_limit_per_user: Number(ch.slowmode_seconds ?? 0) });
      entry.slowmode = { ok: slow.ok, status: slow.status };
      const ow = await discordJson(token, 'PUT', `/channels/${id}/permissions/${guild}`, {
        allow: '0',
        deny: DENY[mode] ?? '0',
        type: 0,
      });
      entry.overwrite = { ok: ow.ok, status: ow.status };
      entry.exempt = [];
      for (const ex of exemptIds) {
        const er = await discordJson(token, 'PUT', `/channels/${id}/permissions/${ex.id}`, {
          allow: '2048',
          deny: '0',
          type: 0,
        });
        entry.exempt.push({ role: ex.name, ok: er.ok, status: er.status });
      }
      results[id] = entry;
    }
    const okCount = Object.values(results).filter((r: any) => r.slowmode?.ok && r.overwrite?.ok).length;
    await audit(c.env.DB, { action: 'apply_lockdown', mod_id: modId, detail: { server: slug, okCount, total: channels.length } });
    await mailResult(c.env.DB, {
      server: slug,
      title: `Lockdown applied ${okCount}/${channels.length} by ${modId}`,
      content: JSON.stringify({ tool: 'lockdown-apply', server: slug, exempt: exemptIds.map((e) => e.name), results }, null, 2),
      by: 'lockdown-apply',
    });
    return c.json({ ok: okCount > 0, results, exempt_resolved: exemptIds.map((e) => e.name) });
  } catch (err) {
    jsonLog('error', 'apply lockdown failed', { error: String(err) });
    return bad('Failed to apply lockdown', 500);
  }
});

// ------------------------------------------------------------------ Slowmode schedules (time-based)
// One row per channel: inside [start_utc, end_utc) enforce night_secs,
// otherwise day_secs. Times are "HH:MM" UTC. The cron calls
// checkSlowmodeSchedules() and only PATCHes on transitions (last_applied).
function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function inWindow(nowMin: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return true; // degenerate: always night
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin; // overnight wrap
}

export async function checkSlowmodeSchedules(db: D1Database, env: Env): Promise<number> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return 0;
  let rows: any[] = [];
  try {
    const res = await db
      .prepare('SELECT * FROM slowmode_schedules WHERE is_active = 1')
      .all();
    rows = (res.results ?? []) as any[];
  } catch {
    return 0; // pre-migration
  }
  if (!rows.length) return 0;
  const now = new Date();
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  let changed = 0;
  for (const s of rows.slice(0, 25)) {
    const start = parseHHMM(s.start_utc);
    const end = parseHHMM(s.end_utc);
    if (start === null || end === null) continue;
    const day = Math.max(0, Math.min(21600, Number(s.day_secs ?? 0) | 0));
    const night = Math.max(0, Math.min(21600, Number(s.night_secs ?? 10) | 0));
    const target = inWindow(nowMin, start, end) ? night : day;
    if (s.last_applied !== null && Number(s.last_applied) === target) continue;
    const r = await discordJson(token, 'PATCH', `/channels/${s.channel_id}`, { rate_limit_per_user: target });
    if (r.ok) {
      await db.prepare('UPDATE slowmode_schedules SET last_applied = ? WHERE id = ?').bind(target, s.id).run();
      await audit(db, { action: 'slowmode_schedule', user_id: undefined, detail: { channel: s.channel_id, server: s.server, target } });
      await mailResult(db, {
        server: s.server,
        title: `Slowmode ${target}s on ${s.channel_name || s.channel_id} (${target === night ? 'night' : 'day'} window)`,
        content: JSON.stringify({ tool: 'slowmode-schedule', server: s.server, channel_id: s.channel_id, target_secs: target }, null, 2),
        by: 'slowmode-schedule',
      });
      changed++;
    } else {
      jsonLog('warn', 'slowmode schedule apply failed', { channel: s.channel_id, status: r.status });
    }
  }
  return changed;
}

mod.get('/api/slowmode-schedules', async (c) => {
  try {
    const res = await c.env.DB.prepare('SELECT * FROM slowmode_schedules ORDER BY server, channel_name').all();
    return c.json({ ok: true, items: res.results ?? [] });
  } catch {
    return c.json({ ok: true, items: [] });
  }
});

mod.post('/api/slowmode-schedules', async (c) => {
  try {
    const body = await readJson<{ server?: string; channel_id?: string; channel_name?: string; day_secs?: number; night_secs?: number; start_utc?: string; end_utc?: string }>(c);
    const slug = (body.server ?? '').trim();
    if (!toolServers(c.env)[slug]?.guild && slug !== 'global') {
      const map = toolServers(c.env);
      if (!map[slug]) return bad('unknown server slug — check MOD_TOOL_SERVERS', 400);
    }
    if (!SNOW.test(String(body.channel_id ?? ''))) return bad('valid channel_id required', 400);
    const day = Number(body.day_secs ?? 0);
    const night = Number(body.night_secs ?? 10);
    if (!Number.isInteger(day) || !Number.isInteger(night) || day < 0 || day > 21600 || night < 0 || night > 21600) {
      return bad('day_secs/night_secs must be 0–21600', 400);
    }
    if (parseHHMM(String(body.start_utc ?? '')) === null || parseHHMM(String(body.end_utc ?? '')) === null) {
      return bad('start_utc/end_utc must be HH:MM (UTC, 24h)', 400);
    }
    const modId = await actingMod(c.env, c.req.raw.headers);
    if (!(await checkRateLimit(c.env.DB, 'sched:' + modId, 10, 60000)))
      return Response.json({ ok: false, error: 'Rate limited' }, { status: 429 });
    const id = newId();
    await c.env.DB.prepare(
      `INSERT INTO slowmode_schedules (id, server, channel_id, channel_name, day_secs, night_secs, start_utc, end_utc, last_applied, created_by, created_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)
       ON CONFLICT(server, channel_id) DO UPDATE SET channel_name = excluded.channel_name, day_secs = excluded.day_secs,
         night_secs = excluded.night_secs, start_utc = excluded.start_utc, end_utc = excluded.end_utc, is_active = 1, last_applied = NULL`,
    )
      .bind(id, slug, String(body.channel_id), String(body.channel_name ?? '').slice(0, 80), day, night, String(body.start_utc), String(body.end_utc), modId, new Date().toISOString())
      .run();
    await audit(c.env.DB, { action: 'slowmode_schedule_upsert', mod_id: modId, detail: { server: slug, channel: body.channel_id } });
    return c.json({ ok: true, id });
  } catch (err) {
    jsonLog('error', 'slowmode schedule save failed', { error: String(err) });
    return bad('Failed to save schedule', 500);
  }
});

mod.delete('/api/slowmode-schedules/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM slowmode_schedules WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ ok: true });
});

export default mod;