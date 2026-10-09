// No-hosting Discord poller (Cloudflare cron → Discord REST → inbox).
// Pure module: no Worker imports, so it can be unit-tested in plain Node.
// The Worker (src/index.ts) calls pollDiscord() from its scheduled handler.

export type FeedChannel = { guild: string; channel: string; server: string; type: string };
export type FeedThreadSource = { guild: string; parent: string; server: string; type: string };

export type InboxInput = {
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

// Minimal structural DB surface (D1Database satisfies this).
export type PollDb = {
  prepare(query: string): {
    first<T>(): Promise<T | null>;
    run(): Promise<unknown>;
    all<T>(): Promise<{ results?: T[] }>;
    bind(...args: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
      all<T>(): Promise<{ results?: T[] }>;
    };
  };
};

export type PollEnv = {
  DISCORD_BOT_TOKEN?: string;
  FEED_MAP?: string;
  POLL_DEBUG?: string;
};

export type Logger = (level: string, msg: string, extra?: Record<string, unknown>) => void;

const noopLog: Logger = () => {};

export function parseFeedMap(env: PollEnv): { channels: FeedChannel[]; threads: FeedThreadSource[] } {
  try {
    const p = JSON.parse(env.FEED_MAP ?? '{}') as Partial<{ channels: FeedChannel[]; threads: FeedThreadSource[] }>;
    const ok = (f: { server?: string }) => !!f.server;
    return {
      channels: Array.isArray(p.channels) ? p.channels.filter(ok) : [],
      threads: Array.isArray(p.threads) ? p.threads.filter(ok) : [],
    };
  } catch {
    return { channels: [], threads: [] };
  }
}

type DMsg = {
  id: string;
  content?: string;
  author?: { bot?: boolean; username?: string };
  mentions?: { id: string; global_name?: string; username?: string }[];
  mention_roles?: string[];
};
type DThread = {
  id: string;
  name?: string;
  parent_id?: string;
  guild_id?: string;
  owner_id?: string;
  applied_tags?: string[];
  thread_metadata?: { archived?: boolean; archive_timestamp?: string };
};
type DStarter = {
  content?: string;
  author?: { username?: string; global_name?: string };
  mentions?: { id: string; global_name?: string; username?: string }[];
  mention_roles?: string[];
};

type GuildMaps = { roles: Map<string, string>; channels: Map<string, string> };

// Role + channel id->name maps per guild (cached for the current run).
async function guildMaps(api: DiscordApi, guild: string, cache: Map<string, GuildMaps>): Promise<GuildMaps> {
  const hit = cache.get(guild);
  if (hit) return hit;
  const roles = new Map<string, string>();
  const channels = new Map<string, string>();
  const r = (await api(`/guilds/${guild}/roles`)) as { id: string; name: string }[] | null;
  for (const x of r ?? []) roles.set(x.id, x.name);
  const c = (await api(`/guilds/${guild}/channels`)) as { id: string; name: string }[] | null;
  for (const x of c ?? []) channels.set(x.id, x.name);
  const m: GuildMaps = { roles, channels };
  cache.set(guild, m);
  return m;
}

// Turn <@id>, <@&id>, <#id>, and custom emoji into readable text using names.
export function resolveMentions(
  text: string,
  msg: { mentions?: { id: string; global_name?: string; username?: string }[] },
  roles: Map<string, string>,
  channels: Map<string, string>,
): string {
  const users = new Map<string, string>();
  for (const u of msg.mentions ?? []) users.set(u.id, u.global_name || u.username || 'user');
  return text
    .replace(/<@!?(\d+)>/g, (_m, id: string) => '@' + (users.get(id) ?? 'user'))
    .replace(/<@&(\d+)>/g, (_m, id: string) => '@' + (roles.get(id) ?? 'role'))
    .replace(/<#(\d+)>/g, (_m, id: string) => '#' + (channels.get(id) ?? 'channel'))
    .replace(/<a?:(\w+):\d+>/g, ':$1:');
}

const newer = (a: string, b: string): boolean => {
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return a > b;
  }
};

export type DiscordApi = (path: string) => Promise<unknown>;

// Shared Discord REST caller (bot auth). Returns null on any non-2xx so callers
// can skip gracefully; 429/other errors are logged.
export function makeDiscordApi(
  token: string,
  fetchFn: typeof fetch = fetch,
  log: Logger = noopLog,
): DiscordApi {
  return async (path: string): Promise<unknown> => {
    const r = await fetchFn('https://discord.com/api/v10' + path, {
      headers: { Authorization: 'Bot ' + token },
    });
    if (r.status === 429) {
      log('warn', 'discord rate-limited', { path });
      return null;
    }
    if (!r.ok) {
      log('warn', 'discord api error', { path, status: r.status });
      return null;
    }
    try {
      return (await r.json()) as unknown;
    } catch {
      return null;
    }
  };
}

// Forum channel tag id -> name map (GET /channels/{forum}).
export async function forumTagMap(api: DiscordApi, parent: string): Promise<Record<string, string>> {
  const ch = (await api(`/channels/${parent}`)) as { available_tags?: { id: string; name: string }[] } | null;
  const m: Record<string, string> = {};
  for (const t of ch?.available_tags ?? []) m[t.id] = t.name;
  return m;
}

// First message of a forum post. For forum threads the starter message id equals
// the thread id, so /channels/{thread}/messages/{thread} returns the post body.
export async function threadStarter(
  api: DiscordApi,
  threadId: string,
): Promise<{ content: string; author: string; mentions: NonNullable<DStarter['mentions']> }> {
  const msg = (await api(`/channels/${threadId}/messages/${threadId}`)) as DStarter | null;
  return {
    content: (msg?.content ?? '').slice(0, 4000),
    author: msg?.author?.global_name || msg?.author?.username || '',
    mentions: msg?.mentions ?? [],
  };
}

// Best-effort post body: the starter message, else the first message in the
// thread that actually has text. Guards against posts whose starter is empty.
export async function threadBody(
  api: DiscordApi,
  threadId: string,
): Promise<{ content: string; author: string; mentions: NonNullable<DStarter['mentions']> }> {
  const starter = await threadStarter(api, threadId);
  if (starter.content.trim()) return starter;
  const msgs = (await api(`/channels/${threadId}/messages?limit=20`)) as DStarter[] | null;
  if (Array.isArray(msgs)) {
    const hit = msgs.find((m) => (m.content ?? '').trim().length > 0);
    if (hit) {
      return {
        content: (hit.content ?? '').slice(0, 4000),
        author: starter.author || hit.author?.global_name || hit.author?.username || '',
        mentions: hit.mentions ?? [],
      };
    }
  }
  return starter;
}

function threadTag(th: DThread, tagMap: Record<string, string>, fallback: string): string {
  const names = (th.applied_tags ?? []).map((id) => tagMap[id]).filter((x): x is string => !!x);
  return names.length ? names.join(', ') : fallback;
}

export async function pollDiscord(
  db: PollDb,
  env: PollEnv,
  insert: (input: InboxInput, fallbackServer: string) => Promise<unknown>,
  fetchFn: typeof fetch = fetch,
  log: Logger = noopLog,
): Promise<{ mailed: number; skipped?: string }> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return { mailed: 0, skipped: 'no-bot-token' };
  const map = parseFeedMap(env);
  if (map.channels.length === 0 && map.threads.length === 0) {
    return { mailed: 0, skipped: 'no-feeds' };
  }
  const api = makeDiscordApi(token, fetchFn, log);
  const getMark = async (k: string): Promise<string> => {
    const row = await db.prepare('SELECT value FROM poll_state WHERE key = ?').bind(k).first<{ value: string }>();
    return row?.value ?? '';
  };
  const setMark = async (k: string, v: string): Promise<void> => {
    await db
      .prepare('INSERT INTO poll_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(k, v)
      .run();
  };
  let mailed = 0;
  const gcache = new Map<string, GuildMaps>();
  const debug = env.POLL_DEBUG === '1' ? log : noopLog;
  // Channel messages (MESSAGE_CREATE equivalent).
  for (const f of map.channels) {
    const last = await getMark('msg:' + f.channel);
    const msgs = (await api(`/channels/${f.channel}/messages?limit=25` + (last ? `&after=${last}` : ''))) as DMsg[] | null;
    debug('info', 'poll feed', { kind: 'messages', server: f.server, channel: f.channel, last: last || '(none)', got: Array.isArray(msgs) ? msgs.length : 'error' });
    if (!Array.isArray(msgs)) continue;
    const fresh = msgs
      .filter((m) => !m.author?.bot && (!last || newer(m.id, last)))
      .sort((a, b) => (a.id === b.id ? 0 : newer(a.id, b.id) ? 1 : -1));
    for (const m of fresh) {
      const maps = await guildMaps(api, f.guild, gcache);
      const text = resolveMentions((m.content ?? '').slice(0, 4000), m, maps.roles, maps.channels);
      await insert(
        {
          server: f.server,
          type: f.type,
          title: text.slice(0, 80) || '(attachment)',
          content: text,
          author: m.author?.username ?? 'discord',
          by: 'poller',
          src: 'discord',
          url: `https://discord.com/channels/${f.guild}/${f.channel}/${m.id}`,
        },
        f.server,
      );
      mailed++;
    }
    if (fresh.length > 0) await setMark('msg:' + f.channel, fresh[fresh.length - 1].id);
  }
  // Forum/thread channels: active threads + archived public threads.
  // Forum posts auto-archive (default ~24h), so polling only /threads/active
  // permanently misses any post that archives before a tick. We page through
  // the archived-public listing too, then dedupe by thread id.
  for (const t of map.threads) {
    const seenIds = new Set<string>();
    const collected: DThread[] = [];
    // Active threads come from the guild-level endpoint: the channel-level
    // /threads/active 404s on forum channels, so fresh (unarchived) posts would
    // otherwise be missed until they archive. Fall back to channel-level if the
    // guild call fails.
    let active: DThread[] = [];
    const guildActive = (await api(`/guilds/${t.guild}/threads/active`)) as { threads?: DThread[] } | null;
    if (guildActive && Array.isArray(guildActive.threads)) {
      active = guildActive.threads.filter((th) => th.parent_id === t.parent);
    } else {
      const channelActive = (await api(`/channels/${t.parent}/threads/active`)) as { threads?: DThread[] } | null;
      active = channelActive?.threads ?? [];
    }
    for (const th of active) {
      if (!seenIds.has(th.id)) { seenIds.add(th.id); collected.push(th); }
    }
    let before: string | undefined;
    for (const kind of ['public', 'private'] as const) {
      before = undefined;
      for (let page = 0; page < 5; page++) {
        const q =
          `/channels/${t.parent}/threads/archived/${kind}?limit=100` +
          (before ? `&before=${encodeURIComponent(before)}` : '');
        const data = (await api(q)) as { threads?: DThread[]; has_more?: boolean } | null;
        if (!data || !Array.isArray(data.threads) || data.threads.length === 0) break;
        for (const th of data.threads) {
          if (!seenIds.has(th.id)) { seenIds.add(th.id); collected.push(th); }
        }
        if (!data.has_more) break;
        const times = data.threads
          .map((x) => x.thread_metadata?.archive_timestamp)
          .filter((x): x is string => !!x)
          .sort();
        before = times[0];
        if (!before) break;
      }
    }
    debug('info', 'poll feed', {
      kind: 'threads',
      server: t.server,
      parent: t.parent,
      active: active.length,
      total: collected.length,
    });
    const tagMaps = new Map<string, Record<string, string>>();
    let processed = 0;
    for (const th of collected) {
      const seen = await db.prepare('SELECT 1 FROM seen_threads WHERE thread_id = ?').bind(th.id).first();
      if (seen) continue;
      // Cap new threads per tick: each one needs a starter-message fetch, and a
      // large backfill would otherwise blow past Worker subrequest limits. The
      // rest are picked up on subsequent cron ticks (seen_threads tracks them).
      if (processed >= 25) break;
      if (!tagMaps.has(t.parent)) tagMaps.set(t.parent, await forumTagMap(api, t.parent));
      const tag = threadTag(th, tagMaps.get(t.parent) ?? {}, t.type);
      const body = await threadBody(api, th.id);
      const maps = await guildMaps(api, t.guild, gcache);
      const content = resolveMentions(body.content, { mentions: body.mentions }, maps.roles, maps.channels);
      await insert(
        {
          server: t.server,
          type: t.type,
          tag,
          title: (th.name ?? 'untitled').slice(0, 120),
          content: content || `New thread in <#${t.parent}>`,
          author: body.author || th.owner_id || 'discord',
          by: 'poller',
          src: 'discord',
          url: `https://discord.com/channels/${t.guild}/${th.id}`,
        },
        t.server,
      );
      await db.prepare('INSERT OR IGNORE INTO seen_threads (thread_id) VALUES (?)').bind(th.id).run();
      mailed++;
      processed++;
    }
    await db
      .prepare('DELETE FROM seen_threads WHERE seen_at < ?')
      .bind(new Date(Date.now() - 30 * 86400000).toISOString())
      .run();
  }
  return { mailed };
}

// Backfill existing poller-created thread items whose body is still the
// placeholder with the real post content, author, and forum tag names.
// Processes a bounded batch and returns `remaining` so it can be called
// repeatedly without exceeding Worker subrequest limits.
export async function backfillDiscordThreads(
  db: PollDb,
  env: PollEnv,
  limit = 40,
  fetchFn: typeof fetch = fetch,
  log: Logger = noopLog,
): Promise<{ updated: number; remaining: number }> {
  const token = env.DISCORD_BOT_TOKEN;
  if (!token) return { updated: 0, remaining: 0 };
  const api = makeDiscordApi(token, fetchFn, log);
  // Items needing work: still the placeholder, empty, or containing unresolved
  // Discord markup (<@user>, <@&role>, <#channel>, <:emoji:>). Resolving removes
  // the markup, so repeat runs progress and then stop.
  const NEEDS =
    "(content = '' OR content LIKE 'New thread in <%' OR content LIKE '%<@%' OR content LIKE '%<#%' OR content LIKE '%<:%')";
  const rows = await db
    .prepare(
      `SELECT id, url, type FROM inbox_items
       WHERE src = 'discord' AND by = 'poller' AND ${NEEDS}
       LIMIT ?`,
    )
    .bind(limit)
    .all<{ id: string; url: string; type: string }>();
  const tagMaps = new Map<string, Record<string, string>>();
  const gcache = new Map<string, GuildMaps>();
  let updated = 0;
  for (const row of rows.results ?? []) {
    const threadId = (row.url || '').split('/').pop() || '';
    if (!/^\d+$/.test(threadId)) continue;
    const th = (await api(`/channels/${threadId}`)) as DThread | null;
    if (!th) {
      // Thread gone (deleted) — mark so we don't retry forever.
      await db.prepare(`UPDATE inbox_items SET content = '(deleted)' WHERE id = ?`).bind(row.id).run();
      continue;
    }
    const parent = th.parent_id || '';
    if (!tagMaps.has(parent)) tagMaps.set(parent, await forumTagMap(api, parent));
    const tag = threadTag(th, tagMaps.get(parent) ?? {}, row.type || 'support');
    const body = await threadBody(api, threadId);
    const maps = await guildMaps(api, th.guild_id || '', gcache);
    const resolved = resolveMentions(body.content, { mentions: body.mentions }, maps.roles, maps.channels);
    const content = resolved.trim() ? resolved : '(no text content)';
    await db
      .prepare(`UPDATE inbox_items SET content = ?, tag = ?, author = ?, title = ? WHERE id = ?`)
      .bind(content, tag, body.author || 'discord', (th.name ?? 'untitled').slice(0, 120), row.id)
      .run();
    updated++;
  }
  const remaining = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM inbox_items
       WHERE src = 'discord' AND by = 'poller' AND ${NEEDS}`,
    )
    .first<{ n: number }>();
  return { updated, remaining: Number(remaining?.n ?? 0) };
}
