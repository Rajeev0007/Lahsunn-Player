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

/* Bump on any change to SHELL so stale caches are discarded. */
const VERSION = 'loru-v11';

/* Code must never be served stale: a cache-first CSS file paired with freshly
   downloaded JS produces a half-broken UI (invisible panes, wrong layout).
   HTML, CSS and JS therefore go network-first and only fall back to cache when
   offline. Images and fonts stay cache-first, where staleness is harmless. */
const CODE = /\.(html|css|js|webmanifest)$/i;
/* Mirrors the load order in index.html — keep the two in step when adding a
   file, or the new one simply won't be available offline. */
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',

  'src/styles/theme.css',
  'src/styles/layout.css',
  'src/styles/components.css',
  'src/styles/forms.css',
  'src/styles/overlays.css',

  'src/core/utils.js',
  'src/core/store.js',

  'src/content/catalog.js',

  'src/services/audius.js',
  'src/services/youtube.js',
  'src/services/spotify.js',
  'src/services/soundcloud.js',
  'src/services/itunes.js',
  'src/services/lyrics.js',
  'src/services/discord.js',
  'src/services/importer.js',

  'src/content/data.js',

  'src/playback/engine.js',
  'src/playback/visualizer.js',

  'src/ui/components.js',
  'src/ui/views/shared.js',
  'src/ui/views/home.js',
  'src/ui/views/search.js',
  'src/ui/views/library.js',
  'src/ui/views/manage.js',
  'src/ui/router.js',
  'src/ui/player.js',

  'src/app.js',

  // The logo was listed three times here; the icons the manifest actually
  // declares were not listed at all.
  'assets/img/logo.svg',
  'assets/img/icon-192.png',
  'assets/img/icon-512.png',
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
