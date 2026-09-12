/* Lahsunn Player service worker.
 *
 * Purpose: make the app installable (a standalone PWA keeps audio alive far more
 * reliably on mobile than a browser tab) and let the shell load offline.
 *
 * It deliberately never touches /api/ — search results, playlists and especially
 * the audio stream (which relies on HTTP range requests) must always go to the
 * network. Caching a partial 206 response would corrupt playback.
 */
const VERSION = "lahsunn-v2";
const SHELL = ["/", "/index.html", "/icon.svg", "/logo.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never intercept the API or audio: streaming and range requests must pass through.
  if (url.pathname.startsWith("/api/")) return;
  if (req.headers.has("range")) return;

  // Navigations: network first so a deploy is picked up, cache as offline fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          caches.open(VERSION).then((c) => c.put("/index.html", res.clone())).catch(() => {});
          return res;
        })
        .catch(() => caches.match("/index.html").then((r) => r || Response.error()))
    );
    return;
  }

  // Static assets are content-hashed by Vite, so cache-first is safe.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.status === 200) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
    )
  );
});
