/* Покерный таймер — service worker.
   Precaches the whole (tiny) app so it launches offline once installed —
   important for a timer used at a table where wifi may drop. */
const CACHE = 'pk-timer-v6';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './vendor/supabase.js',
  './manifest.json',
  './icon.svg',
  './fonts/cinzel-latin.woff2',
  './fonts/cinzel-latinext.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // don't touch Supabase/CDN

  // config.js is user-edited (Supabase keys) — ALWAYS try the network first so
  // key changes take effect immediately; fall back to cache only when offline.
  if (url.pathname.endsWith('/config.js')) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // everything else: cache-first (versioned assets), network fallback
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
