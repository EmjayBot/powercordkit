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

// Instance identity: copy tools.config.json to tools.<yours>.json, tweak it,
// and pass --config. Showcase (powercordkit.emjay.fyi) keeps its own look;
// every self-hosted toolset gets its own name, tagline and accent.
const identityFile = process.argv.includes('--config')
  ? process.argv[process.argv.indexOf('--config') + 1]
  : join(ROOT, 'tools.config.json');
const identity = JSON.parse(readFileSync(identityFile, 'utf8'));
for (const k of ['siteName', 'tagline', 'accent', 'footerNote', 'baseUrl']) {
  if (!identity[k] || typeof identity[k] !== 'string') {
    console.error(`tools identity ${identityFile} missing required string: ${k}`);
    process.exit(1);
  }
}
if (!identity.footerNote.includes('PowerCordKit')) {
  console.error('tools identity footerNote must keep the Powered-by-PowerCordKit credit');
  process.exit(1);
}
// Custom header: fork's own brand + links. Falls back to siteName + a
// Tools/Mail-setup pair when omitted. hrefs may be "#anchors", "/root-paths"
// (rebased to baseUrl automatically) or full https:// URLs.
const header = identity.header && typeof identity.header === 'object' ? identity.header : {};
const brand = typeof header.brand === 'string' && header.brand ? header.brand : identity.siteName;
const logo = typeof header.logo === 'string' && header.logo ? header.logo : '/assets/powercordkit_logo.png';
const links = Array.isArray(header.links) && header.links.length > 0 ? header.links : [
  { label: 'Tools', href: '#tools' },
  { label: 'Mail setup', href: '/mail-setup/' },
];
for (const l of links) {
  if (!l || typeof l.label !== 'string' || typeof l.href !== 'string' || !l.label || !l.href) {
    console.error(`tools identity ${identityFile}: every header.links[] needs {label, href} strings`);
    process.exit(1);
  }
}
let base = identity.baseUrl;
if (!base.startsWith('/')) {
  console.error('tools identity baseUrl must start with / (use "/" for domain root)');
  process.exit(1);
}
if (!base.endsWith('/')) base += '/';

// Backend-dependent pages excluded from the tools-only site.
const PRUNE = ['mail', 'tickets', 'ideas'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const entry of readdirSync(join(ROOT, 'public'))) {
  if (PRUNE.includes(entry)) continue;
  cpSync(join(ROOT, 'public', entry), join(out, entry), { recursive: true });
}

// Blank-slate hub: no header, no hero, no section titles — just the tool
// cards, the setup card, and the credit footer. Lab cards and CSS are lifted
// from the showcase hub so they never drift. Forks customize name/links via
// the identity file (siteName, baseUrl) — title tag + footer carry identity.
const hubPath = join(out, 'index.html');
const showcase = readFileSync(hubPath, 'utf8');
const css = (showcase.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
if (!css) {
  console.error('Could not extract CSS from showcase hub');
  process.exit(1);
}
const labsRaw = (showcase.match(/<!-- TOOLS:LABS-START -->([\s\S]*?)<!-- TOOLS:LABS-END -->/) || [])[1] || '';
if (!labsRaw.includes('/embeds/')) {
  console.error('Could not extract lab cards from showcase hub');
  process.exit(1);
}
// One unified grid: strip the showcase wrapper, drop " Lab" from card
// titles ("Embed Lab" → "Embed"), append the setup card. Showcase untouched.
const labs = labsRaw
  .replace(/^\s*<div class="grid">/, '')
  .replace(/<\/div>\s*$/, '')
  .replace(/ Lab<\/h3>/g, '</h3>');
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hub = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escAttr(identity.siteName)} — Discord Tools</title>
<meta name="description" content="${escAttr(identity.tagline)}" />
<link rel="icon" href="/assets/powercordkit_logo.png" />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
<style>${css.replace('--b:#5865F2', `--b:${identity.accent}`)}</style>
</head>
<body>
<div class="nav">
  <a class="logo" href="/"><img src="${escAttr(logo)}" alt="" /> ${escAttr(brand)}</a>
  <div class="links">${links.map((l) => `<a href="${escAttr(l.href)}">${escAttr(l.label)}</a>`).join('')}</div>
</div>
<div class="wrap" style="padding-top:24px;max-width:1080px">
  <div class="grid" id="tools">${labs}
    <a class="card" href="/mail-setup/"><h3>Mail setup guide</h3><p>Self-host the inbox in ~20 minutes: Worker, D1, secrets, domain, Discourse + Discord wiring.</p></a>
  </div>
</div>
<div class="foot"><div class="in" style="justify-content:center">
  <span>${identity.footerNote}</span>
</div></div>
</body>
</html>
`;
writeFileSync(hubPath, hub);

// baseUrl: repoint every root-absolute link/asset in the tools site so forks
// can live at domain root ("/") or any subpath ("/my-tools/").
const bp = base === '/' ? '' : base.slice(0, -1);
const rewriteFile = (p) => {
  let t = readFileSync(p, 'utf8');
  t = t.replace(/(href|src)="\/(?!\/)/g, `$1="${bp}/`);
  // Forks don't say "Lab" anywhere: page titles + topbar labels.
  t = t.replace(/ Lab — PowerCordKit<\/title>/g, ' — PowerCordKit</title>');
  t = t.replace(/\/ ([A-Za-z]+) Lab<\/span>/g, '/$1</span>');
  writeFileSync(p, t);
};
const walkHtml = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkHtml(p);
    else if (e.name.endsWith('.html')) rewriteFile(p);
  }
};
walkHtml(out);

// The setup guide ships with the tools site too — repoint its Mail-overview
// back-links at the tools hub (no /mail/ route exists here). Runs after the
// baseUrl rebase, so match the rebased form.
const setupPath = join(out, 'mail-setup', 'index.html');
let setup = readFileSync(setupPath, 'utf8');
setup = setup.split(`<a href="${bp}/mail/">Mail overview</a>`).join(`<a href="${bp}/">Tools hub</a>`);
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
