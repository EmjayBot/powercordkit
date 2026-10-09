import { Hono } from 'hono';
import { pollDiscord } from './poll';
import { verifyAccessJwt } from './access';
import {
  discordLoginUrl,
  exchangeCode,
  discordUser,
  discordMemberRoles,
  randomState,
  signSession,
  verifySession,
  readCookie,
  setCookie,
  clearCookie,
} from './discord-oauth';

type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  PERSONAL_DOMAIN?: string;
  COMMUNITY_DOMAIN?: string;
  COMMUNITY_ID?: string;
  DISCOURSE_WEBHOOK_SECRET?: string;
  DISCORD_WEBHOOK_SECRET?: string;
  FORUM_WEBHOOK_SECRET?: string;
  MAX_PAYLOAD_BYTES?: string;
  DEFAULT_SERVER?: string;
  MOD_API_KEY?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_GUILD_ID?: string;
  DISCORD_MOD_ROLE_ID?: string;
  DISCORD_MOD_ROLE_IDS?: string;
  SESSION_SECRET?: string;
  DISCORD_BOT_TOKEN?: string;
  FEED_MAP?: string;
  POLL_DEBUG?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

function jsonLog(level: string, msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level, msg, env: 'powercordkit', ...extra }));
}

function newId(): string {
  return crypto.randomUUID();
}

// Default source server for mailed items — per-env (personal: "general",
// community: "tep.one") so neither site leaks the other's identity.
function defaultServer(env: Bindings): string {
  return (env.DEFAULT_SERVER ?? 'general').slice(0, 80);
}

function bad(msg: string, status = 400): Response {
  return Response.json({ ok: false, error: msg }, { status });
}

// ---- Hardened baseline (per full-bundle spec): security headers + payload cap ----
const DEFAULT_MAX_PAYLOAD = 262144; // 256KB

const SEC_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

function maxPayload(c: { env: Bindings }): number {
  const v = Number(c.env.MAX_PAYLOAD_BYTES ?? DEFAULT_MAX_PAYLOAD);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_PAYLOAD;
}

async function guardApi(
  c: { req: { header: (n: string) => string | undefined }; env: Bindings; res: Response },
  next: () => Promise<void>,
): Promise<Response | void> {
  const len = c.req.header('content-length');
  if (len && Number(len) > maxPayload(c)) {
    return new Response('Payload too large', { status: 413, headers: SEC_HEADERS });
  }
  await next();
  for (const [k, v] of Object.entries(SEC_HEADERS)) c.res.headers.set(k, v);
}

app.use('/api/*', guardApi);
app.use('/hooks/*', guardApi);

// Mod-team gate for the API (not webhooks). Accepted, in order:
//  1. Discord session cookie (mods log in once via /api/auth/login).
//  2. Cloudflare Access JWT (if ACCESS_TEAM_DOMAIN + ACCESS_AUD are set).
//  3. Shared key X-Mod-Key vs MOD_API_KEY (workers.dev origin, scripts, dev).
app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/api/health' || path.startsWith('/api/auth/')) return next();
  if (c.env.SESSION_SECRET) {
    const cookie = readCookie(c.req.header('cookie'), 'pck_session');
    if (await verifySession(cookie, c.env.SESSION_SECRET)) return next();
  }
  const team = c.env.ACCESS_TEAM_DOMAIN;
  const aud = c.env.ACCESS_AUD;
  const accessEnabled = !!(team && aud);
  if (team && aud) {
    const jwt = c.req.header('Cf-Access-Jwt-Assertion') ?? null;
    if (await verifyAccessJwt(jwt, team, aud)) return next();
  }
  const key = c.env.MOD_API_KEY;
  if (key && (await timingSafeEqualString(c.req.header('X-Mod-Key') ?? '', key))) return next();
  const loginEnabled = !!(c.env.DISCORD_CLIENT_ID && c.env.DISCORD_CLIENT_SECRET && c.env.SESSION_SECRET);
  if (loginEnabled || accessEnabled || key) {
    return Response.json(
      { ok: false, error: loginEnabled ? 'Login required' : 'Mod key required', login: loginEnabled },
      { status: 401, headers: SEC_HEADERS },
    );
  }
  await next();
});

// --- Discord OAuth2 login -------------------------------------------------
function oauthRedirectUri(env: Bindings): string {
  const base = env.COMMUNITY_DOMAIN ? `https://${env.COMMUNITY_DOMAIN}` : '';
  return `${base}/api/auth/callback`;
}

app.get('/api/auth/login', (c) => {
  const { DISCORD_CLIENT_ID: id, DISCORD_CLIENT_SECRET: secret, SESSION_SECRET: sess } = c.env;
  if (!id || !secret || !sess) {
    return new Response('Discord login is not configured.', { status: 503, headers: SEC_HEADERS });
  }
  const state = randomState();
  const url = discordLoginUrl(id, oauthRedirectUri(c.env), state);
  const headers = new Headers({ Location: url });
  headers.append('Set-Cookie', setCookie('pck_oauth_state', state, { maxAge: 600, path: '/api/auth' }));
  return new Response(null, { status: 302, headers });
});

app.get('/api/auth/callback', async (c) => {
  const {
    DISCORD_CLIENT_ID: id,
    DISCORD_CLIENT_SECRET: secret,
    DISCORD_GUILD_ID: guild = '633351482128728064',
    DISCORD_MOD_ROLE_ID: role,
    DISCORD_MOD_ROLE_IDS: rolesCsv,
    SESSION_SECRET: sess,
  } = c.env;
  if (!id || !secret || !sess) return new Response('Login not configured', { status: 503 });
  const url = new URL(c.req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expected = readCookie(c.req.header('cookie'), 'pck_oauth_state');
  if (!code || !state || !expected || state !== expected) {
    return new Response('Invalid OAuth state. Please retry.', { status: 400 });
  }
  const token = await exchangeCode(code, id, secret, oauthRedirectUri(c.env));
  if (!token) return new Response('Discord token exchange failed.', { status: 400 });
  const user = await discordUser(token);
  if (!user) return new Response('Could not read Discord profile.', { status: 400 });
  const roles = await discordMemberRoles(token, guild);
  if (!roles) return Response.redirect(`${oauthRedirectUri(c.env).replace('/api/auth/callback', '')}/mail/?denied=notmember`, 302);
  const allowedRoles = (rolesCsv ?? role ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  if (allowedRoles.length && !allowedRoles.some((r) => roles.includes(r))) {
    return Response.redirect(`${oauthRedirectUri(c.env).replace('/api/auth/callback', '')}/mail/?denied=role`, 302);
  }
  const session = await signSession({ uid: user.id, uname: user.global_name || user.username || '', roles }, sess);
  const headers = new Headers({ Location: '/mail/inbox/' });
  headers.append('Set-Cookie', setCookie('pck_session', session, { maxAge: 30 * 86400 }));
  headers.append('Set-Cookie', clearCookie('pck_oauth_state', '/api/auth'));
  return new Response(null, { status: 302, headers });
});

app.get('/api/auth/logout', (c) => {
  const headers = new Headers({ Location: '/mail/' });
  headers.append('Set-Cookie', clearCookie('pck_session'));
  return new Response(null, { status: 302, headers });
});

app.get('/api/auth/me', async (c) => {
  const sess = c.env.SESSION_SECRET;
  const s = sess ? await verifySession(readCookie(c.req.header('cookie'), 'pck_session'), sess) : null;
  return c.json({ ok: true, authenticated: !!s, user: s ? { id: s.uid, name: s.uname } : null });
});

// Bounded JSON body reader: content-length can be spoofed or absent
// (chunked), so enforce the cap on the actually-received bytes.
// Throws the Response to return on oversize/invalid input.
async function readJson<T>(c: { req: { text(): Promise<string> }; env: Bindings }): Promise<T> {
  const raw = await c.req.text();
  if (raw.length > maxPayload(c)) throw new Response('Payload too large', { status: 413, headers: SEC_HEADERS });
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }
}

function passthroughResponse(err: unknown): Response | null {
  return err instanceof Response ? err : null;
}

// Timing-safe string compare for webhook secrets (hex or raw strings).
async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const ae = new TextEncoder().encode(a);
  const be = new TextEncoder().encode(b);
  if (ae.length !== be.length) return false;
  return crypto.subtle.timingSafeEqual(ae, be);
}

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Multi-server ingest auth. Passes when ANY holds:
//  - a global webhook secret matches (X-Powercordkit-Secret / X-Forum-Secret),
//  - the per-server token matches (X-Server-Token vs server_tokens hash),
//  - nothing is configured at all (local dev with zero secrets and zero tokens).
async function checkIngestAuth(
  db: D1Database,
  env: Bindings,
  headers: Headers,
  server: string,
): Promise<boolean> {
  const givenGlobal = headers.get('X-Powercordkit-Secret') ?? headers.get('X-Forum-Secret') ?? '';
  const secrets = [env.DISCORD_WEBHOOK_SECRET, env.FORUM_WEBHOOK_SECRET].filter(
    (s): s is string => !!s,
  );
  for (const s of secrets) {
    if (givenGlobal && (await timingSafeEqualString(givenGlobal, s))) return true;
  }
  const givenToken = headers.get('X-Server-Token') ?? '';
  if (givenToken && server) {
    const row = await db
      .prepare(`SELECT token_hash FROM server_tokens WHERE server = ?`)
      .bind(server)
      .first<{ token_hash: string }>();
    if (row && (await timingSafeEqualString(await sha256hex(givenToken), row.token_hash))) {
      return true;
    }
  }
  if (secrets.length === 0 && !givenToken) {
    const any = await db.prepare(`SELECT 1 FROM server_tokens LIMIT 1`).first();
    if (!any) return true;
  }
  return false;
}

// Admin gate for server-token management: the global Discord secret doubles
// as the admin key (open only when no secret is configured, i.e. local dev).
async function requireAdminKey(env: Bindings, headers: Headers): Promise<boolean> {
  const s = env.DISCORD_WEBHOOK_SECRET;
  if (!s) return true;
  const given = headers.get('X-Powercordkit-Secret') ?? '';
  return timingSafeEqualString(given, s);
}

async function verifyDiscourseSignature(  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) return false;
  // Discourse sends: sha256=<hex hmac>
  const expectedPrefix = 'sha256=';
  if (!signatureHeader.startsWith(expectedPrefix)) return false;
  const givenHex = signatureHeader.slice(expectedPrefix.length);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqualString(givenHex, hex);
}

type InboxRow = {
  id: string;
  server: string;
  type: string;
  tag: string;
  author: string;
  title: string;
  content: string;
  time: string;
  prio: string;
  src: string;
  by: string;
  url: string;
  assigned: string | null;
  archived: number;
  created_at: string;
};

type NoteRow = { id: string; item_id: string; by: string; text: string; created_at: string };

type InboxInput = {
  server?: string;
  type?: string;
  tag?: string;
  author?: string;
  title?: string;
  content?: string;
  prio?: string;
  src?: string;
  by?: string;
  url?: string;
};

// Shared insert with bundle-spec bounds (content truncated to 4000 for forum adapters).
async function insertInboxItem(db: D1Database, input: InboxInput, fallbackServer = 'general'): Promise<InboxRow> {
  if (!input.title || input.title.trim().length === 0) throw new Error('title is required');
  const row: InboxRow = {
    id: newId(),
    server: (input.server ?? fallbackServer).slice(0, 80),
    type: (input.type ?? 'idea').slice(0, 32),
    tag: (input.tag ?? input.type ?? 'idea').slice(0, 32),
    author: (input.author ?? 'forum').slice(0, 80),
    title: input.title.slice(0, 300),
    content: (input.content ?? '').slice(0, 4000),
    time: 'now',
    prio: (input.prio ?? 'normal').slice(0, 16),
    src: (input.src ?? 'forum').slice(0, 32),
    by: (input.by ?? 'forum-webhook').slice(0, 80),
    url: (input.url ?? '#').slice(0, 500),
    assigned: null,
    archived: 0,
    created_at: new Date().toISOString(),
  };
  if (!row.server.trim()) throw new Error('server is required');
  await db
    .prepare(
      `INSERT INTO inbox_items (id, server, type, tag, author, title, content, time, prio, src, by, url, assigned, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id, row.server, row.type, row.tag, row.author, row.title, row.content,
      row.time, row.prio, row.src, row.by, row.url, row.assigned, row.archived, row.created_at,
    )
    .run();
  return row;
}

async function getNotesMap(db: D1Database, ids: string[]): Promise<Map<string, NoteRow[]>> {
  const map = new Map<string, NoteRow[]>();
  if (ids.length === 0) return map;
  // D1 has variable limits; chunk to be safe.
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  for (const chunk of chunks) {
    const placeholders = chunk.map(() => '?').join(',');
    const res = await db
      .prepare(`SELECT id, item_id, by, text, created_at FROM notes WHERE item_id IN (${placeholders}) ORDER BY created_at ASC`)
      .bind(...chunk)
      .all<NoteRow>();
    for (const n of res.results ?? []) {
      const arr = map.get(n.item_id) ?? [];
      arr.push(n);
      map.set(n.item_id, arr);
    }
  }
  return map;
}

app.get('/api/health', (c) => {
  return c.json({
    ok: true,
    env: c.env.ENVIRONMENT ?? 'personal',
    personalDomain: c.env.PERSONAL_DOMAIN ?? 'powercordkit.emjay.fyi',
    communityDomain: c.env.COMMUNITY_DOMAIN ?? 'mail.example.com',
    time: new Date().toISOString(),
  });
});

// List inbox items (non-archived by default). Filters: server, type, q, includeArchived=1
app.get('/api/inbox', async (c) => {
  try {
    const server = c.req.query('server') ?? 'all';
    const type = c.req.query('type') ?? 'all';
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    const includeArchived = c.req.query('includeArchived') === '1';

    const where: string[] = [];
    const binds: unknown[] = [];
    if (!includeArchived) {
      where.push('archived = 0');
    }
    if (server !== 'all') {
      where.push('server = ?');
      binds.push(server);
    }
    if (type !== 'all') {
      where.push('type = ?');
      binds.push(type);
    }
    if (q) {
      // Escape LIKE wildcards so a search for "%" can't match everything.
      const qesc = q.replace(/[\\%_]/g, (m) => '\\' + m);
      where.push("(lower(title) LIKE ? ESCAPE '\\' OR lower(content) LIKE ? ESCAPE '\\')");
      binds.push(`%${qesc}%`, `%${qesc}%`);
    }
    const sql =
      `SELECT * FROM inbox_items` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY created_at DESC LIMIT 200`;

    const res = await c.env.DB.prepare(sql)
      .bind(...binds)
      .all<InboxRow>();
    const items = res.results ?? [];
    const notesMap = await getNotesMap(
      c.env.DB,
      items.map((i) => i.id),
    );
    return c.json({
      ok: true,
      count: items.length,
      items: items.map((i) => ({ ...i, notes: notesMap.get(i.id) ?? [] })),
    });
  } catch (err) {
    jsonLog('error', 'inbox list failed', { error: String(err) });
    return bad('Failed to list inbox', 500);
  }
});

// Create inbox item (manual mail from Discord context menu UI or API).
app.post('/api/inbox', async (c) => {
  try {
    const body = await readJson<{
      server?: string;
      type?: string;
      tag?: string;
      author?: string;
      title?: string;
      content?: string;
      prio?: string;
      src?: string;
      by?: string;
      url?: string;
    }>(c);
    if (!body.title || body.title.trim().length === 0) return bad('title is required');
    const row: InboxRow = {
      id: newId(),
      server: (body.server ?? defaultServer(c.env)).slice(0, 80),
      type: (body.type ?? 'idea').slice(0, 32),
      tag: (body.tag ?? body.type ?? 'idea').slice(0, 32),
      author: (body.author ?? 'you').slice(0, 80),
      title: body.title.slice(0, 300),
      content: (body.content ?? '').slice(0, 20000),
      time: 'now',
      prio: (body.prio ?? 'normal').slice(0, 16),
      src: (body.src ?? 'discord').slice(0, 32),
      by: (body.by ?? 'manual').slice(0, 80),
      url: (body.url ?? '#').slice(0, 500),
      assigned: null,
      archived: 0,
      created_at: new Date().toISOString(),
    };
    await c.env.DB.prepare(
      `INSERT INTO inbox_items (id, server, type, tag, author, title, content, time, prio, src, by, url, assigned, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id, row.server, row.type, row.tag, row.author, row.title, row.content,
        row.time, row.prio, row.src, row.by, row.url, row.assigned, row.archived, row.created_at,
      )
      .run();
    jsonLog('info', 'inbox item created', { id: row.id, server: row.server, type: row.type });
    return c.json({ ok: true, item: { ...row, notes: [] } }, 201);
  } catch (err) {
    const passthrough = passthroughResponse(err);
    if (passthrough) return passthrough;
    jsonLog('error', 'inbox create failed', { error: String(err) });
    return bad('Failed to create item', 500);
  }
});

app.post('/api/inbox/:id/notes', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await readJson<{ by?: string; text?: string }>(c);
    if (!body.text || body.text.trim().length === 0) return bad('text is required');
    const existing = await c.env.DB.prepare(`SELECT id FROM inbox_items WHERE id = ?`)
      .bind(id)
      .first();
    if (!existing) return bad('item not found', 404);
    const note: NoteRow = {
      id: newId(),
      item_id: id,
      by: (body.by ?? 'mod').slice(0, 80),
      text: body.text.slice(0, 5000),
      created_at: new Date().toISOString(),
    };
    await c.env.DB.prepare(`INSERT INTO notes (id, item_id, by, text, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(note.id, note.item_id, note.by, note.text, note.created_at)
      .run();
    return c.json({ ok: true, note }, 201);
  } catch (err) {
    const passthrough = passthroughResponse(err);
    if (passthrough) return passthrough;
    jsonLog('error', 'add note failed', { error: String(err) });
    return bad('Failed to add note', 500);
  }
});

app.post('/api/inbox/:id/assign', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await readJson<{ assigned?: string }>(c);
    const r = await c.env.DB.prepare(`UPDATE inbox_items SET assigned = ? WHERE id = ?`)
      .bind((body.assigned ?? null) as string | null, id)
      .run();
    if (Number((r as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0) === 0) {
      return bad('item not found', 404);
    }
    return c.json({ ok: true });
  } catch (err) {
    const passthrough = passthroughResponse(err);
    if (passthrough) return passthrough;
    jsonLog('error', 'assign failed', { error: String(err) });
    return bad('Failed to assign', 500);
  }
});

app.post('/api/inbox/:id/archive', async (c) => {
  try {
    const id = c.req.param('id');
    const r = await c.env.DB.prepare(`UPDATE inbox_items SET archived = 1 WHERE id = ?`).bind(id).run();
    if (Number((r as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0) === 0) {
      return bad('item not found', 404);
    }
    return c.json({ ok: true });
  } catch (err) {
    jsonLog('error', 'archive failed', { error: String(err) });
    return bad('Failed to archive', 500);
  }
});

// Discourse webhook: POST /hooks/discourse
// Configure in Discourse: Admin > Webhooks > POST https://<your-host>/hooks/discourse
// with secret = DISCOURSE_WEBHOOK_SECRET.
app.post('/hooks/discourse', async (c) => {
  try {
    const secret = c.env.DISCOURSE_WEBHOOK_SECRET;
    const raw = await c.req.text();
    if (raw.length > maxPayload(c)) return new Response('Payload too large', { status: 413, headers: SEC_HEADERS });
    // Fail closed: no secret configured (or bad signature) = 401, always.
    // Local dev gets a secret from .dev.vars, so testing still works.
    if (!secret) {
      jsonLog('warn', 'discourse webhook no secret configured');
      return bad('Webhook not configured', 401);
    }
    {
      const sig = c.req.header('X-Discourse-Event-Signature') ?? c.req.header('X-Discourse-Event-Signature-Sha256');
      const ok = await verifyDiscourseSignature(raw, sig ?? null, secret);
      if (!ok) {
        jsonLog('warn', 'discourse webhook bad signature');
        return bad('Bad signature', 401);
      }
    }
    const payload = JSON.parse(raw) as {
      post?: { topic_slug?: string; raw?: string; username?: string; category_slug?: string; topic_id?: number; post_number?: number };
      topic?: { title?: string; tags?: string[]; category_slug?: string };
    };
    const category = payload.post?.category_slug ?? payload.topic?.category_slug ?? 'support';
    const type = category.includes('idea') ? 'idea' : category.includes('support') ? 'support' : 'mailed';
    const title = payload.topic?.title ?? `New forum post in ${category}`;
    const content = (payload.post?.raw ?? raw).slice(0, 20000);
    const author = payload.post?.username ?? 'forum';
    const row: InboxRow = {
      id: newId(),
      server: 'discourse',
      type,
      tag: (payload.topic?.tags?.[0] ?? type).slice(0, 32),
      author: String(author).slice(0, 80),
      title: String(title).slice(0, 300),
      content,
      time: 'now',
      prio: 'normal',
      src: 'discourse',
      by: 'discourse-webhook',
      url: '#',
      assigned: null,
      archived: 0,
      created_at: new Date().toISOString(),
    };
    await c.env.DB.prepare(
      `INSERT INTO inbox_items (id, server, type, tag, author, title, content, time, prio, src, by, url, assigned, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id, row.server, row.type, row.tag, row.author, row.title, row.content,
        row.time, row.prio, row.src, row.by, row.url, row.assigned, row.archived, row.created_at,
      )
      .run();
    jsonLog('info', 'discourse webhook captured', { id: row.id, category });
    return c.json({ ok: true, id: row.id });
  } catch (err) {
    const passthrough = passthroughResponse(err);
    if (passthrough) return passthrough;
    jsonLog('error', 'discourse webhook failed', { error: String(err) });
    return bad('Webhook failed', 500);
  }
});

// Discord bot / context-menu webhook: POST /hooks/discord with X-Powercordkit-Secret
// (or the per-server X-Server-Token — see checkIngestAuth).
app.post('/hooks/discord', async (c) => {
  try {
    const body = await readJson<{
      server?: string; type?: string; title?: string; content?: string; author?: string; by?: string; url?: string; prio?: string;
    }>(c);
    if (!body.title) return bad('title is required');
    const row: InboxRow = {
      id: newId(),
      server: (body.server ?? defaultServer(c.env)).slice(0, 80),
      type: (body.type ?? 'ticket').slice(0, 32),
      tag: (body.type ?? 'ticket').slice(0, 32),
      author: (body.author ?? 'discord').slice(0, 80),
      title: body.title.slice(0, 300),
      content: (body.content ?? '').slice(0, 20000),
      time: 'now',
      prio: (body.prio ?? 'normal').slice(0, 16),
      src: 'discord',
      by: (body.by ?? 'discord-bot').slice(0, 80),
      url: (body.url ?? '#').slice(0, 500),
      assigned: null,
      archived: 0,
      created_at: new Date().toISOString(),
    };
    if (!(await checkIngestAuth(c.env.DB, c.env, c.req.raw.headers, row.server))) {
      return bad('Bad secret', 401);
    }
    await c.env.DB.prepare(
      `INSERT INTO inbox_items (id, server, type, tag, author, title, content, time, prio, src, by, url, assigned, archived, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id, row.server, row.type, row.tag, row.author, row.title, row.content,
        row.time, row.prio, row.src, row.by, row.url, row.assigned, row.archived, row.created_at,
      )
      .run();
    return c.json({ ok: true, id: row.id }, 201);
  } catch (err) {
    const passthrough = passthroughResponse(err);
    if (passthrough) return passthrough;
    jsonLog('error', 'discord webhook failed', { error: String(err) });
    return bad('Webhook failed', 500);
  }
});

// Generic forum adapter webhook: POST /hooks/:name (ForumAdapter registry).
// Built-ins: discord, discourse (also reachable as static routes above, which take
// precedence). Community stubs: nodebb, flarum, lemmy, custom.
// Auth: X-Forum-Secret compared against FORUM_WEBHOOK_SECRET (falls back to
// DISCORD_WEBHOOK_SECRET). Set via: wrangler secret put FORUM_WEBHOOK_SECRET
const FORUM_ADAPTERS = ['nodebb', 'flarum', 'lemmy', 'custom'] as const;

app.post('/hooks/:name', async (c) => {
  try {
    const name = c.req.param('name');
    const known =
      name === 'discord' ||
      name === 'discourse' ||
      (FORUM_ADAPTERS as readonly string[]).includes(name);
    if (!known) return bad('Unknown adapter: ' + name, 404);
    const body = await readJson<InboxInput>(c);
    const server = ((body.server ?? '') || defaultServer(c.env)).slice(0, 80);
    if (!(await checkIngestAuth(c.env.DB, c.env, c.req.raw.headers, server))) {
      return bad('Bad secret', 401);
    }
    const row = await insertInboxItem(c.env.DB, {
      ...body,
      src: name,
      by: body.by ?? name + '-webhook',
    }, defaultServer(c.env));
    jsonLog('info', 'forum adapter captured', { adapter: name, id: row.id });
    return c.json({ ok: true, adapter: name, id: row.id }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'title is required' || msg === 'server is required') return bad(msg);
    jsonLog('error', 'forum adapter webhook failed', { error: msg });
    return bad('Webhook failed', 500);
  }
});

// Live server registry, derived from actual inbox data — works for any number
// of servers with zero configuration. `locked` = a per-server token exists.
// Servers with only archived items still list (count 0) so filters never
// fall back to demo values on a freshly-triaged inbox.
app.get('/api/servers', async (c) => {
  try {
    const res = await c.env.DB.prepare(
      `SELECT server, type, SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS n FROM inbox_items GROUP BY server, type ORDER BY server`,
    ).all<{ server: string; type: string; n: number }>();
    const map = new Map<string, { server: string; count: number; types: Set<string> }>();
    for (const r of res.results ?? []) {
      let e = map.get(r.server);
      if (!e) {
        e = { server: r.server, count: 0, types: new Set() };
        map.set(r.server, e);
      }
      e.count += r.n;
      e.types.add(r.type);
    }
    const toks = await c.env.DB.prepare(`SELECT server FROM server_tokens`).all<{
      server: string;
    }>();
    const locked = new Set((toks.results ?? []).map((t) => t.server));
    const typeRes = await c.env.DB.prepare(
      `SELECT type, SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS n FROM inbox_items GROUP BY type ORDER BY type`,
    ).all<{ type: string; n: number }>();
    return c.json({
      ok: true,
      servers: [...map.values()].map((s) => ({
        server: s.server,
        count: s.count,
        types: [...s.types],
        locked: locked.has(s.server),
      })),
      types: (typeRes.results ?? []).map((t) => ({ type: t.type, count: t.n })),
    });
  } catch (err) {
    jsonLog('error', 'servers list failed', { error: String(err) });
    return bad('Failed to list servers', 500);
  }
});

// Mint (or rotate) a per-server ingestion token. Returns the plaintext token
// ONCE — save it: bots send it as X-Server-Token scoped to `server`.
// Admin auth: global X-Powercordkit-Secret.
app.post('/api/servers/:id/token', async (c) => {
  try {
    if (!(await requireAdminKey(c.env, c.req.raw.headers))) return bad('Admin key required', 401);
    const server = c.req.param('id');
    if (!server || !server.trim()) return bad('server is required', 400);
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    await c.env.DB.prepare(
      `INSERT INTO server_tokens (server, token_hash, created_at) VALUES (?, ?, ?)
       ON CONFLICT(server) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at`,
    )
      .bind(server, await sha256hex(token), new Date().toISOString())
      .run();
    jsonLog('info', 'server token minted', { server });
    return c.json({ ok: true, server, token }, 201);
  } catch (err) {
    jsonLog('error', 'server token mint failed', { error: String(err) });
    return bad('Failed to mint token', 500);
  }
});

// Revoke a server's token (falls back to global-secret auth for that server).
app.delete('/api/servers/:id/token', async (c) => {
  try {
    if (!(await requireAdminKey(c.env, c.req.raw.headers))) return bad('Admin key required', 401);
    await c.env.DB.prepare(`DELETE FROM server_tokens WHERE server = ?`)
      .bind(c.req.param('id'))
      .run();
    return c.json({ ok: true });
  } catch (err) {
    jsonLog('error', 'server token revoke failed', { error: String(err) });
    return bad('Failed to revoke token', 500);
  }
});

// Fallback: serve static assets (Tools hub + Mail UI). API/hooks above take precedence.
app.all('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// Retention: cron deletes inbox items (and their notes) older than 90 days.
// Enable via "triggers": { "crons": ["0 3 * * *"] } in wrangler configs.
async function purgeOld(db: D1Database, days = 90): Promise<number> {  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  await db
    .prepare(`DELETE FROM notes WHERE item_id IN (SELECT id FROM inbox_items WHERE created_at < ?)`)
    .bind(cutoff)
    .run();
  const r = await db.prepare(`DELETE FROM inbox_items WHERE created_at < ?`).bind(cutoff).run();
  return r.meta?.changes ?? 0;
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, _ctx: ExecutionContext): Promise<void> {
    // Daily retention window (cron "0 3 * * *"); every other cron tick polls.
    if (event.cron === '0 3 * * *') {
      try {
        const deleted = await purgeOld(env.DB);
        jsonLog('info', 'retention purge complete', { deleted });
      } catch (err) {
        jsonLog('error', 'retention purge failed', { error: String(err) });
      }
      return;
    }
    try {
      const r = await pollDiscord(
        env.DB,
        env,
        (input, fb) => insertInboxItem(env.DB, input, fb),
        fetch,
        (level, msg, extra) => jsonLog(level, msg, extra),
      );
      if ((r.mailed ?? 0) > 0 || r.skipped !== 'no-bot-token') jsonLog('info', 'discord poll', r);
    } catch (err) {
      jsonLog('error', 'discord poll failed', { error: String(err) });
    }
  },
};
