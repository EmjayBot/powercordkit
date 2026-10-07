// Build the tools-only site: pure static labs, no Mail backend.
// Usage: node scripts/build-tools.mjs [--out dist/tools]
// Output can be deployed to Cloudflare Pages, GitHub Pages, or any static host.
import { cpSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : join(ROOT, 'dist', 'tools');

// Backend-dependent pages excluded from the tools-only site.
const PRUNE = ['mail', 'tickets', 'ideas'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const entry of readdirSync(join(ROOT, 'public'))) {
  if (PRUNE.includes(entry)) continue;
  cpSync(join(ROOT, 'public', entry), join(out, entry), { recursive: true });
}

// Patch the hub: drop Mail/API sections (marked), repoint Mail links to setup.
const hubPath = join(out, 'index.html');
let hub = readFileSync(hubPath, 'utf8');
hub = hub.replace(/<!-- TOOLS:REMOVE-START -->[\s\S]*?<!-- TOOLS:REMOVE-END -->/g, '');
hub = hub.replace(
  '<!-- TOOLS:INSERT-SETUP -->',
  `<div class="sec" id="inbox">
    <h2>✉️ Need the mod inbox?</h2>
    <p class="sub">This tools site is backend-free. The Mail inbox (triage, tickets, webhooks) is one Worker + D1 away.</p>
    <div class="grid"><a class="card" href="/mail-setup/"><h3>📖 Mail setup guide</h3><p>Self-host the inbox in ~20 minutes: Worker, D1, secrets, domain, Discourse + Discord wiring.</p></a></div>
  </div>`,
);
hub = hub.replace(
  '<a class="btn" href="/mail/">Open Mail overview →</a>',
  '<a class="btn" href="/mail-setup/">Self-host the inbox →</a>',
);
hub = hub.replaceAll('<a href="/mail/">Mail</a>', '<a href="/mail-setup/">Mail setup</a>');
writeFileSync(hubPath, hub);

// The setup guide ships with the tools site too — repoint its Mail-overview
// back-links at the tools hub (no /mail/ route exists here).
const setupPath = join(out, 'mail-setup', 'index.html');
let setup = readFileSync(setupPath, 'utf8');
setup = setup.split('<a href="/mail/">Mail overview</a>').join('<a href="/">Tools hub</a>');
writeFileSync(setupPath, setup);

// Sanity: hub must not LINK to removed routes anymore.
// (JS fetch('/api/…') calls are fine — they fail gracefully into static mode.)
const leftovers = ['href="/mail/inbox"', 'href="/mail/"', 'href="/tickets/"', 'href="/ideas/"', 'href="/api/']
  .filter((s) => hub.includes(s));
if (leftovers.length > 0) {
  console.error('LEFTOVER backend refs in tools hub: ' + leftovers.join(', '));
  process.exit(1);
}
if (!existsSync(join(out, 'mail-setup', 'index.html'))) {
  console.error('Missing mail-setup guide in tools output');
  process.exit(1);
}
// Credit stays with the code: the tools hub must keep visible attribution.
if (!hub.includes('Powered by') || !hub.includes('PowerCordKit')) {
  console.error('MISSING PowerCordKit credit in tools hub');
  process.exit(1);
}
console.log('tools-only site built at ' + out);
console.log('routes: ' + readdirSync(out).filter((e) => !e.startsWith('.')).join(', '));
