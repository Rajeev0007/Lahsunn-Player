import http from "http";
import https from "https";
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Readable } from "stream";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const WWW = path.join(ROOT, "client", "www");

/* ------------------------------------------------------------------ *
 * env
 * ------------------------------------------------------------------ */

function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const i = text.indexOf("=");
    if (i < 1) continue;
    const key = text.slice(0, i).trim();
    let val = text.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") process.env[key] = val;
  }
}
loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const LL_AUTH = (process.env.LAVALINK_AUTH || process.env.LAVALINK_PASSWORD || "").trim();
const LRCLIB = "https://lrclib.net";
const CLIENT_UA = "LahsunnPlayer/2.0 (+by Rajeev)";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());

/**
 * Build a usable Lavalink REST base URL out of whatever the user put in .env.
 *
 * People paste all of these, and every one of them used to produce a broken
 * base URL like "https://https://node.example.com:2333":
 *   LAVALINK_HOST=node.example.com
 *   LAVALINK_HOST=https://node.example.com
 *   LAVALINK_HOST=wss://node.example.com:443/v4/websocket
 *   LAVALINK_URL=https://node.example.com:443
 */
function resolveNodeBase() {
  const raw = (process.env.LAVALINK_URL || process.env.LAVALINK_HOST || "").trim();
  if (!raw) return null;

  let text = raw;
  let scheme = null;

  const schemeMatch = /^(https?|wss?):\/\//i.exec(text);
  if (schemeMatch) {
    const s = schemeMatch[1].toLowerCase();
    scheme = s === "wss" ? "https" : s === "ws" ? "http" : s;
    text = text.slice(schemeMatch[0].length);
  }

  // Drop credentials and any path/query the user pasted along.
  const at = text.lastIndexOf("@");
  if (at >= 0) text = text.slice(at + 1);
  text = text.split(/[/?#]/)[0];

  let host = text;
  let port = null;

  if (host.startsWith("[")) {
    // IPv6 literal, e.g. [::1]:2333
    const close = host.indexOf("]");
    if (close > 0) {
      const tail = host.slice(close + 1);
      if (tail.startsWith(":") && /^\d+$/.test(tail.slice(1))) port = Number(tail.slice(1));
      host = host.slice(0, close + 1);
    }
  } else {
    const i = host.lastIndexOf(":");
    if (i > 0 && /^\d+$/.test(host.slice(i + 1))) {
      port = Number(host.slice(i + 1));
      host = host.slice(0, i);
    }
  }

  if (!host) return null;

  const portEnv = String(process.env.LAVALINK_PORT ?? "").trim();
  if (!port && portEnv && /^\d+$/.test(portEnv)) port = Number(portEnv);
  if (!scheme) scheme = truthy(process.env.LAVALINK_SECURE) || port === 443 ? "https" : "http";
  if (!port) port = scheme === "https" ? 443 : 2333;

  const isDefaultPort = (scheme === "https" && port === 443) || (scheme === "http" && port === 80);
  return { scheme, host, port, url: `${scheme}://${host}${isDefaultPort ? "" : `:${port}`}` };
}

/**
 * A misconfigured scheme/port pair is the single most common reason a node looks
 * "dead". Rather than failing forever we probe a few sane variants of what the
 * user gave us and keep the first one that actually answers /v4/info.
 */
function candidateBases() {
  const cfg = resolveNodeBase();
  if (!cfg) return [];
  const { scheme, host, port } = cfg;
  const mk = (s, p) => {
    const def = (s === "https" && p === 443) || (s === "http" && p === 80);
    return `${s}://${host}${def ? "" : `:${p}`}`;
  };
  const list = [cfg.url];
  if (scheme === "https" && port !== 443) list.push(mk("https", 443));
  if (scheme === "http" && port !== 443) list.push(mk("https", 443));
  if (scheme === "https") list.push(mk("http", port === 443 ? 2333 : port));
  if (port !== 2333) list.push(mk("http", 2333));
  return [...new Set(list)].slice(0, 4);
}

const CONFIGURED = resolveNodeBase();
let LL_BASE = CONFIGURED?.url || "";

/* ------------------------------------------------------------------ *
 * caches
 * ------------------------------------------------------------------ */

const trackCache = new Map();
const ytResolveCache = new Map();
const browseCache = { data: null, at: 0 };
const lyricsCache = new Map();
const genreProbeCache = new Map();
const directUrlCache = new Map();

const GENRES = [
  { id: "music", name: "Music", color: "#8b5cf6", query: "Today's Top Hits" },
  { id: "live", name: "Live Events", color: "#7c2bff", query: "live concert hits" },
  { id: "foryou", name: "Made For You", color: "#6d28d9", query: "pop mix hits" },
  { id: "new", name: "New Releases", color: "#a855f7", query: "new music friday" },
  { id: "desi", name: "Desi", color: "#c026d3", query: "desi hits" },
  { id: "pop", name: "Pop", color: "#9333ea", query: "pop hits" },
  { id: "hiphop", name: "Hip-Hop", color: "#5b21b6", query: "hip hop rap caviar" },
  { id: "punjabi", name: "Punjabi", color: "#d946ef", query: "punjabi hits" },
  { id: "charts", name: "Charts", color: "#9b6bb0", query: "top songs global" },
  { id: "educational", name: "Educational", color: "#7e22ce", query: "study music focus" },
  { id: "documentary", name: "Documentary", color: "#4c1d95", query: "documentary soundtrack" },
  { id: "comedy", name: "Comedy", color: "#a21caf", query: "comedy songs" },
  { id: "rock", name: "Rock", color: "#7f1d9b", query: "rock hits" },
  { id: "rnb", name: "R&B", color: "#6a1b9a", query: "r&b soul hits" },
  { id: "electronic", name: "Electronic", color: "#6366f1", query: "electronic dance hits" },
  { id: "indie", name: "Indie", color: "#5c4b8a", query: "indie pop hits" },
  { id: "latin", name: "Latin", color: "#b23ab2", query: "latin hits" },
  { id: "kpop", name: "K-Pop", color: "#e879f9", query: "k-pop hits" },
  { id: "country", name: "Country", color: "#8d6e9b", query: "country hits" },
  { id: "metal", name: "Metal", color: "#3b0764", query: "metal hits" },
  { id: "jazz", name: "Jazz", color: "#553c7b", query: "jazz classics" },
  { id: "classical", name: "Classical", color: "#4a3760", query: "classical music" },
  { id: "bollywood", name: "Bollywood", color: "#c837ab", query: "bollywood hits" },
  { id: "pakistan", name: "Pakistani", color: "#7b3fa0", query: "pakistani hits" },
  { id: "chill", name: "Chill", color: "#8b7fd4", query: "chill hits lo-fi" },
  { id: "workout", name: "Workout", color: "#a020f0", query: "workout hits" },
  { id: "romance", name: "Romance", color: "#ad1497", query: "love songs" },
  { id: "party", name: "Party", color: "#bf3fd9", query: "party hits" },
  { id: "folk", name: "Folk", color: "#6d4c8b", query: "folk acoustic" },
  { id: "reggae", name: "Reggae", color: "#5e35b1", query: "reggae hits" },
];

const COVER_HOSTS = [
  "i.scdn.co",
  "scdn.co",
  "mosaic.scdn.co",
  "spotifycdn.com",
  "i.ytimg.com",
  "ytimg.com",
  "yt3.googleusercontent.com",
  "lh3.googleusercontent.com",
  "images.genius.com",
  "dzcdn.net",
  "sndcdn.com",
  "mzstatic.com",
  "cdns-images.dzcdn.net",
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/* ------------------------------------------------------------------ *
 * http helpers
 * ------------------------------------------------------------------ */

function send(res, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Type":
      typeof body === "object" && !Buffer.isBuffer(body) ? "application/json" : "text/plain",
    ...headers,
  });
  res.end(data);
}

function json(res, status, obj) {
  send(res, status, obj, { "Content-Type": "application/json; charset=utf-8" });
}

function parseUrl(req) {
  return new URL(req.url, `http://${req.headers.host || "localhost"}`);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function mapPool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/* ------------------------------------------------------------------ *
 * Lavalink client
 * ------------------------------------------------------------------ */

function llHeaders() {
  return { Authorization: LL_AUTH, "User-Agent": CLIENT_UA, Accept: "application/json" };
}

class LavalinkError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = "LavalinkError";
    Object.assign(this, meta);
  }
}

/**
 * Talk to the node and, crucially, say *why* it failed. The old version threw a
 * bare "catalog_error" for everything, which is why a bad password and an
 * unreachable host both looked like "no songs".
 */
async function llGet(pathname, params, { base = LL_BASE, timeout = 20000 } = {}) {
  if (!base) throw new LavalinkError("Lavalink is not configured (set LAVALINK_HOST)", { code: "no_config" });
  if (!LL_AUTH) throw new LavalinkError("Lavalink password is missing (set LAVALINK_AUTH)", { code: "no_auth" });

  const url = new URL(pathname, base);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res;
  try {
    res = await fetch(url, { headers: llHeaders(), signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    const reason = e?.name === "TimeoutError" ? "timed out" : e?.cause?.code || e?.message || "network error";
    throw new LavalinkError(`cannot reach node at ${base} (${reason})`, { code: "unreachable" });
  }

  if (res.status === 401 || res.status === 403) {
    throw new LavalinkError("node rejected the password (check LAVALINK_AUTH)", { code: "unauthorized" });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new LavalinkError(`node returned HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`, {
      code: `http_${res.status}`,
    });
  }

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new LavalinkError(`node returned a non-JSON body (is ${base} really Lavalink?)`, {
      code: "bad_body",
    });
  }
}

/* --- node capabilities ------------------------------------------------ */

const SEARCH_SOURCES = [
  { prefix: "spsearch", source: "spotify", label: "Spotify" },
  { prefix: "ytmsearch", source: "youtube", label: "YouTube Music" },
  { prefix: "dzsearch", source: "deezer", label: "Deezer" },
  { prefix: "amsearch", source: "applemusic", label: "Apple Music" },
  { prefix: "ytsearch", source: "youtube", label: "YouTube" },
  { prefix: "scsearch", source: "soundcloud", label: "SoundCloud" },
];

let nodeInfo = null;
let nodeInfoAt = 0;
let nodeInfoPending = null;

async function probeNode() {
  const bases = candidateBases();
  if (!bases.length) {
    return {
      ok: false,
      base: "",
      configured: "",
      error: "Lavalink is not configured. Copy .env.example to .env and set LAVALINK_HOST / LAVALINK_AUTH.",
      code: "no_config",
      sources: [],
      plugins: [],
      version: "",
      searches: [],
    };
  }

  const errors = [];
  for (const base of bases) {
    try {
      const data = await llGet("/v4/info", null, { base, timeout: 8000 });
      if (base !== LL_BASE) {
        console.log(`[LAVALINK] configured ${LL_BASE} did not answer; using ${base} instead`);
        LL_BASE = base;
      }
      const sources = Array.isArray(data.sourceManagers) ? data.sourceManagers : [];
      const plugins = (Array.isArray(data.plugins) ? data.plugins : []).map((p) => p?.name).filter(Boolean);
      return {
        ok: true,
        base,
        configured: CONFIGURED?.url || "",
        error: null,
        code: null,
        sources,
        plugins,
        version: data.version?.semver || data.version || "",
        searches: availableSearches({ ok: true, sources }).map((s) => s.prefix),
        lavaSearch: plugins.some((n) => /lavasearch/i.test(n)),
      };
    } catch (e) {
      errors.push(`${base} → ${e.message}`);
    }
  }
  return {
    ok: false,
    base: LL_BASE,
    configured: CONFIGURED?.url || "",
    error: errors[0],
    attempts: errors,
    code: "unreachable",
    sources: [],
    plugins: [],
    version: "",
    searches: SEARCH_SOURCES.map((s) => s.prefix),
  };
}

async function getNodeInfo(force = false) {
  const fresh = nodeInfo && Date.now() - nodeInfoAt < (nodeInfo.ok ? 5 * 60 * 1000 : 20 * 1000);
  if (!force && fresh) return nodeInfo;
  if (nodeInfoPending) return nodeInfoPending;
  nodeInfoPending = probeNode()
    .then((info) => {
      nodeInfo = info;
      nodeInfoAt = Date.now();
      return info;
    })
    .finally(() => {
      nodeInfoPending = null;
    });
  return nodeInfoPending;
}

/**
 * Only ask the node for search prefixes it can actually serve. The old code
 * always used `spsearch:` + the LavaSearch plugin, so any node without LavaSrc
 * and Spotify credentials returned nothing at all — an empty home page.
 */
function availableSearches(info) {
  if (!info?.ok || !info.sources?.length) return SEARCH_SOURCES;
  const have = new Set(info.sources.map((s) => String(s).toLowerCase()));
  const usable = SEARCH_SOURCES.filter((s) => have.has(s.source));
  return usable.length ? usable : SEARCH_SOURCES;
}

/* --- normalisation ---------------------------------------------------- */

function rememberTrack(track) {
  if (!track?.id) return;
  trackCache.set(`${track.source}:${track.id}`, track);
  trackCache.set(track.id, track);
  if (trackCache.size > 6000) trackCache.delete(trackCache.keys().next().value);
}

function normalizeTrack(t) {
  if (!t?.info) return null;
  const info = t.info;
  const plugin = t.pluginInfo || {};
  const id = info.identifier;
  if (!id) return null;
  const source = info.sourceName || "unknown";
  let artwork = info.artworkUrl || plugin.artworkUrl || null;
  if (!artwork && source === "youtube" && isVideoId(id)) {
    artwork = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  }
  const track = {
    id,
    encoded: t.encoded,
    title: info.title || "Unknown",
    author: info.author || "",
    duration: info.length || 0,
    artwork,
    uri: info.uri,
    source,
    isrc: info.isrc || plugin.isrc || null,
    album: plugin.albumName || "",
    albumUrl: plugin.albumUrl || "",
    artistUrl: plugin.artistUrl || "",
    artistArtwork: plugin.artistArtworkUrl || null,
  };
  rememberTrack(track);
  return track;
}

function normalizeCollection(item) {
  if (!item) return null;
  const plugin = item.pluginInfo || {};
  const info = item.info || {};
  return {
    name: info.name || plugin.author || "Unknown",
    url: plugin.url || info.url || null,
    type: plugin.type || "playlist",
    artwork: plugin.artworkUrl || info.artworkUrl || null,
    totalTracks: plugin.totalTracks ?? (item.tracks?.length || 0),
    author: plugin.author || "",
  };
}

async function loadTracks(identifier) {
  const data = await llGet("/v4/loadtracks", { identifier });
  switch (data.loadType) {
    case "search":
      return (data.data || []).map(normalizeTrack).filter(Boolean);
    case "track": {
      const t = normalizeTrack(data.data);
      return t ? [t] : [];
    }
    case "playlist":
      return (data.data?.tracks || []).map(normalizeTrack).filter(Boolean);
    case "empty":
      return [];
    case "error": {
      // Surface the node's own message instead of pretending there were 0 hits.
      const ex = data.data || {};
      throw new LavalinkError(ex.message || ex.cause || "node reported a load error", {
        code: "load_error",
        severity: ex.severity,
      });
    }
    default:
      return [];
  }
}

async function loadCollection(identifier) {
  const data = await llGet("/v4/loadtracks", { identifier });
  if (data.loadType === "error") {
    const ex = data.data || {};
    throw new LavalinkError(ex.message || "node reported a load error", { code: "load_error" });
  }
  if (data.loadType !== "playlist") {
    return {
      info: null,
      tracks: data.loadType === "track" ? [normalizeTrack(data.data)].filter(Boolean) : [],
    };
  }
  return {
    info: { name: data.data?.info?.name || "", ...normalizeCollection(data.data) },
    tracks: (data.data?.tracks || []).map(normalizeTrack).filter(Boolean),
  };
}

/** LavaSearch plugin — rich results (albums/artists/playlists). Optional. */
async function lavaSearch(query, prefix = "spsearch") {
  const data = await llGet("/v4/loadsearch", {
    query: `${prefix}:${query}`,
    types: "track,album,artist,playlist",
  });
  return {
    tracks: (data.tracks || []).map(normalizeTrack).filter(Boolean),
    albums: (data.albums || []).map(normalizeCollection).filter((a) => a?.url),
    artists: (data.artists || []).map(normalizeCollection).filter((a) => a?.url),
    playlists: (data.playlists || []).map(normalizeCollection).filter((a) => a?.url),
  };
}

/* --- the search that actually returns songs --------------------------- */

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, "")
    .replace(/\b(official|video|audio|lyrics?|hd|hq|remaster(ed)?|feat\.?|ft\.?)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();

function makeDeduper() {
  const ids = new Set();
  const soft = new Set();
  return (t) => {
    if (!t?.id) return false;
    const idKey = `${t.source}:${t.id}`;
    if (ids.has(idKey)) return false;
    const softKey = `${norm(t.title)}|${norm(t.author)}`;
    if (softKey !== "|" && soft.has(softKey)) return false;
    ids.add(idKey);
    soft.add(softKey);
    return true;
  };
}

/**
 * Query every search source the node supports, in parallel, and merge.
 * A single dead source can no longer blank out the whole page.
 */
async function searchEverywhere(query, { limit = 80 } = {}) {
  const info = await getNodeInfo();
  const prefixes = availableSearches(info);
  const out = {
    tracks: [],
    albums: [],
    artists: [],
    playlists: [],
    sources: {},
    errors: [],
    node: { ok: info.ok, base: info.base, error: info.error },
  };
  const accept = makeDeduper();
  const push = (list) => {
    for (const t of list || []) if (accept(t)) out.tracks.push(t);
  };

  const jobs = [];

  if (info.lavaSearch) {
    const rich = prefixes.find((p) => p.prefix === "spsearch") || prefixes[0];
    if (rich) {
      jobs.push({
        name: "lavasearch",
        run: () => lavaSearch(query, rich.prefix),
      });
    }
  }
  for (const p of prefixes) {
    jobs.push({ name: p.prefix, run: () => loadTracks(`${p.prefix}:${query}`) });
  }

  const settled = await Promise.allSettled(jobs.map((j) => j.run()));

  settled.forEach((r, i) => {
    const name = jobs[i].name;
    if (r.status === "rejected") {
      out.errors.push(`${name}: ${r.reason?.message || r.reason}`);
      return;
    }
    const val = r.value;
    if (Array.isArray(val)) {
      out.sources[name] = val.length;
      push(val);
    } else {
      out.sources[name] = val?.tracks?.length || 0;
      push(val?.tracks);
      for (const a of val?.albums || []) out.albums.push(a);
      for (const a of val?.artists || []) out.artists.push(a);
      for (const a of val?.playlists || []) out.playlists.push(a);
    }
  });

  out.tracks = out.tracks.slice(0, limit);
  return out;
}

/** Cheapest possible "does this query return anything" check. */
async function firstHit(query, { limit = 50 } = {}) {
  const info = await getNodeInfo();
  for (const p of availableSearches(info)) {
    try {
      const tracks = await loadTracks(`${p.prefix}:${query}`);
      if (tracks.length) return { tracks: tracks.slice(0, limit), via: p.prefix };
    } catch {
      /* try the next source */
    }
  }
  return { tracks: [], via: null };
}

/* --- genres ----------------------------------------------------------- */

async function probeGenre(g) {
  const hit = genreProbeCache.get(g.id);
  if (hit && Date.now() - hit.at < 8 * 60 * 1000) return hit.data;
  let tracks = [];
  let art = null;
  try {
    const r = await firstHit(g.query, { limit: 1 });
    tracks = r.tracks;
  } catch {
    tracks = [];
  }
  if (tracks[0]?.artwork) art = tracks[0].artwork;
  const data = { ...g, artwork: art, trackCount: tracks.length };
  genreProbeCache.set(g.id, { at: Date.now(), data });
  return data;
}

async function genresWithArt() {
  const data = await mapPool(GENRES, 8, async (g) => {
    try {
      return await probeGenre(g);
    } catch {
      return null;
    }
  });
  return data.filter((g) => g && g.trackCount > 0);
}

/* ------------------------------------------------------------------ *
 * audio: resolve a YouTube video, then stream it
 * ------------------------------------------------------------------ */

function isVideoId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id);
}

const bins = {};
function hasBin(name) {
  if (bins[name] != null) return bins[name];
  try {
    const r = spawnSync(name, ["--version"], { stdio: "ignore", timeout: 10000 });
    bins[name] = !r.error && r.status === 0;
  } catch {
    bins[name] = false;
  }
  if (!bins[name]) console.warn(`[AUDIO] ${name} not found on PATH`);
  return bins[name];
}

async function resolveYoutubeCandidates(track) {
  if (!track) throw new Error("no_track");
  if (track.source === "youtube" && isVideoId(track.id)) return [track.id];

  const key = `${track.source}:${track.id}`;
  if (ytResolveCache.has(key)) return ytResolveCache.get(key);

  const queries = [];
  if (track.isrc) queries.push(`ytmsearch:"${track.isrc}"`);
  if (track.title) {
    queries.push(`ytmsearch:${track.title} ${track.author}`);
    queries.push(`ytsearch:${track.title} ${track.author} audio`);
    queries.push(`ytsearch:${track.title} ${track.author} official`);
  }

  const ranked = [];
  for (const q of queries) {
    let results = [];
    try {
      results = await loadTracks(q);
    } catch {
      continue;
    }
    for (const r of results.slice(0, 8)) {
      if (!isVideoId(r.id)) continue;
      const delta = Math.abs((r.duration || 0) - (track.duration || 0));
      const a = String(r.title).toLowerCase();
      const b = String(track.title).toLowerCase();
      const titleHit = a.includes(b.slice(0, 18)) || b.includes(a.slice(0, 18));
      ranked.push({ id: r.id, score: delta + (titleHit ? 0 : 25000) });
    }
    // A confident early match means we can stop querying.
    if (ranked.some((r) => r.score < 4000)) break;
  }

  ranked.sort((a, b) => a.score - b.score);
  const ids = [];
  for (const r of ranked) if (!ids.includes(r.id)) ids.push(r.id);
  if (!ids.length) throw new Error("could not match this track to a playable source");
  const top = ids.slice(0, 6);
  ytResolveCache.set(key, top);
  if (ytResolveCache.size > 3000) ytResolveCache.delete(ytResolveCache.keys().next().value);
  return top;
}

/**
 * Lavalink's REST API has no route that hands back raw audio — it streams to
 * Discord over UDP, not HTTP (https://lavalink.dev/api/rest). The previous code
 * called `/youtube/stream/<id>`, which only exists on nodes running a custom
 * plugin, so playback 404'd on every stock node.
 *
 * yt-dlp (already listed as a requirement in the README) is now the primary
 * resolver; the plugin route is kept as an opportunistic fast path.
 */
const STREAM_MODE = (process.env.STREAM_MODE || "auto").toLowerCase();
const PLUGIN_ROUTE = process.env.LAVALINK_STREAM_ROUTE || "/youtube/stream/{id}";
let pluginRouteUsable = STREAM_MODE !== "ytdlp";

function ytdlpArgs(videoId) {
  const extra = (process.env.YTDLP_ARGS || "").trim();
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--quiet",
    "-f",
    process.env.YTDLP_FORMAT || "bestaudio[ext=m4a]/bestaudio/best",
    "-g",
  ];
  if (process.env.YTDLP_COOKIES) args.push("--cookies", process.env.YTDLP_COOKIES);
  if (process.env.YTDLP_PROXY) args.push("--proxy", process.env.YTDLP_PROXY);
  if (extra) args.push(...extra.split(/\s+/));
  args.push(`https://www.youtube.com/watch?v=${videoId}`);
  return args;
}

function runYtdlp(videoId) {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", ytdlpArgs(videoId));
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("yt-dlp timed out"));
    }, 45000);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`yt-dlp failed to start: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const url = out.split("\n").map((l) => l.trim()).find((l) => /^https?:\/\//.test(l));
      if (code === 0 && url) return resolve(url);
      reject(new Error(err.trim().split("\n").pop() || `yt-dlp exited ${code}`));
    });
  });
}

async function directAudioUrl(videoId) {
  const hit = directUrlCache.get(videoId);
  if (hit && Date.now() - hit.at < 90 * 60 * 1000) return hit.url;
  if (!hasBin("yt-dlp")) throw new Error("yt-dlp is not installed on the server");
  const url = await runYtdlp(videoId);
  directUrlCache.set(videoId, { url, at: Date.now() });
  if (directUrlCache.size > 400) directUrlCache.delete(directUrlCache.keys().next().value);
  return url;
}

/** Stream straight through with Range passthrough — no buffering the whole song. */
async function proxyAudio(req, res, url) {
  const headers = { "User-Agent": BROWSER_UA, Accept: "*/*" };
  if (req.headers.range) headers.Range = req.headers.range;

  const up = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!up.ok && up.status !== 206) throw new Error(`upstream audio HTTP ${up.status}`);

  const outHeaders = {
    "Content-Type": up.headers.get("content-type") || "audio/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  const len = up.headers.get("content-length");
  const range = up.headers.get("content-range");
  if (len) outHeaders["Content-Length"] = len;
  if (range) outHeaders["Content-Range"] = range;

  res.writeHead(up.status, outHeaders);
  if (!up.body) return res.end();
  const stream = Readable.fromWeb(up.body);
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

/* --- optional plugin route (buffered, no Range upstream) -------------- */

const audioBufCache = new Map();
const audioPending = new Map();

function llGetRaw(pathname, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, LL_BASE);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, { method: "GET", headers: llHeaders(), timeout: timeoutMs }, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () =>
        resolve({
          status: r.statusCode || 0,
          mime: r.headers["content-type"] || "",
          buf: Buffer.concat(chunks),
        })
      );
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("node timed out"));
    });
    req.on("error", reject);
    req.end();
  });
}

function remuxToMp4(buf) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join("/tmp", "lp-"));
    const inn = path.join(dir, "in.bin");
    const out = path.join(dir, "out.m4a");
    const cleanup = () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    };
    try {
      fs.writeFileSync(inn, buf);
    } catch (e) {
      cleanup();
      return reject(e);
    }
    const child = spawn("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", inn, "-vn", "-c:a", "aac", "-b:a", "160k",
      "-movflags", "+faststart", out,
    ]);
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      cleanup();
      reject(new Error("remux timed out"));
    }, 45000);
    child.on("error", (e) => {
      clearTimeout(t);
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      try {
        if (code === 0 && fs.existsSync(out)) {
          const result = fs.readFileSync(out);
          cleanup();
          if (result.length > 2000) return resolve(result);
          return reject(new Error("remux produced an empty file"));
        }
      } catch (e) {
        cleanup();
        return reject(e);
      }
      cleanup();
      reject(new Error("remux failed"));
    });
  });
}

async function fetchPluginAudio(videoId) {
  if (!isVideoId(videoId)) throw new Error("bad video id");
  const variants = ["itag=140", "itag=139", "", "itag=251"];
  let lastErr = "no stream";
  for (const q of variants) {
    const route = PLUGIN_ROUTE.replace("{id}", encodeURIComponent(videoId));
    try {
      const r = await llGetRaw(`${route}${q ? `?${q}` : ""}`);
      if (r.status === 404) throw new Error("plugin route not available (404)");
      if (r.status === 200 && r.buf.length > 2000) {
        let buf = r.buf;
        let mime = r.mime.split(";")[0].trim() || (r.buf[4] === 0x66 ? "audio/mp4" : "audio/webm");
        if (hasBin("ffmpeg")) {
          try {
            buf = await remuxToMp4(r.buf);
            mime = "audio/mp4";
          } catch {
            buf = r.buf;
          }
        }
        return { buf, mime, at: Date.now() };
      }
      lastErr = `HTTP ${r.status}`;
    } catch (e) {
      if (/404/.test(e.message)) throw e;
      lastErr = e.message || "fetch failed";
    }
  }
  throw new Error(lastErr);
}

async function loadPluginAudio(videoId) {
  const hit = audioBufCache.get(videoId);
  if (hit && Date.now() - hit.at < 25 * 60 * 1000) return hit;
  if (audioPending.has(videoId)) return audioPending.get(videoId);
  const p = fetchPluginAudio(videoId)
    .then((rec) => {
      audioBufCache.set(videoId, rec);
      if (audioBufCache.size > 10) audioBufCache.delete(audioBufCache.keys().next().value);
      return rec;
    })
    .finally(() => audioPending.delete(videoId));
  audioPending.set(videoId, p);
  return p;
}

function sendAudioRange(req, res, rec) {
  const size = rec.buf.length;
  const range = req.headers.range;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", rec.mime || "audio/mp4");
  if (!range) {
    res.writeHead(200, { "Content-Length": size });
    return res.end(rec.buf);
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range));
  if (!m) {
    res.writeHead(416, { "Content-Range": `bytes */${size}` });
    return res.end();
  }
  const start = m[1] ? Number(m[1]) : 0;
  let end = m[2] ? Number(m[2]) : size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
    res.writeHead(416, { "Content-Range": `bytes */${size}` });
    return res.end();
  }
  end = Math.min(end, size - 1);
  const slice = rec.buf.subarray(start, end + 1);
  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${size}`,
    "Content-Length": slice.length,
  });
  res.end(slice);
}

/** Try every strategy for every candidate video until audio flows. */
async function streamTrack(req, res, track) {
  const ids = await resolveYoutubeCandidates(track);
  const failures = [];

  for (const id of ids) {
    if (pluginRouteUsable && STREAM_MODE !== "ytdlp") {
      try {
        const rec = await loadPluginAudio(id);
        return sendAudioRange(req, res, rec);
      } catch (e) {
        failures.push(`plugin(${id}): ${e.message}`);
        if (/404|not available/i.test(e.message)) {
          pluginRouteUsable = false;
          console.warn(`[AUDIO] ${PLUGIN_ROUTE} unavailable on this node; using yt-dlp from now on`);
        }
      }
    }
    if (STREAM_MODE !== "plugin") {
      try {
        const url = await directAudioUrl(id);
        return await proxyAudio(req, res, url);
      } catch (e) {
        failures.push(`yt-dlp(${id}): ${e.message}`);
        if (res.headersSent) return res.end();
      }
    }
  }

  throw new LavalinkError("no playable audio for this track", { code: "no_audio", failures });
}

/* ------------------------------------------------------------------ *
 * misc
 * ------------------------------------------------------------------ */

async function lookupTrack(query) {
  if (query.encoded) {
    try {
      const decoded = await llGet("/v4/decodetrack", { encodedTrack: query.encoded });
      const t = normalizeTrack(decoded);
      if (t) return t;
    } catch {
      /* fall through to the cache */
    }
  }
  const key = query.src && query.id ? `${query.src}:${query.id}` : query.id;
  if (key && trackCache.has(key)) return trackCache.get(key);
  if (query.id && trackCache.has(query.id)) return trackCache.get(query.id);
  if (query.title) {
    return {
      id: query.id,
      title: query.title,
      author: query.author || "",
      duration: Number(query.duration || 0) * 1000,
      source: query.src || "spotify",
      isrc: query.isrc || null,
      artwork: query.artwork || null,
    };
  }
  return null;
}

const NOT_BUILT = `<!doctype html><html><head><meta charset="utf-8">
<title>Lahsunn Player — build required</title>
<style>body{background:#120a1f;color:#f3e8ff;font:16px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px}
code{background:#2a1a44;color:#d8b4fe;padding:3px 8px;border-radius:6px}h1{color:#a855f7}</style>
</head><body><div><h1>Lahsunn Player</h1>
<p>The front-end has not been built yet, so there is nothing to serve from <code>client/www</code>.</p>
<p>Run this once, then reload:</p><p><code>npm install &amp;&amp; npm run build</code></p>
<p style="opacity:.6">Made by Rajeev</p></div></body></html>`;

function serveStatic(req, res) {
  const u = parseUrl(req);
  let rel = decodeURIComponent(u.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(WWW, rel));
  if (!file.startsWith(WWW)) return json(res, 403, { error: "Forbidden" });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      const index = path.join(WWW, "index.html");
      return fs.readFile(index, (e2, buf) => {
        if (e2) {
          return send(res, 503, NOT_BUILT, { "Content-Type": "text/html; charset=utf-8" });
        }
        send(res, 200, buf, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      });
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600",
    });
    fs.createReadStream(file).pipe(res);
  });
}

function pipeWeb(res, up, extra = {}) {
  const headers = { ...extra };
  const type = up.headers.get("content-type");
  const len = up.headers.get("content-length");
  if (type) headers["Content-Type"] = type;
  if (len) headers["Content-Length"] = len;
  res.writeHead(up.status, headers);
  if (!up.body) return res.end();
  const stream = Readable.fromWeb(up.body);
  stream.on("error", () => res.end());
  stream.pipe(res);
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

async function handleApi(req, res) {
  const u = parseUrl(req);
  const p = u.pathname;
  const q = Object.fromEntries(u.searchParams.entries());

  if (p === "/api/health") return json(res, 200, { ok: true, player: "lahsunn" });

  /** Everything the UI needs to explain a blank page to the user. */
  if (p === "/api/status") {
    const info = await getNodeInfo(truthy(q.refresh));
    return json(res, 200, {
      node: {
        ok: info.ok,
        base: info.base,
        configured: info.configured,
        version: info.version,
        sources: info.sources,
        plugins: info.plugins,
        searches: info.searches,
        lavaSearch: !!info.lavaSearch,
        error: info.error,
        attempts: info.attempts,
      },
      audio: {
        mode: STREAM_MODE,
        ytdlp: hasBin("yt-dlp"),
        ffmpeg: hasBin("ffmpeg"),
        pluginRoute: pluginRouteUsable ? PLUGIN_ROUTE : null,
      },
      hints: buildHints(info),
    });
  }

  if (p === "/api/search") {
    const query = String(q.q || "").trim();
    const empty = { tracks: [], albums: [], artists: [], playlists: [] };
    if (!query) return json(res, 200, empty);

    try {
      if (/^https?:\/\//i.test(query)) {
        const col = await loadCollection(query);
        const payload = { ...empty, tracks: col.tracks };
        if (col.info) {
          if (col.info.type === "album") payload.albums = [col.info];
          else if (col.info.type === "artist") payload.artists = [col.info];
          else payload.playlists = [col.info];
        }
        return json(res, 200, payload);
      }

      const result = await searchEverywhere(query);
      console.log(
        `[SEARCH] "${query}" → ${result.tracks.length} tracks via ${JSON.stringify(result.sources)}${
          result.errors.length ? ` (errors: ${result.errors.join("; ")})` : ""
        }`
      );

      // Always 200 so the UI renders a real message instead of throwing.
      const payload = {
        tracks: result.tracks,
        albums: result.albums,
        artists: result.artists,
        playlists: result.playlists,
      };
      if (!result.tracks.length) {
        const info = await getNodeInfo();
        payload.warning = info.ok
          ? result.errors.length
            ? `No results. Node reported: ${result.errors[0]}`
            : "No results for that search."
          : `Lavalink is unreachable: ${info.error}`;
        payload.errors = result.errors;
      }
      return json(res, 200, payload);
    } catch (error) {
      console.error("[SEARCH] failed:", error);
      return json(res, 200, { ...empty, warning: error?.message || String(error) });
    }
  }

  if (p === "/api/browse") {
    if (browseCache.data && Date.now() - browseCache.at < 5 * 60 * 1000) {
      return json(res, 200, browseCache.data);
    }
    const seeds = [
      "top hits 2026",
      "The Weeknd",
      "Arijit Singh",
      "Billie Eilish",
      "Kendrick Lamar",
      "SZA",
      "Diljit Dosanjh",
      "Arctic Monkeys",
    ];

    const searches = await Promise.allSettled(seeds.map((s) => searchEverywhere(s, { limit: 12 })));

    const accept = makeDeduper();
    const tracks = [];
    const albumCards = [];
    const artists = [];
    const seenA = new Set();
    const seenR = new Set();

    for (const s of searches) {
      if (s.status !== "fulfilled") continue;
      for (const t of s.value.tracks) if (accept(t)) tracks.push(t);
      for (const a of s.value.albums) {
        if (!a.url || seenA.has(a.url)) continue;
        seenA.add(a.url);
        albumCards.push(a);
      }
      for (const a of s.value.artists) {
        if (!a.url || seenR.has(a.url)) continue;
        seenR.add(a.url);
        artists.push(a);
      }
    }

    // Editor's picks used to be hard-coded Spotify album URLs, which 404 on a
    // node without LavaSrc. They are a bonus now, never a requirement.
    const picks = [];
    const info = await getNodeInfo();
    if (info.sources?.includes("spotify")) {
      const albumUrls = [
        "https://open.spotify.com/album/4yP0hdKOZPNshxUOjY0cZj",
        "https://open.spotify.com/album/7aJuG4TFXa2hmE4z1sxplt",
        "https://open.spotify.com/album/07w0rG5TETcyihsEIZR3qG",
        "https://open.spotify.com/album/3RQQmkQEvNCY4prGKE6oc5",
        "https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa",
        "https://open.spotify.com/album/3mH6qwIy9wRZv8tSJdWqvK",
      ];
      const albums = await Promise.allSettled(albumUrls.map((x) => loadCollection(x)));
      for (const a of albums) {
        if (a.status !== "fulfilled" || !a.value.info) continue;
        picks.push({ ...a.value.info, tracks: a.value.tracks });
      }
    }

    const data = {
      songs: tracks.slice(0, 24),
      albums: albumCards.slice(0, 18),
      artists: artists.slice(0, 16),
      picks,
    };
    if (!data.songs.length) {
      data.warning = info.ok
        ? "Connected to Lavalink, but no sources returned any tracks."
        : `Lavalink is unreachable: ${info.error}`;
    }
    console.log(`[BROWSE] ${data.songs.length} songs, ${data.albums.length} albums, ${picks.length} picks`);
    browseCache.data = data;
    browseCache.at = Date.now();
    return json(res, 200, data);
  }

  if (p === "/api/genres") {
    return json(res, 200, { genres: await genresWithArt() });
  }

  if (p === "/api/genre-meta") {
    const id = String(q.id || "").trim();
    const g = GENRES.find((x) => x.id === id);
    if (!g) return json(res, 404, { error: "Unknown genre" });
    const rec = await probeGenre(g);
    return json(res, 200, { ok: rec.trackCount > 0, genre: rec });
  }

  if (p === "/api/genre") {
    const id = String(q.id || "").trim();
    const g = GENRES.find((x) => x.id === id);
    if (!g) return json(res, 404, { error: "Unknown genre" });

    const found = await searchEverywhere(g.query, { limit: 60 });
    let tracks = found.tracks;

    // If the node gave us a real playlist for this genre, prefer its tracks.
    const pl = found.playlists?.[0];
    if (pl?.url) {
      try {
        const col = await loadCollection(pl.url);
        if (col.tracks?.length > tracks.length) tracks = col.tracks;
      } catch {
        /* keep search tracks */
      }
    }
    return json(res, 200, { genre: g, tracks });
  }

  if (p === "/api/collection") {
    const url = String(q.url || "").trim();
    if (!url) return json(res, 400, { error: "Missing url" });
    try {
      return json(res, 200, await loadCollection(url));
    } catch (e) {
      return json(res, 200, { info: null, tracks: [], warning: e.message });
    }
  }

  if (p === "/api/lyrics") {
    const title = String(q.title || "").trim();
    const artist = String(q.artist || "").trim();
    const album = String(q.album || "").trim();
    const duration = Number(q.duration || 0);
    if (!title || !artist) return json(res, 400, { error: "Missing track" });
    const key = `${artist}|${title}|${duration || ""}`.toLowerCase();
    if (lyricsCache.has(key)) return json(res, 200, lyricsCache.get(key));

    const headers = { "User-Agent": CLIENT_UA, "Lrclib-Client": CLIENT_UA };
    const getUrl = new URL("/api/get", LRCLIB);
    getUrl.searchParams.set("track_name", title);
    getUrl.searchParams.set("artist_name", artist);
    if (album) getUrl.searchParams.set("album_name", album);
    if (duration > 0) getUrl.searchParams.set("duration", String(Math.round(duration)));

    let payload = null;
    try {
      let r = await fetch(getUrl, { headers, signal: AbortSignal.timeout(12000) });
      if (r.ok) payload = await r.json();
      if (!payload) {
        const sUrl = new URL("/api/search", LRCLIB);
        sUrl.searchParams.set("track_name", title);
        sUrl.searchParams.set("artist_name", artist);
        r = await fetch(sUrl, { headers, signal: AbortSignal.timeout(12000) });
        if (r.ok) {
          const arr = await r.json();
          if (Array.isArray(arr) && arr.length) payload = arr.find((x) => x.syncedLyrics) || arr[0];
        }
      }
    } catch {
      return json(res, 404, { error: "No lyrics" });
    }
    if (!payload) return json(res, 404, { error: "No lyrics" });

    const out = {
      id: payload.id,
      trackName: payload.trackName || payload.name,
      artistName: payload.artistName,
      albumName: payload.albumName,
      duration: payload.duration,
      instrumental: payload.instrumental,
      plainLyrics: payload.plainLyrics,
      syncedLyrics: payload.syncedLyrics,
    };
    lyricsCache.set(key, out);
    if (lyricsCache.size > 800) lyricsCache.delete(lyricsCache.keys().next().value);
    return json(res, 200, out);
  }

  if (p === "/api/cover") {
    const raw = String(q.u || "");
    let url;
    try {
      url = new URL(raw);
    } catch {
      return send(res, 400, "bad url");
    }
    if (!/^https?:$/.test(url.protocol)) return send(res, 400, "bad url");
    if (!COVER_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) {
      return send(res, 400, "bad host");
    }
    try {
      const up = await fetch(url, {
        signal: AbortSignal.timeout(12000),
        headers: { "User-Agent": CLIENT_UA },
      });
      if (!up.ok) return send(res, up.status, "cover failed");
      return pipeWeb(res, up, { "Cache-Control": "public, max-age=86400" });
    } catch {
      return send(res, 502, "cover failed");
    }
  }

  if (p === "/api/prefetch" && req.method === "POST") {
    const body = await readBody(req);
    const track = await lookupTrack(body);
    if (!track) return json(res, 200, { ok: false });
    resolveYoutubeCandidates(track)
      .then((ids) => (STREAM_MODE === "plugin" ? loadPluginAudio(ids[0]) : directAudioUrl(ids[0])))
      .catch(() => {});
    return json(res, 200, { ok: true });
  }

  if (p === "/api/stream") {
    const track = await lookupTrack(q);
    if (!track) return json(res, 404, { error: "Unknown track" });
    try {
      return await streamTrack(req, res, track);
    } catch (e) {
      console.error(`[STREAM] ${track.title} — ${e.message}`, e.failures || "");
      if (res.headersSent) return res.end();
      return json(res, 502, { error: e.message, details: e.failures || [] });
    }
  }

  json(res, 404, { error: "Not found" });
}

function buildHints(info) {
  const hints = [];
  if (!info.ok) {
    if (info.code === "no_config") {
      hints.push("Set LAVALINK_HOST and LAVALINK_AUTH in .env (copy .env.example).");
    } else {
      hints.push(
        `Could not reach a Lavalink node. Tried: ${(info.attempts || [info.error]).join(" | ")}`
      );
      hints.push("Check the host, port, LAVALINK_SECURE and the password.");
    }
    return hints;
  }
  if (!info.sources?.length) hints.push("The node reported no source managers.");
  if (!info.sources?.includes("spotify")) {
    hints.push("No Spotify source (LavaSrc plugin). Search falls back to YouTube/SoundCloud.");
  }
  if (!info.lavaSearch) {
    hints.push("No LavaSearch plugin, so album/artist/playlist cards will be sparse.");
  }
  if (!hasBin("yt-dlp") && STREAM_MODE !== "plugin") {
    hints.push("yt-dlp is not installed — playback will fail. Install it and restart.");
  }
  return hints;
}

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

/** `npm run doctor` — diagnose the Lavalink setup without starting the server. */
async function doctor() {
  console.log(`Lahsunn Player doctor\n`);
  console.log(`configured : ${CONFIGURED?.url || "(nothing — LAVALINK_HOST is empty)"}`);
  console.log(`password   : ${LL_AUTH ? "set" : "MISSING"}`);
  console.log(`ui built   : ${fs.existsSync(path.join(WWW, "index.html")) ? "yes" : "no (run npm run build)"}`);
  console.log(`yt-dlp     : ${hasBin("yt-dlp") ? "found" : "MISSING (playback will fail)"}`);
  console.log(`ffmpeg     : ${hasBin("ffmpeg") ? "found" : "not found (optional)"}\n`);

  const info = await getNodeInfo(true);
  if (!info.ok) {
    console.error(`node       : UNREACHABLE`);
    for (const a of info.attempts || [info.error]) console.error(`             ${a}`);
  } else {
    console.log(`node       : OK — ${info.base} (v${info.version})`);
    console.log(`sources    : ${info.sources.join(", ") || "none"}`);
    console.log(`plugins    : ${info.plugins.join(", ") || "none"}`);
    console.log(`search     : ${info.searches.join(", ")}`);

    process.stdout.write(`\ntest search "top hits" ... `);
    try {
      const r = await searchEverywhere("top hits", { limit: 5 });
      console.log(`${r.tracks.length} track(s) via ${JSON.stringify(r.sources)}`);
      for (const t of r.tracks.slice(0, 3)) console.log(`   - ${t.title} — ${t.author} [${t.source}]`);
      if (r.errors.length) for (const e of r.errors) console.warn(`   ! ${e}`);
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
    }
  }
  console.log("");
  for (const h of buildHints(info)) console.warn(`hint: ${h}`);
  process.exit(info.ok ? 0 : 1);
}

const CHECK_MODE = process.argv.includes("--check") || process.argv.includes("--doctor");

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) await handleApi(req, res);
    else serveStatic(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: err?.message || "Server error" });
    else res.end();
  }
});

process.on("uncaughtException", (e) => console.error("uncaught", e));
process.on("unhandledRejection", (e) => console.error("unhandled", e));

function boot() {
  server.listen(PORT, "0.0.0.0", onListening);
}

async function onListening() {
  console.log(`Lahsunn Player listening on ${PORT}`);
  if (!CONFIGURED) {
    console.warn("[LAVALINK] not configured — copy .env.example to .env and set LAVALINK_HOST/LAVALINK_AUTH");
  } else {
    console.log(`[LAVALINK] configured base: ${CONFIGURED.url}`);
    if (!LL_AUTH) console.warn("[LAVALINK] LAVALINK_AUTH is empty — the node will reject every request");
  }
  if (!fs.existsSync(path.join(WWW, "index.html"))) {
    console.warn("[UI] client/www is missing — run `npm run build`");
  }

  const info = await getNodeInfo(true);
  if (info.ok) {
    console.log(`[LAVALINK] connected to ${info.base} (v${info.version})`);
    console.log(`[LAVALINK] sources: ${info.sources.join(", ") || "none"}`);
    console.log(`[LAVALINK] search prefixes in use: ${info.searches.join(", ")}`);
    if (info.plugins.length) console.log(`[LAVALINK] plugins: ${info.plugins.join(", ")}`);
  } else {
    console.error(`[LAVALINK] NOT reachable — ${info.error}`);
  }
  for (const h of buildHints(info)) console.warn(`[HINT] ${h}`);
}

if (CHECK_MODE) doctor();
else boot();
