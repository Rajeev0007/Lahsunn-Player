/**
 * Where the API lives. Empty (the default) means "same origin", which is how a
 * normal single-container deploy works.
 *
 * Set VITE_API_BASE at build time to point the UI at a backend on another host
 * — needed when the UI is on a static/serverless host (e.g. Vercel) that cannot
 * run the Node server. The backend must then allow this origin via CORS_ORIGIN.
 */
export const API_BASE = String(import.meta.env?.VITE_API_BASE || "").replace(/\/+$/, "");

const api = (path) => `${API_BASE}${path}`;

export function coverUrl(url) {
  if (!url) return "";
  return api(`/api/cover?u=${encodeURIComponent(url)}`);
}

export function streamUrl(track) {
  const p = new URLSearchParams();
  p.set("id", track.id);
  p.set("src", track.source || "spotify");
  if (track.title) p.set("title", track.title);
  if (track.author) p.set("author", track.author);
  if (track.duration) p.set("duration", String(Math.round(track.duration / 1000)));
  if (track.isrc) p.set("isrc", track.isrc);
  if (track.encoded) p.set("encoded", track.encoded);
  return api(`/api/stream?${p.toString()}`);
}

export async function apiGet(path) {
  const res = await fetch(api(path));
  if (!res.ok) {
    const err = new Error("request_failed");
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const searchCatalog = (q) => apiGet(`/api/search?q=${encodeURIComponent(q)}`);
export const browseHome = () => apiGet("/api/browse");
/** Node reachability + which sources are usable, so a blank page can explain itself. */
export const loadStatus = (refresh = false) => apiGet(`/api/status${refresh ? "?refresh=1" : ""}`);

/**
 * Import a playlist from a Spotify/YouTube/Apple/Deezer link, a Last.fm profile
 * URL, or `lastfm:<user>[/loved|top|recent]`. Always resolves (never throws on a
 * failed import) — check `ok`.
 */
export const importPlaylist = (value) => apiGet(`/api/import?q=${encodeURIComponent(value)}`);
export const loadCollection = (url) => apiGet(`/api/collection?url=${encodeURIComponent(url)}`);
export const loadGenres = () => apiGet("/api/genres");
export const loadGenre = (id) => apiGet(`/api/genre?id=${encodeURIComponent(id)}`);
export const loadGenreMeta = (id) => apiGet(`/api/genre-meta?id=${encodeURIComponent(id)}`);

export async function fetchLyrics(track) {
  const p = new URLSearchParams({
    title: track.title || "",
    artist: track.author || "",
  });
  if (track.album) p.set("album", track.album);
  if (track.duration) p.set("duration", String(Math.round(track.duration / 1000)));
  const res = await fetch(api(`/api/lyrics?${p}`));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("lyrics");
  return res.json();
}

export function prefetch(track) {
  if (!track) return;
  fetch(api("/api/prefetch"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: track.id,
      src: track.source,
      title: track.title,
      author: track.author,
      duration: track.duration,
      isrc: track.isrc,
      encoded: track.encoded,
    }),
  }).catch(() => {});
}

export function formatTime(msOrSec, isMs = false) {
  let sec = isMs ? Math.floor(msOrSec / 1000) : Math.floor(msOrSec);
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function parseLrc(text) {
  if (!text) return [];
  const lines = [];
  for (const raw of text.split("\n")) {
    const matches = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!matches.length) continue;
    const content = raw.replace(/\[\d+:\d+(?:\.\d+)?\]/g, "").trim();
    for (const m of matches) {
      lines.push({ t: Number(m[1]) * 60 + Number(m[2]), text: content });
    }
  }
  lines.sort((a, b) => a.t - b.t);
  return lines;
}

export function trackKey(t) {
  return `${t.source || ""}:${t.id}`;
}
