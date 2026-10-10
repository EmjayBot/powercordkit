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
};

const mod = new Hono<{ Bindings: Env }>();

const newId = () => crypto.randomUUID();
const jsonLog = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, tool: 'modtools', ...extra }));
const bad = (msg: string, status = 400) => Response.json({ ok: false, error: msg }, { status });

async function readJson<T>(c: any): Promise<T> {
  const raw = await c.req.text();
  if (raw.length > 262144) throw new Response('Payload too large', { status: 413 });
  return JSON.parse(raw) as T;
}

type ToolServers = Record<string, { guild?: string }>;
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

// Advertise the configured server slugs so the UI is never hardcoded to one community.
mod.get('/api/modtools/servers', (c) => {
  const servers = Object.keys(toolServers(c.env));
  if (c.env.DISCOURSE_BASE_URL && c.env.DISCOURSE_ADMIN_KEY && !servers.includes('discourse')) servers.push('discourse');
  return c.json({ ok: true, servers });
});

function rateLimit(key: string, max: number, windowMs: number): boolean {
  const g = globalThis as any;
  const buckets: Map<string, number[]> = g.__rl ?? new Map<string, number[]>();
  g.__rl = buckets;
  const now = Date.now();
  const arr = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return false; }
  arr.push(now);
  buckets.set(key, arr);
  return true;
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

// ------------------------------------------------------------------ Bans
mod.post('/api/bans', async (c) => {
  try {
    const token = c.env.DISCORD_BOT_TOKEN;
    if (!token) return bad('Bot token not configured', 400);
    const body = await readJson<{ user_id?: string; reason?: string; servers?: string[]; duration_minutes?: number; evidence_mail_id?: string; delete_days?: number }>(c);
    const uid = (body.user_id ?? '').trim();
    const reason = (body.reason ?? '').slice(0, 1000);
    const servers = Array.isArray(body.servers) ? [...new Set(body.servers.filter(Boolean))] : [];
    if (!/^\d{10,}$/.test(uid)) return bad('valid user_id required', 400);
    if (!reason) return bad('reason required', 400);
    if (!servers.length) return bad('at least one server required', 400);
    const modId = await actingMod(c.env, c.req.raw.headers);
    if (!rateLimit('ban:' + modId, 5, 60000)) return Response.json({ ok: false, error: 'Rate limited' }, { status: 429 });
    const map = toolServers(c.env);
    const results: Record<string, { ok: boolean; status?: number; error?: string }> = {};
    for (const slug of servers) {
      const g = map[slug];
      if (!g?.guild) { results[slug] = { ok: false, error: 'unknown server slug' }; continue; }
      const r = await discordReq(token, 'PUT', `/guilds/${g.guild}/bans/${uid}`, { reason, delete_message_seconds: Math.min(Math.max(body.delete_days ?? 0, 0), 7) * 86400 });
      results[slug] = { ok: r.ok, status: r.status };
    }
    if (servers.includes('discourse')) {
      const base = c.env.DISCOURSE_BASE_URL?.replace(/\/$/, '');
      if (base && c.env.DISCOURSE_ADMIN_KEY) {
        const r = await fetch(`${base}/admin/users/${uid}/suspend.json`, {
          method: 'POST',
          headers: { 'Api-Key': c.env.DISCOURSE_ADMIN_KEY, 'Api-Username': 'system', 'content-type': 'application/json' },
          body: JSON.stringify({
            suspend_until: body.duration_minutes ? new Date(Date.now() + body.duration_minutes * 60000).toISOString() : '2038-01-01T00:00:00Z',
            reason,
          }),
        });
        results.discourse = { ok: r.ok, status: r.status };
      } else results.discourse = { ok: false, error: 'discourse not configured' };
    }
    if (!Object.values(results).some((x) => x.ok)) return c.json({ ok: false, results }, 400);
    const id = newId();
    const expires = body.duration_minutes ? new Date(Date.now() + body.duration_minutes * 60000).toISOString() : null;
    await c.env.DB.prepare(
      'INSERT INTO bans (id, user_id, reason, mod_id, servers_json, evidence_mail_id, created_at, expires_at, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)',
    ).bind(id, uid, reason, modId, JSON.stringify(servers), body.evidence_mail_id ?? null, new Date().toISOString(), expires).run();
    await audit(c.env.DB, { action: 'ban', user_id: uid, mod_id: modId, detail: { servers } });
    return c.json({ ok: true, id, results });
  } catch (err) {
    jsonLog('error', 'ban create failed', { error: String(err) });
    return bad('Failed to create ban', 500);
  }
});

mod.get('/api/bans', async (c) => {
  const res = await c.env.DB.prepare('SELECT * FROM bans ORDER BY created_at DESC LIMIT 100').all();
  return c.json({ ok: true, items: res.results ?? [] });
});

mod.post('/api/bans/:id/unban', async (c) => {
  try {
    const token = c.env.DISCORD_BOT_TOKEN;
    if (!token) return bad('Bot token not configured', 400);
    const id = c.req.param('id');
    const row: any = await c.env.DB.prepare('SELECT * FROM bans WHERE id = ?').bind(id).first();
    if (!row) return bad('ban not found', 404);
    if (!row.is_active) return c.json({ ok: true, already: true });
    const servers = JSON.parse(row.servers_json || '[]') as string[];
    const map = toolServers(c.env);
    const results: Record<string, { ok: boolean; status?: number; error?: string }> = {};
    for (const slug of servers) {
      const g = map[slug];
      if (!g?.guild) { results[slug] = { ok: false, error: 'unknown server slug' }; continue; }
      const r = await discordReq(token, 'DELETE', `/guilds/${g.guild}/bans/${row.user_id}`);
      results[slug] = { ok: r.ok, status: r.status };
    }
    if (servers.includes('discourse')) {
      const base = c.env.DISCOURSE_BASE_URL?.replace(/\/$/, '');
      if (base && c.env.DISCOURSE_ADMIN_KEY) {
        const r = await fetch(`${base}/admin/users/${row.user_id}/unsuspend.json`, {
          method: 'POST',
          headers: { 'Api-Key': c.env.DISCOURSE_ADMIN_KEY, 'Api-Username': 'system' },
        });
        results.discourse = { ok: r.ok, status: r.status };
      } else results.discourse = { ok: false, error: 'discourse not configured' };
    }
    await c.env.DB.prepare('UPDATE bans SET is_active = 0 WHERE id = ?').bind(id).run();
    await audit(c.env.DB, { action: 'unban', user_id: row.user_id, detail: { servers } });
    return c.json({ ok: true, results });
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
    if (!rateLimit('timeout:' + modId, 10, 60000)) return Response.json({ ok: false, error: 'Rate limited' }, { status: 429 });
    const until = new Date(Date.now() + mins * 60000).toISOString();
    const r = await discordReq(token, 'PATCH', `/guilds/${g.guild}/members/${uid}`, { communication_disabled_until: until });
    if (!r.ok) return c.json({ ok: false, status: r.status }, 400);
    const id = newId();
    await c.env.DB.prepare(
      'INSERT INTO timeouts (id, user_id, reason, mod_id, server_id, expires_at, created_at, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
    ).bind(id, uid, (body.reason ?? '').slice(0, 400), modId, body.server, until, new Date().toISOString()).run();
    await audit(c.env.DB, { action: 'timeout', user_id: uid, mod_id: modId, detail: { server: body.server, mins } });
    return c.json({ ok: true, id, expires_at: until });
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
    return c.json({ ok: true });
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
    if (!rateLimit('infraction:' + modId, 20, 60000)) return Response.json({ ok: false, error: 'Rate limited' }, { status: 429 });
    const id = newId();
    await c.env.DB.prepare(
      'INSERT INTO infractions (id, user_id, type, reason, mod_id, server_id, mail_item_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, body.user_id, type, body.reason.slice(0, 1000), modId, body.server_id ?? null, body.mail_item_id ?? null, new Date().toISOString()).run();
    await audit(c.env.DB, { action: 'infraction_' + type, user_id: body.user_id, mod_id: modId, detail: { mail_item_id: body.mail_item_id } });
    return c.json({ ok: true, id });
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

mod.get('/api/infractions/:user/timeline', async (c) => {
  const user = c.req.param('user');
  if (!/^\d{10,}$/.test(user)) return bad('valid user_id required', 400);
  const [bans, timeouts, infs, appeals] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM bans WHERE user_id = ? ORDER BY created_at DESC').bind(user).all(),
    c.env.DB.prepare('SELECT * FROM timeouts WHERE user_id = ? ORDER BY created_at DESC').bind(user).all(),
    c.env.DB.prepare('SELECT * FROM infractions WHERE user_id = ? ORDER BY created_at DESC').bind(user).all(),
    c.env.DB.prepare('SELECT * FROM appeals WHERE user_id = ? ORDER BY created_at DESC').bind(user).all(),
  ]);
  const tagged = (rows: { results?: any[] }, kind: string) => (rows.results ?? []).map((r: any) => ({ kind, ...r, tag: kind }));
  const timeline = [...tagged(bans, 'ban'), ...tagged(timeouts, 'timeout'), ...tagged(infs, 'infraction'), ...tagged(appeals, 'appeal')].sort(
    (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
  );
  return c.json({ ok: true, timeline });
});

// ------------------------------------------------------------------ Appeals
mod.post('/hooks/appeal', async (c) => {
  try {
    const body = await readJson<{ user_id?: string; ban_id?: string; answers?: Record<string, string>; honeypot?: string }>(c);
    if (body.honeypot) return c.json({ ok: true }); // silent spam trap
    const uid = (body.user_id ?? '').trim();
    if (!/^\d{10,}$/.test(uid)) return bad('valid user_id required', 400);
    const ban: any = await c.env.DB.prepare('SELECT * FROM bans WHERE id = ? AND is_active = 1').bind(body.ban_id).first();
    if (!ban) return bad('No active ban found for that ID', 404);
    const last: any = await c.env.DB.prepare('SELECT last_appeal_at FROM appeals WHERE ban_id = ? AND user_id = ? ORDER BY created_at DESC').bind(body.ban_id, uid).first();
    if (last?.last_appeal_at && Date.now() - new Date(last.last_appeal_at).getTime() < 86400000) {
      return bad('You already appealed in the last 24 hours', 429);
    }
    const cf = c.req.header('CF-Connecting-IP') ?? '';
    const ipHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cf)).then((d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''));
    const answers = Object.entries(body.answers ?? {}).reduce<Record<string, string>>((o, [k, v]) => { o[k] = String(v).slice(0, 2000); return o; }, {});
    const id = newId();
    const now = new Date().toISOString();
    await c.env.DB.prepare(
      'INSERT INTO appeals (id, ban_id, user_id, answers_json, status, ip_hash, created_at, last_appeal_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, body.ban_id, uid, JSON.stringify(answers), 'open', ipHash, now, now).run();
    // Create a Mail item (type=appeal) so it lands in the inbox.
    await c.env.DB.prepare(
      `INSERT INTO inbox_items (id, server, type, tag, author, title, content, time, prio, src, by, url, assigned, archived, roadmap, roadmap_status, roadmap_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, '', '', ?)`,
    ).bind(newId(), 'appeals', 'appeal', 'appeal', uid, `Appeal for ban ${String(body.ban_id).slice(0, 8)}`, JSON.stringify(answers).slice(0, 4000), 'now', 'high', 'discord', 'appeal', '', null, now).run();
    await audit(c.env.DB, { action: 'appeal_submit', user_id: uid, detail: { ban_id: body.ban_id } });
    return c.json({ ok: true, id });
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
      // Trigger the unban flow for the linked ban.
      const ban: any = await c.env.DB.prepare('SELECT * FROM bans WHERE id = ? AND is_active = 1').bind(row.ban_id).first();
      if (ban) {
        const token = c.env.DISCORD_BOT_TOKEN;
        const map = toolServers(c.env);
        if (token) {
          const servers = JSON.parse(ban.servers_json || '[]') as string[];
          for (const slug of servers) {
            const g = map[slug];
            if (g?.guild) await discordReq(token, 'DELETE', `/guilds/${g.guild}/bans/${ban.user_id}`);
          }
        }
        await c.env.DB.prepare('UPDATE bans SET is_active = 0 WHERE id = ?').bind(row.ban_id).run();
      }
    }
    const modId = await actingMod(c.env, c.req.raw.headers);
    await c.env.DB.prepare('UPDATE appeals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').bind(nextStatus, modId, new Date().toISOString(), id).run();
    await audit(c.env.DB, { action: 'appeal_' + nextStatus, user_id: row.user_id, mod_id: modId });
    return c.json({ ok: true });
  } catch (err) {
    jsonLog('error', 'appeal decide failed', { error: String(err) });
    return bad('Failed to decide appeal', 500);
  }
}
mod.post('/api/appeals/:id/approve', (c) => decideAppeal(c, 'approved', true));
mod.post('/api/appeals/:id/deny', (c) => decideAppeal(c, 'denied', false));

// ------------------------------------------------------------------ User notes
mod.post('/api/user-notes', async (c) => {
  try {
    const body = await readJson<{ user_id?: string; note?: string; mail_item_id?: string }>(c);
    if (!body.user_id || !body.note) return bad('user_id and note required', 400);
    const modId = await actingMod(c.env, c.req.raw.headers);
    if (!rateLimit('note:' + modId, 20, 60000)) return Response.json({ ok: false, error: 'Rate limited' }, { status: 429 });
    const id = newId();
    await c.env.DB.prepare(
      'INSERT INTO user_notes (id, user_id, mod_id, note, mail_item_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(id, body.user_id, modId, body.note.slice(0, 2000), body.mail_item_id ?? null, new Date().toISOString()).run();
    return c.json({ ok: true, id });
  } catch (err) {
    jsonLog('error', 'user note failed', { error: String(err) });
    return bad('Failed to add note', 500);
  }
});

mod.get('/api/user-notes', async (c) => {
  const user = c.req.query('user_id');
  if (!user) return bad('user_id required', 400);
  const res = await c.env.DB.prepare('SELECT * FROM user_notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 200').bind(user).all();
  return c.json({ ok: true, items: res.results ?? [] });
});

export default mod;