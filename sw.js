/* Service worker — offline app shell for Atera Tasks.
   Caches the static files so the app opens with NO network. Supabase API/auth/
   storage calls are never cached (always go to the network).

   ⚠️ BUMP `CACHE` (v1 -> v2 -> ...) on EVERY deploy, or browsers keep the old
   shell from cache and your changes won't show. The activate handler deletes
   old caches, so bumping the version string is the whole update. */
const CACHE = 'atera-tasks-v2';
const SHELL = [
  './', './index.html', './app.js', './config.js', './styles.css',
  './manifest.json', './icon.svg',
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
  // Cache-first for the shell; fall back to network (and runtime-cache it), then
  // to the cached index for navigations so the app still opens offline.
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});
