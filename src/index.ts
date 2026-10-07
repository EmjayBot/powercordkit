import { Hono } from 'hono';

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

// Timing-safe string compare for webhook secrets (hex or raw strings).
async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const ae = new TextEncoder().encode(a);
  const be = new TextEncoder().encode(b);
  if (ae.length !== be.length) return false;
  return crypto.subtle.timingSafeEqual(ae, be);
}

async function verifyDiscourseSignature(
  rawBody: string,
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
      where.push('(lower(title) LIKE ? OR lower(content) LIKE ?)');
      binds.push(`%${q}%`, `%${q}%`);
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
    const body = await c.req.json<{
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
    }>();
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
    jsonLog('error', 'inbox create failed', { error: String(err) });
    return bad('Failed to create item', 500);
  }
});

app.post('/api/inbox/:id/notes', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ by?: string; text?: string }>();
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
    jsonLog('error', 'add note failed', { error: String(err) });
    return bad('Failed to add note', 500);
  }
});

app.post('/api/inbox/:id/assign', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{ assigned?: string }>();
    await c.env.DB.prepare(`UPDATE inbox_items SET assigned = ? WHERE id = ?`)
      .bind((body.assigned ?? null) as string | null, id)
      .run();
    return c.json({ ok: true });
  } catch (err) {
    jsonLog('error', 'assign failed', { error: String(err) });
    return bad('Failed to assign', 500);
  }
});

app.post('/api/inbox/:id/archive', async (c) => {
  try {
    const id = c.req.param('id');
    await c.env.DB.prepare(`UPDATE inbox_items SET archived = 1 WHERE id = ?`).bind(id).run();
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
    if (secret) {
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
    jsonLog('error', 'discourse webhook failed', { error: String(err) });
    return bad('Webhook failed', 500);
  }
});

// Discord bot / context-menu webhook: POST /hooks/discord with X-Powercordkit-Secret
app.post('/hooks/discord', async (c) => {
  try {
    const secret = c.env.DISCORD_WEBHOOK_SECRET;
    if (secret) {
      const given = c.req.header('X-Powercordkit-Secret') ?? '';
      const ok = await timingSafeEqualString(given, secret);
      if (!ok) return bad('Bad secret', 401);
    }
    const body = await c.req.json<{
      server?: string; type?: string; title?: string; content?: string; author?: string; by?: string; url?: string; prio?: string;
    }>();
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
    const secret = c.env.FORUM_WEBHOOK_SECRET ?? c.env.DISCORD_WEBHOOK_SECRET;
    if (secret) {
      const given = c.req.header('X-Forum-Secret') ?? c.req.header('X-Powercordkit-Secret') ?? '';
      if (!(await timingSafeEqualString(given, secret))) return bad('Bad secret', 401);
    }
    const body = await c.req.json<InboxInput>();
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

// Fallback: serve static assets (Tools hub + Mail UI). API/hooks above take precedence.
app.all('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// Retention: cron deletes inbox items (and their notes) older than 90 days.
// Enable via "triggers": { "crons": ["0 3 * * *"] } in wrangler configs.
async function purgeOld(db: D1Database, days = 90): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  await db
    .prepare(`DELETE FROM notes WHERE item_id IN (SELECT id FROM inbox_items WHERE created_at < ?)`)
    .bind(cutoff)
    .run();
  const r = await db.prepare(`DELETE FROM inbox_items WHERE created_at < ?`).bind(cutoff).run();
  return r.meta?.changes ?? 0;
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Bindings, _ctx: ExecutionContext): Promise<void> {
    try {
      const deleted = await purgeOld(env.DB);
      jsonLog('info', 'retention purge complete', { deleted });
    } catch (err) {
      jsonLog('error', 'retention purge failed', { error: String(err) });
    }
  },
};
