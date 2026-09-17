import http from "http";
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
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
const LRCLIB = "https://lrclib.net";
const CLIENT_UA = "LahsunnPlayer/2.0 (+by Rajeev)";

/* Playlist importers. All optional — each degrades on its own. */
const SPOTIFY_ID = (process.env.SPOTIFY_CLIENT_ID || "").trim();
const SPOTIFY_SECRET = (process.env.SPOTIFY_CLIENT_SECRET || "").trim();
const LASTFM_KEY = (process.env.LASTFM_API_KEY || "").trim();
const IMPORT_MAX = Number(process.env.IMPORT_MAX_TRACKS || 500);
const stripSlash = (s) => String(s).replace(/\/+$/, "");
const SPOTIFY_AUTH_URL = process.env.SPOTIFY_AUTH_URL || "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE = stripSlash(process.env.SPOTIFY_API_BASE || "https://api.spotify.com/v1");
const LASTFM_API_BASE = process.env.LASTFM_API_BASE || "https://ws.audioscrobbler.com/2.0/";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/* ------------------------------------------------------------------ *
 * yt-dlp common arguments
 *
 * YouTube actively blocks datacenter IPs (Render, Railway, Fly, etc.).
 * The web_embedded player client bypasses most of these restrictions.
 * A realistic User-Agent is also essential — without it, YouTube returns
 * empty search results or 403s on audio URLs.
 * ------------------------------------------------------------------ */

const YTDLP_CLIENT = process.env.YTDLP_CLIENT || "web_embedded";

function ytdlpBaseArgs() {
  const args = [
    "--no-warnings",
    "--quiet",
    "--user-agent", BROWSER_UA,
    "--extractor-args", `youtube:player_client=${YTDLP_CLIENT}`,
  ];
  if (process.env.YTDLP_COOKIES) args.push("--cookies", process.env.YTDLP_COOKIES);
  if (process.env.YTDLP_PROXY) args.push("--proxy", process.env.YTDLP_PROXY);
  const extra = (process.env.YTDLP_ARGS || "").trim();
  if (extra) args.push(...extra.split(/\s+/));
  return args;
}

/* ------------------------------------------------------------------ *
 * caches
 * ------------------------------------------------------------------ */

const trackCache = new Map();
const ytResolveCache = new Map();
const browseCache = { data: null, at: 0 };
const lyricsCache = new Map();
const genreProbeCache = new Map();
const directUrlCache = new Map();
const ytdlpSearchCache = new Map();

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
  "lastfm.freetls.fastly.net",
  "lastfm-img2.akamaized.net",
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

const CORS_ORIGIN = (process.env.CORS_ORIGIN || "").trim();
const CORS_LIST = CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);

function applyCors(req, res) {
  if (CORS_LIST.length) {
    const origin = req.headers.origin;
    const allow = CORS_LIST.includes("*") ? "*" : CORS_LIST.find((o) => o === origin);
    if (allow) {
      res.setHeader("Access-Control-Allow-Origin", allow);
      if (allow !== "*") res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
      res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
      res.setHeader("Access-Control-Max-Age", "86400");
    }
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
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
 * yt-dlp provisioning
 *
 * yt-dlp is the sole engine for search and streaming. If it is not on PATH the
 * server downloads the official standalone build once and caches it.
 * ------------------------------------------------------------------ */

const YTDLP_AUTO = !/^(0|false|no|off)$/i.test(String(process.env.YTDLP_AUTO_DOWNLOAD ?? "true").trim());
const YTDLP_DIR = process.env.YTDLP_DIR || path.join(os.tmpdir(), "lahsunn-bin");

const ytdlpState = { path: null, source: null, error: null, checking: null };

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

function tryYtdlpBinary(candidate) {
  if (!candidate) return false;
  try {
    const r = spawnSync(candidate, ["--version"], { stdio: "pipe", timeout: 20000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

function ytdlpAssetName() {
  if (process.platform === "win32") return "yt-dlp.exe";
  if (process.platform === "darwin") return "yt-dlp_macos";
  if (process.platform === "linux") {
    const arch = process.arch;
    if (arch === "arm64") return "yt-dlp_linux_aarch64";
    if (arch === "arm") return "yt-dlp_linux_armv7l";
    if (arch === "x64") return "yt-dlp_linux";
  }
  return "yt-dlp";
}

async function downloadYtdlp() {
  const asset = ytdlpAssetName();
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
  const dest = path.join(YTDLP_DIR, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");

  fs.mkdirSync(YTDLP_DIR, { recursive: true });
  console.log(`[AUDIO] downloading ${asset} -> ${dest}`);

  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": CLIENT_UA },
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500000) throw new Error(`download too small (${buf.length} bytes)`);

  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, buf);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest);

  if (!tryYtdlpBinary(dest)) {
    if (asset === "yt-dlp" && !hasBin("python3")) {
      throw new Error("downloaded the Python build but python3 is not installed");
    }
    throw new Error("downloaded binary would not run");
  }
  return dest;
}

async function ensureYtdlp() {
  if (ytdlpState.path) return ytdlpState.path;
  if (ytdlpState.checking) return ytdlpState.checking;

  const found = (p, source) => {
    ytdlpState.path = p;
    ytdlpState.source = source;
    ytdlpState.error = null;
    return p;
  };

  const run = (async () => {
    const explicit = (process.env.YTDLP_PATH || "").trim();
    if (explicit) {
      if (tryYtdlpBinary(explicit)) return found(explicit, "YTDLP_PATH");
      ytdlpState.error = `YTDLP_PATH is set to "${explicit}" but it does not run`;
      return null;
    }

    if (tryYtdlpBinary("yt-dlp")) return found("yt-dlp", "PATH");

    const cached = path.join(YTDLP_DIR, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    if (fs.existsSync(cached) && tryYtdlpBinary(cached)) return found(cached, "cached download");

    if (!YTDLP_AUTO) {
      ytdlpState.error = "yt-dlp is not installed and YTDLP_AUTO_DOWNLOAD is off";
      return null;
    }

    try {
      const p = await downloadYtdlp();
      console.log(`[AUDIO] yt-dlp ready (${p})`);
      return found(p, "auto-downloaded");
    } catch (e) {
      ytdlpState.error = `could not obtain yt-dlp — ${e.message}`;
      console.error(`[AUDIO] ${ytdlpState.error}`);
      return null;
    }
  })().finally(() => {
    ytdlpState.checking = null;
  });

  ytdlpState.checking = run;
  return run;
}

const ytdlpReady = () => !!ytdlpState.path;

/* ------------------------------------------------------------------ *
 * track normalisation
 * ------------------------------------------------------------------ */

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, "")
    .replace(/\b(official|video|audio|lyrics?|hd|hq|remaster(ed)?|feat\.?|ft\.?)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();

function rememberTrack(track) {
  if (!track?.id) return;
  trackCache.set(`${track.source}:${track.id}`, track);
  trackCache.set(track.id, track);
  if (trackCache.size > 6000) trackCache.delete(trackCache.keys().next().value);
}

/** Longest thing we will treat as a song. Hour-long mixes make the UI useless. */
const MAX_TRACK_MS = Math.max(1, Number(process.env.MAX_TRACK_MINUTES || 20)) * 60 * 1000;

function isReasonableTrack(t) {
  if (!t?.title) return false;
  if (t.duration && t.duration > MAX_TRACK_MS) return false;
  return true;
}

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

/** Stable synthetic id for a track that has no source id of its own. */
function synthId(title, author) {
  const s = `${norm(title)}|${norm(author)}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `im${(h >>> 0).toString(36)}`;
}

function makeImportedTrack({ title, author, album, artwork, duration, isrc, source, id, uri }) {
  if (!title) return null;
  const track = {
    id: id || synthId(title, author),
    encoded: null,
    title: String(title).trim(),
    author: String(author || "").trim(),
    duration: Number(duration) || 0,
    artwork: artwork || null,
    uri: uri || null,
    source: source || "import",
    isrc: isrc || null,
    album: album || "",
    albumUrl: "",
    artistUrl: "",
    artistArtwork: null,
  };
  rememberTrack(track);
  return track;
}

/* ------------------------------------------------------------------ *
 * yt-dlp search — the sole search engine
 * ------------------------------------------------------------------ */

/** Search YouTube with yt-dlp. */
async function ytdlpSearch(query, limit = 20) {
  const FETCH = 25;
  const key = query;
  const hit = ytdlpSearchCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.tracks.slice(0, limit);

  const bin = await ensureYtdlp();
  if (!bin) throw new Error(ytdlpState.error || "yt-dlp is not available");

  const args = [
    `ytsearch${Math.max(1, Math.min(40, FETCH))}:${query}`,
    "--flat-playlist",
    "--dump-single-json",
    "--no-playlist",
    ...ytdlpBaseArgs(),
  ];

  const data = await new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("yt-dlp search timed out"));
    }, 45000);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`yt-dlp failed to start: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) {
        return reject(new Error(err.trim().split("\n").pop() || `yt-dlp exited ${code}`));
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error("yt-dlp search returned unparseable JSON"));
      }
    });
  });

  const tracks = [];
  for (const e of data?.entries || []) {
    const id = e?.id;
    if (!isVideoId(id)) continue;
    const track = {
      id,
      encoded: null,
      title: e.title || "Unknown",
      author: e.uploader || e.channel || e.playlist_uploader || "",
      duration: Math.round((Number(e.duration) || 0) * 1000),
      artwork:
        (Array.isArray(e.thumbnails) && e.thumbnails[e.thumbnails.length - 1]?.url) ||
        `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      uri: e.url || `https://www.youtube.com/watch?v=${id}`,
      source: "youtube",
      isrc: null,
      album: "",
      albumUrl: "",
      artistUrl: "",
      artistArtwork: null,
    };
    if (!isReasonableTrack(track)) continue;
    rememberTrack(track);
    tracks.push(track);
  }

  ytdlpSearchCache.set(key, { at: Date.now(), tracks });
  if (ytdlpSearchCache.size > 300) ytdlpSearchCache.delete(ytdlpSearchCache.keys().next().value);
  return tracks.slice(0, limit);
}

/** Search and return full result object for the API. */
async function searchEverywhere(query, { limit = 80 } = {}) {
  const out = {
    tracks: [],
    albums: [],
    artists: [],
    playlists: [],
    sources: {},
    errors: [],
    engine: "ytdlp",
  };
  const accept = makeDeduper();

  try {
    const tracks = await ytdlpSearch(query, Math.min(limit, 25));
    out.sources.ytdlp = tracks.length;
    for (const t of tracks) if (accept(t) && isReasonableTrack(t)) out.tracks.push(t);
  } catch (e) {
    out.errors.push(`ytdlp: ${e.message}`);
  }

  out.tracks = out.tracks.slice(0, limit);
  return out;
}

/** Cheapest possible "does this query return anything" check. */
async function firstHit(query, { limit = 50 } = {}) {
  try {
    const tracks = (await ytdlpSearch(query, Math.min(limit, 12))).filter(isReasonableTrack);
    return { tracks: tracks.slice(0, limit), via: tracks.length ? "ytdlp" : null };
  } catch {
    return { tracks: [], via: null };
  }
}

/* ------------------------------------------------------------------ *
 * yt-dlp playlist expansion
 * ------------------------------------------------------------------ */

async function ytdlpPlaylist(url, limit = 500) {
  const bin = await ensureYtdlp();
  if (!bin) throw new Error(ytdlpState.error || "yt-dlp is not available");

  const args = [url, "--flat-playlist", "--dump-single-json", ...ytdlpBaseArgs()];

  const data = await new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("yt-dlp playlist read timed out"));
    }, 90000);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`yt-dlp failed to start: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) {
        return reject(new Error(err.trim().split("\n").pop() || `yt-dlp exited ${code}`));
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error("yt-dlp returned unparseable JSON"));
      }
    });
  });

  const entries = Array.isArray(data?.entries) ? data.entries : [];
  if (!entries.length) throw new Error("no tracks in that playlist");

  const tracks = [];
  for (const e of entries.slice(0, limit)) {
    if (!isVideoId(e?.id)) continue;
    const t = makeImportedTrack({
      id: e.id,
      title: e.title,
      author: e.uploader || e.channel || "",
      artwork:
        (Array.isArray(e.thumbnails) && e.thumbnails[e.thumbnails.length - 1]?.url) ||
        `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
      duration: Math.round((Number(e.duration) || 0) * 1000),
      source: "youtube",
      uri: e.url || `https://www.youtube.com/watch?v=${e.id}`,
    });
    if (t) tracks.push(t);
  }
  if (!tracks.length) throw new Error("playlist had no playable entries");

  return {
    name: data.title || "YouTube playlist",
    author: data.uploader || data.channel || "",
    artwork: tracks.find((t) => t.artwork)?.artwork || null,
    type: "playlist",
    url,
    tracks,
  };
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
  // Trust the list rather than probing 30 genres (which would spawn 30 yt-dlp
  // processes). The genre page does the real query.
  return GENRES.map((g) => ({ ...g, artwork: null, trackCount: 1 }));
}

/* ------------------------------------------------------------------ *
 * playlist import — Spotify / YouTube / Last.fm
 * ------------------------------------------------------------------ */

async function httpJson(url, { headers = {}, method = "GET", body, timeout = 15000, label = "request" } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      body,
      headers: { "User-Agent": CLIENT_UA, Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    const why = e?.name === "TimeoutError" ? "timed out" : e?.cause?.code || e?.message || "network error";
    throw new Error(`${label}: ${why}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      detail = j.error?.message || j.message || j.error_description || j.error || detail;
    } catch {
      /* keep raw */
    }
    throw new Error(`${label}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: response was not JSON`);
  }
}

/* --- Spotify Web API (client credentials) ----------------------------- */

let spToken = { value: null, exp: 0 };

async function spotifyToken() {
  if (!SPOTIFY_ID || !SPOTIFY_SECRET) {
    throw new Error("Spotify import is not configured (set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET)");
  }
  if (spToken.value && Date.now() < spToken.exp - 30000) return spToken.value;
  const data = await httpJson(SPOTIFY_AUTH_URL, {
    method: "POST",
    label: "Spotify auth",
    headers: {
      Authorization: `Basic ${Buffer.from(`${SPOTIFY_ID}:${SPOTIFY_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!data.access_token) throw new Error("Spotify auth: no access token returned");
  spToken = { value: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return spToken.value;
}

async function spotifyGet(pathAndQuery) {
  const token = await spotifyToken();
  const url = /^https?:\/\//i.test(pathAndQuery) ? pathAndQuery : `${SPOTIFY_API_BASE}${pathAndQuery}`;
  return httpJson(url, {
    headers: { Authorization: `Bearer ${token}` },
    label: "Spotify API",
  });
}

const spTrackFrom = (t, fallbackArt) =>
  t &&
  makeImportedTrack({
    id: t.id,
    title: t.name,
    author: (t.artists || []).map((a) => a.name).filter(Boolean).join(", "),
    album: t.album?.name || "",
    artwork: t.album?.images?.[0]?.url || fallbackArt || null,
    duration: t.duration_ms,
    isrc: t.external_ids?.isrc || null,
    source: "spotify",
    uri: t.external_urls?.spotify || null,
  });

async function spotifyPaginate(firstPage, onItem, cap = IMPORT_MAX) {
  let page = firstPage;
  let count = 0;
  while (page) {
    for (const item of page.items || []) {
      if (onItem(item)) count += 1;
      if (count >= cap) return count;
    }
    if (!page.next) return count;
    page = await spotifyGet(page.next);
  }
  return count;
}

async function importSpotify(kind, id) {
  const tracks = [];

  if (kind === "album") {
    const album = await spotifyGet(`/albums/${id}?limit=50`);
    const albumRef = { name: album.name, images: album.images };
    const art = album.images?.[0]?.url || null;
    await spotifyPaginate(album.tracks, (t) => {
      const rec = spTrackFrom({ ...t, album: albumRef }, art);
      if (rec) tracks.push(rec);
      return !!rec;
    });
    return {
      name: album.name,
      author: (album.artists || []).map((a) => a.name).filter(Boolean).join(", "),
      artwork: art,
      type: "album",
      url: album.external_urls?.spotify || null,
      tracks,
    };
  }

  const pl = await spotifyGet(`/playlists/${id}`);
  await spotifyPaginate(pl.tracks, (item) => {
    const t = item?.track;
    if (!t || t.type === "episode") return false;
    const rec = spTrackFrom(t);
    if (rec) tracks.push(rec);
    return !!rec;
  });
  return {
    name: pl.name || "Spotify playlist",
    author: pl.owner?.display_name || "",
    artwork: pl.images?.[0]?.url || null,
    type: "playlist",
    url: pl.external_urls?.spotify || null,
    tracks,
  };
}

/* --- Last.fm ---------------------------------------------------------- */

const lfmImage = (arr) => {
  if (!Array.isArray(arr)) return null;
  const pick = arr[arr.length - 1] || arr[0];
  const url = pick?.["#text"] || null;
  return url && !/2a96cbd8b46e442fc41c2b86b821562f/.test(url) ? url : null;
};

async function importLastfm(user, mode = "loved") {
  if (!LASTFM_KEY) throw new Error("Last.fm import is not configured (set LASTFM_API_KEY)");
  if (!user) throw new Error("Last.fm needs a username");

  const method =
    mode === "top" ? "user.gettoptracks" : mode === "recent" ? "user.getrecenttracks" : "user.getlovedtracks";
  const url = new URL(LASTFM_API_BASE);
  url.searchParams.set("method", method);
  url.searchParams.set("user", user);
  url.searchParams.set("api_key", LASTFM_KEY);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", String(Math.min(IMPORT_MAX, 200)));
  if (mode === "top") url.searchParams.set("period", "overall");

  const data = await httpJson(url, { label: "Last.fm API" });
  if (data.error) throw new Error(`Last.fm API: ${data.message || data.error}`);

  const root = data.lovedtracks || data.toptracks || data.recenttracks || {};
  const list = Array.isArray(root.track) ? root.track : root.track ? [root.track] : [];
  const seen = new Set();
  const tracks = [];
  for (const t of list) {
    const title = t?.name;
    const author = t?.artist?.name || t?.artist?.["#text"] || "";
    if (!title) continue;
    const key = `${norm(title)}|${norm(author)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rec = makeImportedTrack({
      title,
      author,
      artwork: lfmImage(t.image),
      duration: Number(t.duration || 0) * 1000,
      source: "lastfm",
      uri: t.url || null,
    });
    if (rec) tracks.push(rec);
    if (tracks.length >= IMPORT_MAX) break;
  }
  const label = mode === "top" ? "top tracks" : mode === "recent" ? "recent tracks" : "loved tracks";
  return {
    name: `${user} — ${label}`,
    author: "Last.fm",
    artwork: tracks.find((t) => t.artwork)?.artwork || null,
    type: "playlist",
    url: `https://www.last.fm/user/${encodeURIComponent(user)}`,
    tracks,
  };
}

/* --- dispatcher ------------------------------------------------------- */

function detectImport(raw) {
  const value = String(raw || "").trim();
  if (!value) return { kind: "empty" };

  const lfm = /^lastfm:([^/\s]+)(?:\/(loved|top|recent))?$/i.exec(value);
  if (lfm) return { kind: "lastfm", user: lfm[1], mode: (lfm[2] || "loved").toLowerCase() };

  if (/^https?:\/\//i.test(value)) {
    let u;
    try {
      u = new URL(value);
    } catch {
      return { kind: "invalid" };
    }
    const host = u.hostname.replace(/^www\./, "");

    if (host === "last.fm" || host.endsWith(".last.fm")) {
      const m = /^\/user\/([^/]+)(?:\/(loved|library)?)?/.exec(u.pathname);
      if (m) return { kind: "lastfm", user: decodeURIComponent(m[1]), mode: "loved" };
      return { kind: "invalid" };
    }
    if (host === "open.spotify.com") {
      const m = /^\/(?:intl-[a-z]{2}\/)?(playlist|album|track)\/([A-Za-z0-9]+)/.exec(u.pathname);
      if (m) return { kind: "spotify", type: m[1], id: m[2], url: value };
      return { kind: "url", url: value };
    }
    return { kind: "url", url: value };
  }

  if (/^[\w.\- ]{2,40}$/.test(value)) return { kind: "lastfm", user: value, mode: "loved" };
  return { kind: "invalid" };
}

async function importPlaylist(raw) {
  const target = detectImport(raw);
  if (target.kind === "empty") throw new Error("Paste a playlist link or a Last.fm username");
  if (target.kind === "invalid") throw new Error("That does not look like a playlist link or username");

  if (target.kind === "lastfm") {
    const out = await importLastfm(target.user, target.mode);
    return { ...out, via: "lastfm" };
  }

  const attempts = [];

  // yt-dlp can expand YouTube (and many other) playlist URLs
  if (target.kind === "url") {
    try {
      const out = await ytdlpPlaylist(target.url, IMPORT_MAX);
      return { ...out, via: "ytdlp" };
    } catch (e) {
      attempts.push(`ytdlp: ${e.message}`);
    }
  }

  if (target.kind === "spotify") {
    if (target.type === "track") {
      const t = await spotifyGet(`/tracks/${target.id}`);
      const rec = spTrackFrom(t);
      if (rec) {
        return {
          name: rec.title,
          author: rec.author,
          artwork: rec.artwork,
          type: "track",
          url: target.url,
          tracks: [rec],
          via: "spotify",
        };
      }
    } else {
      try {
        const out = await importSpotify(target.type, target.id);
        if (out.tracks.length) return { ...out, via: "spotify" };
        attempts.push("spotify: playlist is empty or unavailable");
      } catch (e) {
        attempts.push(`spotify: ${e.message}`);
      }
    }
  }

  throw new Error(attempts.join(" | ") || "Could not import that link");
}

/* ------------------------------------------------------------------ *
 * Discord presence relay
 * ------------------------------------------------------------------ */

const presenceBox = new Map();
const PRESENCE_TTL = 90 * 1000;
const PRESENCE_MAX_KEYS = 500;
const PRESENCE_KEY_RE = /^[A-Za-z0-9_-]{12,64}$/;

const clampText = (v, n) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

function prunePresence() {
  const now = Date.now();
  for (const [k, v] of presenceBox) if (now - v.at > PRESENCE_TTL) presenceBox.delete(k);
  while (presenceBox.size > PRESENCE_MAX_KEYS) {
    presenceBox.delete(presenceBox.keys().next().value);
  }
}

function putPresence(key, body) {
  const data = {
    playing: !!body.playing,
    title: clampText(body.title, 128),
    author: clampText(body.author, 128),
    album: clampText(body.album, 128),
    artwork: typeof body.artwork === "string" && /^https?:\/\//i.test(body.artwork) ? body.artwork.slice(0, 500) : null,
    duration: Math.max(0, Math.min(24 * 3600, Number(body.duration) || 0)),
    position: Math.max(0, Math.min(24 * 3600, Number(body.position) || 0)),
    url: typeof body.url === "string" && /^https?:\/\//i.test(body.url) ? body.url.slice(0, 500) : null,
  };
  presenceBox.set(key, { at: Date.now(), data });
  prunePresence();
  return data;
}

function getPresence(key) {
  const rec = presenceBox.get(key);
  if (!rec) return null;
  if (Date.now() - rec.at > PRESENCE_TTL) {
    presenceBox.delete(key);
    return null;
  }
  return { ...rec.data, ageMs: Date.now() - rec.at };
}

/* ------------------------------------------------------------------ *
 * audio: resolve a YouTube video, then stream it via yt-dlp
 * ------------------------------------------------------------------ */

function ytdlpArgs(videoId) {
  const args = [
    "--no-playlist",
    "-f",
    process.env.YTDLP_FORMAT || "bestaudio[ext=m4a]/bestaudio/best",
    "-g",
    ...ytdlpBaseArgs(),
  ];
  args.push(`https://www.youtube.com/watch?v=${videoId}`);
  return args;
}

function runYtdlp(bin, videoId) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ytdlpArgs(videoId));
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

async function directAudioUrl(videoId, { fresh = false } = {}) {
  if (fresh) directUrlCache.delete(videoId);
  const hit = directUrlCache.get(videoId);
  if (hit && Date.now() - hit.at < 90 * 60 * 1000) return hit.url;
  const bin = await ensureYtdlp();
  if (!bin) throw new Error(ytdlpState.error || "yt-dlp is not available on the server");
  const url = await runYtdlp(bin, videoId);
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

/**
 * Resolve a track to YouTube video IDs, then stream it.
 * For YouTube-native tracks the id is used directly. For imported tracks
 * (Spotify, Last.fm, etc.) we search YouTube by title + author.
 */
async function resolveYoutubeCandidates(track) {
  if (!track) throw new Error("no_track");
  if (track.source === "youtube" && isVideoId(track.id)) return [track.id];

  const key = `${track.source}:${track.id}`;
  if (ytResolveCache.has(key)) return ytResolveCache.get(key);

  const ranked = [];
  const consider = (results) => {
    for (const r of (results || []).slice(0, 8)) {
      if (!isVideoId(r.id)) continue;
      const delta = Math.abs((r.duration || 0) - (track.duration || 0));
      const a = String(r.title).toLowerCase();
      const b = String(track.title).toLowerCase();
      const titleHit = a.includes(b.slice(0, 18)) || b.includes(a.slice(0, 18));
      ranked.push({ id: r.id, score: delta + (titleHit ? 0 : 25000) });
    }
  };

  if (track.title) {
    const query = `${track.title} ${track.author}`.trim();
    try {
      consider(await ytdlpSearch(query, 10));
    } catch {
      /* nothing else to try */
    }
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

/** Try every candidate video until audio flows. */
async function streamTrack(req, res, track) {
  const ids = await resolveYoutubeCandidates(track);
  const failures = [];

  for (const id of ids) {
    // A googlevideo URL can expire before our TTL is up. On failure we discard
    // it and re-resolve once.
    for (const fresh of [false, true]) {
      try {
        const url = await directAudioUrl(id, { fresh });
        return await proxyAudio(req, res, url);
      } catch (e) {
        failures.push(`yt-dlp(${id})${fresh ? " [retried]" : ""}: ${e.message}`);
        if (res.headersSent) return res.end();
        if (fresh || !directUrlCache.has(id)) break;
        directUrlCache.delete(id);
      }
    }
  }

  const err = new Error("no playable audio for this track");
  err.code = "no_audio";
  err.failures = failures;
  throw err;
}

/* ------------------------------------------------------------------ *
 * misc
 * ------------------------------------------------------------------ */

async function lookupTrack(query) {
  const key = query.src && query.id ? `${query.src}:${query.id}` : query.id;
  if (key && trackCache.has(key)) return trackCache.get(key);
  if (query.id && trackCache.has(query.id)) return trackCache.get(query.id);
  if (query.title) {
    return {
      id: query.id,
      title: query.title,
      author: query.author || "",
      duration: Number(query.duration || 0) * 1000,
      source: query.src || "youtube",
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
    const base = path.basename(file);
    const noStore = ext === ".html" || base === "sw.js" || ext === ".webmanifest";
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": noStore ? "no-store" : "public, max-age=3600",
      ...(base === "sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
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

  if (p === "/api/status") {
    return json(res, 200, {
      audio: {
        ytdlp: ytdlpReady(),
        ytdlpSource: ytdlpState.source,
        ytdlpError: ytdlpState.error,
        ffmpeg: hasBin("ffmpeg"),
      },
      importers: {
        youtube: true,
        spotifyApi: !!(SPOTIFY_ID && SPOTIFY_SECRET),
        lastfm: !!LASTFM_KEY,
        maxTracks: IMPORT_MAX,
      },
      hints: buildHints(),
    });
  }

  if (p === "/api/search") {
    const query = String(q.q || "").trim();
    const empty = { tracks: [], albums: [], artists: [], playlists: [] };
    if (!query) return json(res, 200, empty);

    try {
      // If user pasted a URL, try to expand it as a playlist
      if (/^https?:\/\//i.test(query)) {
        try {
          const pl = await ytdlpPlaylist(query, 100);
          return json(res, 200, { ...empty, tracks: pl.tracks });
        } catch {
          // Not a playlist URL — fall through to regular search
        }
      }

      const result = await searchEverywhere(query);
      console.log(
        `[SEARCH] "${query}" → ${result.tracks.length} tracks via yt-dlp${
          result.errors.length ? ` (errors: ${result.errors.join("; ")})` : ""
        }`
      );

      const payload = {
        tracks: result.tracks,
        albums: result.albums,
        artists: result.artists,
        playlists: result.playlists,
      };
      if (!result.tracks.length) {
        payload.warning = result.errors.length
          ? `No results. ${result.errors[0]}`
          : "No results for that search.";
        payload.errors = result.errors;
      }
      return json(res, 200, payload);
    } catch (error) {
      console.error("[SEARCH] failed:", error);
      return json(res, 200, { ...empty, warning: error?.message || String(error) });
    }
  }

  if (p === "/api/browse") {
    if (browseCache.data && Date.now() - browseCache.at < 20 * 60 * 1000) {
      return json(res, 200, browseCache.data);
    }

    const seeds = ["top hits", "Arijit Singh", "The Weeknd", "trending songs", "Diljit Dosanjh"];

    const searches = await Promise.allSettled(
      seeds.map(async (s) => {
        const r = await firstHit(s, { limit: 8 });
        return { tracks: r.tracks };
      })
    );

    const accept = makeDeduper();
    const tracks = [];

    for (const s of searches) {
      if (s.status !== "fulfilled") continue;
      for (const t of s.value.tracks) if (accept(t)) tracks.push(t);
    }

    const data = {
      songs: tracks.slice(0, 24),
      albums: [],
      artists: [],
      picks: [],
    };
    if (!data.songs.length) {
      data.warning = ytdlpReady()
        ? "No songs found from the search seeds."
        : `yt-dlp is not ready: ${ytdlpState.error || "still setting up"}`;
    }
    console.log(`[BROWSE] ${data.songs.length} songs`);
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
    return json(res, 200, { ok: true, genre: { ...g, artwork: null, trackCount: 1 } });
  }

  if (p === "/api/genre") {
    const id = String(q.id || "").trim();
    const g = GENRES.find((x) => x.id === id);
    if (!g) return json(res, 404, { error: "Unknown genre" });

    const found = await searchEverywhere(g.query, { limit: 60 });
    return json(res, 200, { genre: g, tracks: found.tracks });
  }

  if (p === "/api/presence") {
    if (req.method === "POST") {
      const body = await readBody(req);
      const key = String(body.key || "");
      if (!PRESENCE_KEY_RE.test(key)) return json(res, 400, { ok: false, error: "bad key" });
      putPresence(key, body);
      return json(res, 200, { ok: true });
    }
    const key = String(q.key || "");
    if (!PRESENCE_KEY_RE.test(key)) return json(res, 400, { ok: false, error: "bad key" });
    const data = getPresence(key);
    return json(res, 200, { ok: true, present: !!data, activity: data, appName: "Lahsunn Player" });
  }

  if (p === "/api/import") {
    const value = String(q.q || q.url || "").trim();
    const t0 = Date.now();
    try {
      const out = await importPlaylist(value);
      console.log(
        `[IMPORT] "${value}" -> ${out.tracks.length} track(s) via ${out.via} in ${Date.now() - t0}ms`
      );
      return json(res, 200, {
        ok: true,
        name: out.name,
        author: out.author,
        artwork: out.artwork,
        type: out.type,
        url: out.url,
        via: out.via,
        tracks: out.tracks,
        truncated: out.tracks.length >= IMPORT_MAX,
      });
    } catch (e) {
      console.error(`[IMPORT] "${value}" failed: ${e.message}`);
      return json(res, 200, { ok: false, error: e.message, tracks: [], hints: importHints() });
    }
  }

  if (p === "/api/collection") {
    const url = String(q.url || "").trim();
    if (!url) return json(res, 400, { error: "Missing url" });
    try {
      const pl = await ytdlpPlaylist(url, IMPORT_MAX);
      return json(res, 200, {
        info: { name: pl.name, author: pl.author, artwork: pl.artwork, type: pl.type, url: pl.url },
        tracks: pl.tracks,
      });
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
      .then((ids) => directAudioUrl(ids[0]))
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

function importHints() {
  const hints = [];
  if (!SPOTIFY_ID || !SPOTIFY_SECRET) {
    hints.push("For Spotify links, set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.");
  }
  if (!LASTFM_KEY) hints.push("For Last.fm imports, set LASTFM_API_KEY.");
  return hints;
}

function buildHints() {
  const hints = [];
  if (!ytdlpReady()) {
    hints.push(
      ytdlpState.error
        ? `Nothing can play: ${ytdlpState.error}`
        : "yt-dlp is still being set up — retry in a moment."
    );
    hints.push(
      "On Render, the surest fix is to deploy with the Docker runtime (this repo has a Dockerfile) so yt-dlp and ffmpeg are installed."
    );
  }
  return hints;
}

/* ------------------------------------------------------------------ *
 * boot
 * ------------------------------------------------------------------ */

async function doctor() {
  console.log(`Lahsunn Player doctor\n`);
  console.log(`ui built   : ${fs.existsSync(path.join(WWW, "index.html")) ? "yes" : "no (run npm run build)"}`);
  const ytBin = await ensureYtdlp();
  console.log(
    `yt-dlp     : ${ytBin ? `found (${ytdlpState.source}: ${ytBin})` : `MISSING — ${ytdlpState.error || "unknown"}`}`
  );
  console.log(`ffmpeg     : ${hasBin("ffmpeg") ? "found" : "not found (optional)"}\n`);

  process.stdout.write(`test search "top hits" ... `);
  try {
    const r = await searchEverywhere("top hits", { limit: 5 });
    console.log(`${r.tracks.length} track(s)`);
    for (const t of r.tracks.slice(0, 3)) console.log(`   - ${t.title} — ${t.author}`);
    if (r.errors.length) for (const e of r.errors) console.warn(`   ! ${e}`);
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
  }

  console.log("");
  console.log(
    `importers  : youtube=yes` +
      ` spotify=${SPOTIFY_ID && SPOTIFY_SECRET ? "web-api" : "no"}` +
      ` lastfm=${LASTFM_KEY ? "yes" : "no"}`
  );
  for (const h of [...buildHints(), ...importHints()]) console.warn(`hint: ${h}`);
  process.exit(ytBin ? 0 : 1);
}

const CHECK_MODE = process.argv.includes("--check") || process.argv.includes("--doctor");

const server = http.createServer(async (req, res) => {
  try {
    if (applyCors(req, res)) return;
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
  if (!fs.existsSync(path.join(WWW, "index.html"))) {
    console.warn("[UI] client/www is missing — run `npm run build`");
  }

  // Kick this off immediately so first play is fast
  ensureYtdlp().then((bin) => {
    if (bin) console.log(`[AUDIO] yt-dlp: ${ytdlpState.source} (${bin})`);
    else console.error(`[AUDIO] yt-dlp not available — ${ytdlpState.error}`);
  });

  for (const h of buildHints()) console.warn(`[HINT] ${h}`);
}

if (CHECK_MODE) doctor();
else boot();
