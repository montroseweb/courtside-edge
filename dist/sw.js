/* Courtside Edge service worker: instant launch from cache, network-first for the page so updates
   land immediately; live data (ESPN / NBA / Kalshi / GitHub feed) always goes to the network. */
const V = 'ce-5ac6b93be9';
const SHELL = ['./index.html', './manifest.json', './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png'];
const shellPaths = () => SHELL.map((p) => new URL(p, self.registration.scope).pathname);
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).catch(() => { })); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('ce-') && k !== V && k !== 'ce-fonts').map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  if (url.origin === scope.origin && (req.mode === 'navigate' || url.pathname === new URL('./index.html', scope).pathname || url.pathname === scope.pathname)) {
    e.respondWith((async () => {
      const c = await caches.open(V);
      try {
        const r = await Promise.race([fetch(req, { cache: 'no-cache' }), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3500))]);
        if (r && r.ok) c.put('./index.html', r.clone());
        return r;
      } catch { return (await c.match('./index.html')) || fetch(req); }
    })());
    return;
  }
  if (url.origin === scope.origin && shellPaths().includes(url.pathname)) { e.respondWith(caches.match(req).then((m) => m || fetch(req))); return; }
  if (/(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    e.respondWith(caches.open('ce-fonts').then(async (c) => { const m = await c.match(req); const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => m); return m || net; }));
  }
});
