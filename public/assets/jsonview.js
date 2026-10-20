// Shared JSON pretty-view for tool exports: syntax-highlighted preview plus
// a raw copy. Usage: PCKJSON.setPretty(el, jsonText). Copy buttons keep
// reading el.textContent (spans add no text, so it stays byte-identical).
(function () {
  var css =
    '.pj-jk{color:#8b96f8}.pj-js{color:#9ece8a}.pj-jn{color:#f2b26b}.pj-jb{color:#57c8f2}.pj-jnul{color:#8a8a90;font-style:italic}';
  function injectCss() {
    if (document.getElementById('pck-json-css')) return;
    var s = document.createElement('style');
    s.id = 'pck-json-css';
    s.textContent = css;
    document.head.appendChild(s);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectCss);
  else injectCss();
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  // Tokenize the RAW text (real quote chars bound the match), then escape
  // each token. (Matching against HTML-escaped text breaks: &quot; contains
  // no literal quote, so [^\\"] spans whole lines.)
  function highlight(jsonText) {
    var src = String(jsonText == null ? '' : jsonText);
    return src.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, function (m) {
      var cls = 'jn';
      if (/^"/.test(m)) cls = /:$/.test(m) ? 'jk' : 'js';
      else if (/true|false/.test(m)) cls = 'jb';
      else if (/null/.test(m)) cls = 'jnul';
      return '<span class="pj-' + cls + '">' + esc(m) + '</span>';
    });
  }
  window.PCKJSON = {
    highlight: highlight,
    setPretty: function (el, jsonText) {
      if (!el) return;
      el.innerHTML = highlight(jsonText);
    }
  };
})();
