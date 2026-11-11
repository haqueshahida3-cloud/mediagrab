/* MediaGrab service worker — offline app shell, stale-while-revalidate assets. API calls always hit the network. */
const V = '__VERSION__';
const CACHE = `mg-${V}`;
const SHELL = ['/', '/tools', '/offline', `/static/css/style.css?v=${V}`, `/static/js/boot.js?v=${V}`, `/static/js/app.js?v=${V}`,
  `/static/js/page.js?v=${V}`, `/static/js/tools.js?v=${V}`, '/static/js/core.js', '/static/js/i18n.js', '/static/js/i18n-v2.js',
  '/static/js/icons.js', '/static/js/zip.js', '/static/js/exif.js', '/static/fonts/inter-latin-400-800.woff2',
  '/static/icons/favicon.svg', '/static/icons/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' }))))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('mg-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) return;

  if (req.mode === 'navigate') {  // pages: network first, then the cached copy, then the offline page
    e.respondWith(fetch(req).then((res) => {
      if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(url.pathname === '/' ? '/' : req, copy));
      }
      return res;
    }).catch(async () => (await caches.match(req, { ignoreSearch: true })) || (await caches.match(url.pathname === '/' ? '/' : '/offline')) || caches.match('/offline')));
    return;
  }
  if (url.pathname.startsWith('/static/') || url.pathname === '/manifest.webmanifest') {  // stale-while-revalidate
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      const fresh = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || fresh;
    }));
  }
});
