// Ed25519 signature verification for Discord interactions.
// Pure module: uses only WebCrypto, so it runs in Workers and in Node.
// Workers expose Ed25519 as "NODE-ED25519"; Node (and newer runtimes) as
// "Ed25519". We try both so the same code works everywhere.

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export async function verifyEd25519(
  publicKeyHex: string,
  signatureHex: string,
  message: Uint8Array,
): Promise<boolean> {
  if (!publicKeyHex || !signatureHex) return false;
  const raw = hexToBytes(publicKeyHex);
  const sig = hexToBytes(signatureHex);
  for (const alg of ['Ed25519', 'NODE-ED25519'] as const) {
    try {
      const key = await crypto.subtle.importKey('raw', raw, { name: alg } as never, false, ['verify']);
      const ok = await crypto.subtle.verify({ name: alg } as never, key, sig, message);
      if (ok) return true;
    } catch {
      // algorithm unsupported here; try the next
    }
  }
  return false;
}

// Discord signs the concatenation of the timestamp header and the raw body.
export async function verifyDiscordRequest(
  publicKeyHex: string,
  signatureHex: string | null | undefined,
  timestamp: string | null | undefined,
  body: string,
): Promise<boolean> {
  if (!signatureHex || !timestamp) return false;
  return verifyEd25519(publicKeyHex, signatureHex, new TextEncoder().encode(timestamp + body));
}
