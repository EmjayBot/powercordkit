// Shared site shell for this deployment (Tools + Mail).
// Reads /site.config.json and renders the header + "Powered by" footer on every
// page, so branding/links/accent are customizable without editing pages.
// Usage in a page: <div id="pck-nav"></div> ... <div id="pck-foot"></div>
// and <script src="/assets/site.js"></script>.
(function () {
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  var CSS =
    '.pck-top{min-height:54px;border-bottom:1px solid var(--pck-bd,#26262b);display:flex;align-items:center;gap:14px;padding:8px 16px;background:var(--pck-p,#17171a);position:sticky;top:0;z-index:50;flex-wrap:wrap}' +
    '.pck-top .pck-brand{color:var(--pck-t,#f0f0f2);text-decoration:none;font-weight:700;font-size:15px;display:flex;align-items:center;gap:10px}' +
    '.pck-top .pck-brand img{width:28px;height:28px;border-radius:7px}' +
    '.pck-top .pck-links{display:flex;gap:4px;flex-wrap:wrap}' +
    '.pck-top .pck-links a{color:#8a8a90;text-decoration:none;font-size:13px;padding:6px 11px;border-radius:8px}' +
    '.pck-top .pck-links a:hover{background:#1e1e22;color:#f0f0f2}' +
    '.pck-top .pck-right{margin-left:auto;display:flex;gap:8px;align-items:center}' +
    '.pck-top .pck-right .pill{font-size:11px;font-weight:700;background:#1e1e22;border:1px solid var(--pck-bd,#26262b);border-radius:999px;padding:5px 11px;color:#8a8a90}' +
    '.pck-foot{border-top:1px solid var(--pck-bd,#26262b);margin-top:48px;padding:22px 16px;color:#8a8a90;font-size:12px;text-align:center}' +
    '.pck-foot a{color:#8a8a90;text-decoration:none}.pck-foot a:hover{color:#f0f0f2}';
  function injectCss() {
    if (document.getElementById('pck-shell-css')) return;
    var s = document.createElement('style');
    s.id = 'pck-shell-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  function render(cfg) {
    injectCss();
    var h = cfg.header || {};
    var brand = h.brand || cfg.siteName || 'Community';
    var logo = h.logo || '/assets/powercordkit_logo.png';
    var home = h.home || '/';
    var links = Array.isArray(h.links) ? h.links : [];
    var nav = document.getElementById('pck-nav');
    if (nav) {
      nav.className = 'pck-top';
      nav.innerHTML =
        '<a class="pck-brand" href="' + esc(home) + '"><img src="' + esc(logo) + '" alt="" />' + esc(brand) + '</a>' +
        '<div class="pck-links">' +
        links.map(function (l) { return '<a href="' + esc(l.href) + '">' + esc(l.label) + '</a>'; }).join('') +
        '</div><div class="pck-right" id="pck-right"></div>';
    }
    var foot = document.getElementById('pck-foot');
    if (foot) {
      foot.className = 'pck-foot';
      foot.innerHTML = esc(cfg.footerNote || 'Powered by PowerCordKit');
    }
    if (typeof window.PCK_ON_NAV === 'function') {
      try { window.PCK_ON_NAV(); } catch (e) { /* page hook error */ }
    }
  }
  function right(html) {
    var r = document.getElementById('pck-right');
    if (r) r.innerHTML = html;
  }
  window.PCK = { config: {}, right: right };
  fetch('/site.config.json', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .catch(function () { return {}; })
    .then(function (cfg) {
      cfg = cfg || {};
      if (cfg.accent) {
        document.documentElement.style.setProperty('--pck-b', cfg.accent);
        document.documentElement.style.setProperty('--b', cfg.accent);
      }
      window.PCK.config = cfg;
      render(cfg);
    });
})();
