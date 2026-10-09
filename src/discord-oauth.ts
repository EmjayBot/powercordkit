// Discord OAuth2 login + signed session cookies.
// Pure module: only web globals (fetch, crypto, atob/btoa, TextEncoder/Decoder)
// so it runs in Workers and can be unit-tested in Node. No Worker imports.

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (b.length % 4)) % 4;
  const bin = atob(b + '='.repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export function randomState(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

// Signed, tamper-proof session value: base64url(payload).base64url(hmac).
export async function signSession(
  payload: Record<string, unknown>,
  secret: string,
  ttlMs = 30 * 86400_000,
): Promise<string> {
  const body = { ...payload, exp: Date.now() + ttlMs };
  const p = b64url(enc.encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(p));
  return p + '.' + b64url(new Uint8Array(sig));
}

export async function verifySession(
  token: string | null | undefined,
  secret: string,
): Promise<Record<string, unknown> | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [p, s] = parts;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64urlDecode(s), enc.encode(p));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as { exp?: number };
    if (typeof body.exp === 'number' && Date.now() > body.exp) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function discordLoginUrl(clientId: string, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify guilds.members.read',
    state,
  });
  return 'https://discord.com/api/oauth2/authorize?' + p.toString();
}

export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<string | null> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  const r = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { access_token?: string };
  return j.access_token ?? null;
}

export async function discordUser(
  accessToken: string,
): Promise<{ id: string; username?: string; global_name?: string } | null> {
  const r = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!r.ok) return null;
  return (await r.json()) as { id: string; username?: string; global_name?: string };
}

// Roles the user holds in the guild; null if not a member / cannot read.
export async function discordMemberRoles(accessToken: string, guildId: string): Promise<string[] | null> {
  const r = await fetch(`https://discord.com/api/users/@me/guilds/${guildId}/member`, {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { roles?: string[] };
  return j.roles ?? [];
}

// Cookie helpers.
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function setCookie(name: string, value: string, opts: { maxAge?: number; path?: string } = {}): string {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'HttpOnly', 'Secure', 'SameSite=Lax', `Path=${opts.path ?? '/'}`];
  if (typeof opts.maxAge === 'number') bits.push(`Max-Age=${opts.maxAge}`);
  return bits.join('; ');
}

export function clearCookie(name: string, path = '/'): string {
  return `${name}=; HttpOnly; Secure; SameSite=Lax; Path=${path}; Max-Age=0`;
}
