// Cloudflare Access (Zero Trust) JWT verification.
// Pure module: uses only web globals (fetch, crypto, atob, TextDecoder) so it
// runs in Workers and can be unit-tested in Node. No Worker imports.

let jwksCache: { keys: Record<string, CryptoKey>; expires: number } | null = null;

function b64urlBytes(s: string): Uint8Array {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function accessKey(team: string, kid: string): Promise<CryptoKey | null> {
  const now = Date.now();
  if (!jwksCache || jwksCache.expires < now) {
    const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
    if (!res.ok) return null;
    const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
    const keys: Record<string, CryptoKey> = {};
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid) continue;
      try {
        keys[jwk.kid] = await crypto.subtle.importKey(
          'jwk',
          jwk,
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify'],
        );
      } catch {
        // skip keys we can't import (e.g. unexpected alg)
      }
    }
    jwksCache = { keys, expires: now + 3600_000 };
  }
  return jwksCache.keys[kid] ?? null;
}

// Verifies a Cloudflare Access `Cf-Access-Jwt-Assertion`: RS256 signature against
// the team's published JWKS, plus iss/aud/exp/nbf checks. team = "acme.cloudflareaccess.com".
export async function verifyAccessJwt(
  jwt: string | null,
  team: string,
  aud: string,
): Promise<boolean> {
  if (!jwt) return false;
  const parts = jwt.split('.');
  if (parts.length !== 3) return false;
  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlBytes(parts[1])));
  } catch {
    return false;
  }
  if (header.alg !== 'RS256' || !header.kid) return false;
  const key = await accessKey(team, header.kid);
  if (!key) return false;
  const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  let ok = false;
  try {
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), data);
  } catch {
    return false;
  }
  if (!ok) return false;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) return false;
  if (payload.nbf && now < payload.nbf - 60) return false;
  if (payload.iss !== `https://${team}` && payload.iss !== team) return false;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  return auds.includes(aud);
}
