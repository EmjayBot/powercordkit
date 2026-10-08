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
    bind(...args: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
};

export type PollEnv = {
  DISCORD_BOT_TOKEN?: string;
  FEED_MAP?: string;
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

type DMsg = { id: string; content?: string; author?: { bot?: boolean; username?: string } };

const newer = (a: string, b: string): boolean => {
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return a > b;
  }
};

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
  const api = async (path: string): Promise<unknown> => {
    const r = await fetchFn('https://discord.com/api/v10' + path, {
      headers: { Authorization: 'Bot ' + token },
    });
    if (r.status === 429) {
      log('warn', 'discord poll rate-limited', { path });
      return null;
    }
    if (!r.ok) {
      log('warn', 'discord api error', { path, status: r.status });
      return null;
    }
    return (await r.json()) as unknown;
  };
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
  // Channel messages (MESSAGE_CREATE equivalent).
  for (const f of map.channels) {
    const last = await getMark('msg:' + f.channel);
    const msgs = (await api(`/channels/${f.channel}/messages?limit=25` + (last ? `&after=${last}` : ''))) as DMsg[] | null;
    if (!Array.isArray(msgs)) continue;
    const fresh = msgs
      .filter((m) => !m.author?.bot && (!last || newer(m.id, last)))
      .sort((a, b) => (a.id === b.id ? 0 : newer(a.id, b.id) ? 1 : -1));
    for (const m of fresh) {
      const text = (m.content ?? '').slice(0, 4000);
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
  // Active threads (THREAD_CREATE equivalent for report-style channels).
  for (const t of map.threads) {
    const data = (await api(`/channels/${t.parent}/threads/active`)) as {
      threads?: { id: string; name?: string; owner_id?: string }[];
    } | null;
    for (const th of data?.threads ?? []) {
      const seen = await db.prepare('SELECT 1 FROM seen_threads WHERE thread_id = ?').bind(th.id).first();
      if (seen) continue;
      await insert(
        {
          server: t.server,
          type: t.type,
          title: 'Thread: ' + (th.name ?? 'untitled').slice(0, 80),
          content: `New thread in <#${t.parent}>`,
          author: th.owner_id ?? 'unknown',
          by: 'poller',
          src: 'discord',
          url: `https://discord.com/channels/${t.guild}/${th.id}`,
        },
        t.server,
      );
      await db.prepare('INSERT OR IGNORE INTO seen_threads (thread_id) VALUES (?)').bind(th.id).run();
      mailed++;
    }
    await db
      .prepare('DELETE FROM seen_threads WHERE seen_at < ?')
      .bind(new Date(Date.now() - 30 * 86400000).toISOString())
      .run();
  }
  return { mailed };
}
