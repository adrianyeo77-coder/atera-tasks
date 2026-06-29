/* Service worker — offline app shell for Atera Tasks.
   NETWORK-FIRST: when online it always fetches the latest files (so updates show
   on a single reload — no cache-bump dance), and it falls back to the cache only
   when offline. Supabase API/auth/storage calls are never cached. */
const CACHE = 'atera-tasks-v7';
const SHELL = [
  './', './index.html', './app.js', './config.js', './styles.css',
  './manifest.json', './icon.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                          // never touch writes
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co')) return;          // never cache API / auth / storage
  const isShell = url.origin === location.origin
    || url.href.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js');
  if (!isShell) return;
  // Network-first: fetch fresh when online (and refresh the cache for offline use);
  // fall back to the cache only when the network fails, then to the cached index
  // for navigations so the app still opens offline.
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});
