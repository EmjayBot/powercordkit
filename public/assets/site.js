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
    '.pck-top .pck-auth{display:flex;gap:8px;align-items:center}' +
    '.pck-top .pck-signout{background:#1e1e22;border:1px solid var(--pck-bd,#26262b);color:#c9c9cf;border-radius:8px;padding:6px 11px;font-size:12px;font-weight:600;cursor:pointer;text-decoration:none;font-family:inherit}' +
    '.pck-top .pck-signout:hover{border-color:var(--pck-b,#5865F2);color:#fff}' +
    '.pck-top .pck-login{background:var(--pck-b,#5865F2);color:#fff;border:0;border-radius:8px;padding:7px 15px;font-size:12px;font-weight:700;cursor:pointer;text-decoration:none;font-family:inherit}' +
    '.pck-top .pck-login:hover{filter:brightness(1.12)}' +
    '.pck-foot{border-top:1px solid var(--pck-bd,#26262b);margin-top:48px;padding:22px 16px;color:#8a8a90;font-size:12px;text-align:center}' +
    '.pck-foot img{width:20px;height:20px;border-radius:5px;vertical-align:-5px;margin-right:7px}' +
    '.pck-foot a{color:#8a8a90;text-decoration:none}.pck-foot a:hover{color:#f0f0f2}' +
    '.pck-hero{max-width:1080px;margin:0 auto;padding:64px 20px 20px;text-align:center}' +
    '.pck-hero .kicker{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--pck-b,#5865F2);background:rgba(88,101,242,.12);border:1px solid rgba(88,101,242,.4);border-radius:999px;padding:6px 14px;margin-bottom:18px}' +
    '.pck-hero h1{margin:0;font-size:clamp(30px,5vw,50px);letter-spacing:-.03em;line-height:1.06;color:#f0f0f2}' +
    '.pck-hero p{color:#8a8a90;font-size:16px;max-width:640px;margin:16px auto 0;line-height:1.6}' +
    '.pck-hero .cta{display:flex;gap:10px;justify-content:center;margin-top:26px;flex-wrap:wrap}' +
    '.pck-hero .cta a{background:var(--pck-b,#5865F2);color:#fff;border-radius:10px;padding:12px 20px;font-size:14px;font-weight:700;text-decoration:none}' +
    '.pck-hero .cta a.ghost{background:#1e1e22;border:1px solid var(--pck-bd,#26262b);color:#f0f0f2}';
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
    var feats = cfg.features || {};
    var brand = h.brand || cfg.siteName || 'Community';
    var logo = h.logo || '/assets/powercordkit_logo.png';
    var home = h.home || '/';
    var links = (Array.isArray(h.links) ? h.links : []).filter(function (l) {
      var off = ['/mail-setup/', '/mail/', '/modtools/', '/ideas/', '/roadmap/'];
      if (feats.mailSetup === false && String(l.href).indexOf('/mail-setup/') === 0) return false;
      if (feats.inbox === false && String(l.href).indexOf('/mail/') === 0) return false;
      if (feats.modtools === false && String(l.href).indexOf('/modtools/') === 0) return false;
      if (feats.ideas === false && String(l.href).indexOf('/ideas/') === 0) return false;
      if (feats.roadmap === false && String(l.href).indexOf('/roadmap/') === 0) return false;
      if (window.__pckRoadmapPrivate && /roadmap/.test(String(l.href))) return false;
      return true;
    });
    var nav = document.getElementById('pck-nav');
    if (nav) {
      nav.className = 'pck-top';
      nav.innerHTML =
        '<a class="pck-brand" href="' + esc(home) + '"><img src="' + esc(logo) + '" alt="" />' + esc(brand) + '</a>' +
        '<div class="pck-links">' +
        links.map(function (l) { return '<a href="' + esc(l.href) + '">' + esc(l.label) + '</a>'; }).join('') +
        '</div><div class="pck-right" id="pck-right"></div><div class="pck-auth" id="pck-auth"></div>';
    }
    // Sign-out control: show when the user is logged in (Discord session) or a
    // mod key is stored in this browser. Clears both, then ends the session.
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (me) {
        var auth = document.getElementById('pck-auth');
        if (!auth) return;
        var hasKey = false;
        try { hasKey = !!sessionStorage.getItem('pck-mod-key'); } catch (e) { /* ignore */ }
        var authed = !!(me && me.authenticated);
        if (authed || hasKey) {
          var nm = me && me.user && me.user.name ? esc(me.user.name) + ' · ' : '';
          auth.innerHTML = '<a class="pck-signout" href="/api/auth/logout"><span style="opacity:.7">' + nm + '</span>Log out</a>';
          auth.firstChild.addEventListener('click', function () {
            try { sessionStorage.removeItem('pck-mod-key'); } catch (e) { /* ignore */ }
          });
        } else if (me) {
          // Backend page with no session — make login one tap away.
          auth.innerHTML = '<a class="pck-login" href="/api/auth/login">Log in</a>';
        }
      });
    var foot = document.getElementById('pck-foot');
    if (foot) {
      foot.className = 'pck-foot';
      var credit = cfg.creditUrl || home;
      var gh = cfg.githubUrl ? ' · <a href="' + esc(cfg.githubUrl) + '" target="_blank" rel="noopener">GitHub</a>' : '';
      foot.innerHTML = '<a href="' + esc(credit) + '" target="_blank" rel="noopener"><img src="' + esc(logo) + '" alt="" />' + esc(cfg.footerNote || 'Powered by PowerCordKit') + '</a>' + gh;
    }
    Object.keys(feats).forEach(function (k) {
      if (feats[k] === false) {
        var els = document.querySelectorAll('[data-pck-feature="' + k + '"]');
        for (var i = 0; i < els.length; i++) els[i].style.display = 'none';
      }
    });
    // Environment-gated sections: only shown on the matching deployment (e.g. personal).
    if (window.__pckEnv) {
      var envs = document.querySelectorAll('[data-pck-env]');
      for (var i = 0; i < envs.length; i++) {
        if (envs[i].getAttribute('data-pck-env') !== window.__pckEnv) envs[i].style.display = 'none';
      }
    }
    // Optional marketing hero — only rendered when the active environment
    // provides one (e.g. environments.personal.hero). Other deploys stay plain.
    var hero = document.getElementById('pck-hero');
    if (hero) {
      if (cfg.hero && cfg.hero.title) {
        var cta = (cfg.hero.cta || []).map(function (c) {
          return '<a class="' + (c.primary ? '' : 'ghost') + '" href="' + esc(c.href) + '">' + esc(c.label) + '</a>';
        }).join('');
        hero.className = 'pck-hero';
        hero.innerHTML =
          (cfg.hero.kicker ? '<div class="kicker">' + esc(cfg.hero.kicker) + '</div>' : '') +
          '<h1>' + esc(cfg.hero.title) + '</h1>' +
          (cfg.hero.subtitle ? '<p>' + esc(cfg.hero.subtitle) + '</p>' : '') +
          (cta ? '<div class="cta">' + cta + '</div>' : '');
      } else if (hero.parentNode) {
        hero.parentNode.removeChild(hero);
      }
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
  function merge(a, b) {
    var o = {}, k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) o[k] = a[k];
    for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) o[k] = b[k];
    return o;
  }
  function bust(url) { return url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now(); }
  fetch('/site.config.json', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .catch(function () { return {}; })
    .then(function (local) {
      local = local || {};
      // Remote override (e.g. a raw GitHub JSON) so header/links can be edited
      // live without redeploying. Falls back to the local file on any failure.
      if (!local.configUrl) return local;
      return fetch(bust(local.configUrl), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (remote) { return remote && typeof remote === 'object' ? merge(local, remote) : local; })
        .catch(function () { return local; });
    })
    .then(function (cfg) {
      cfg = cfg || {};
      // Per-deployment branding: /api/health reports the env, and any matching
      // `environments[env]` block overrides name/brand for that deployment.
      return fetch('/api/health', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (h) {
          var env = h && h.env;
          window.__pckEnv = env || null;
          window.__pckRoadmapPrivate = !!(h && h.roadmapPublic === false);
          var envCfg = env && cfg.environments && cfg.environments[env];
          if (envCfg && typeof envCfg === 'object') {
            var baseHeader = cfg.header || {};
            cfg = merge(cfg, envCfg);
            cfg.header = merge(baseHeader, envCfg.header || {});
          }
          if (cfg.accent) {
            document.documentElement.style.setProperty('--pck-b', cfg.accent);
            document.documentElement.style.setProperty('--b', cfg.accent);
          }
          window.PCK.config = cfg;
          if (document.body && document.body.hasAttribute('data-pck-title')) {
            document.title = cfg.siteName || (cfg.header && cfg.header.brand) || document.title;
          }
          render(cfg);
        });
    });
})();
