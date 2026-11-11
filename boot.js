/* Applies theme / accent / background / motion before first paint (no inline scripts → strict CSP). */
(function () {
  var d = document.documentElement;
  try {
    var get = function (k) { return localStorage.getItem('mg.' + k); };
    var pref = get('theme') || 'system';
    var eff = pref === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : pref;
    d.setAttribute('data-theme', eff);
    d.setAttribute('data-theme-pref', pref);
    var acc = get('accent');
    if (acc) {
      var a = JSON.parse(acc);
      if (a && a.length === 3) { d.style.setProperty('--a1', a[0]); d.style.setProperty('--a2', a[1]); d.style.setProperty('--a3', a[2]); }
    }
    d.setAttribute('data-bg', get('bg') || 'aurora');
    var m = get('motion');
    if (m === 'reduce' || (!m && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) d.setAttribute('data-motion', 'reduce');
    var lang = get('lang');
    if (lang && document.cookie.indexOf('mg_lang=') === -1) {
      document.cookie = 'mg_lang=' + lang + ';path=/;max-age=31536000;samesite=lax';
    }
    var colors = { light: '#f7f6fc', dark: '#0b0a14', amoled: '#000000', gray: '#1c1c1f' };
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', colors[eff] || '#0b0a14');
  } catch (e) { /* storage blocked */ }
})();
