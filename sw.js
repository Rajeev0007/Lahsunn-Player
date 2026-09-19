/* ============================================================
   Loru Player — service worker
   Makes repeat visits load instantly and keeps the interface
   usable when the network is flaky.

   Strategy:
     navigation   → network first, cache fallback (never strands
                    the user on a stale build for long)
     own assets   → stale-while-revalidate (instant, self-updating)
     cross-origin → not intercepted at all, so YouTube, Spotify and
                    Audius traffic is never cached or delayed
   ============================================================ */

const VERSION = 'loru-v2';

/* Code must never be served stale: a cache-first CSS file paired with freshly
   downloaded JS produces a half-broken UI (invisible panes, wrong layout).
   HTML, CSS and JS therefore go network-first and only fall back to cache when
   offline. Images and fonts stay cache-first, where staleness is harmless. */
const CODE = /\.(html|css|js|webmanifest)$/i;
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'assets/css/theme.css',
  'assets/css/layout.css',
  'assets/css/components.css',
  'assets/js/utils.js',
  'assets/js/store.js',
  'assets/js/catalog.js',
  'assets/js/services/audius.js',
  'assets/js/services/youtube.js',
  'assets/js/services/spotify.js',
  'assets/js/services/importer.js',
  'assets/js/engine.js',
  'assets/js/visualizer.js',
  'assets/js/ui/components.js',
  'assets/js/ui/views.js',
  'assets/js/ui/player.js',
  'assets/js/app.js',
  'assets/img/logo-icon.svg',
  'assets/img/logo-mark.svg',
  'assets/img/logo-full.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // addAll rejects if any single request fails, which would abandon the
      // whole install; cache entries individually instead.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // leave third parties alone

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('index.html'))),
    );
    return;
  }

  const store = (response) => {
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    return response;
  };

  if (CODE.test(url.pathname)) {
    event.respondWith(
      fetch(request).then(store).catch(() => caches.match(request)),
    );
    return;
  }

  // Images, icons, fonts: cache-first with a background refresh
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then(store).catch(() => cached);
      return cached || network;
    }),
  );
});
