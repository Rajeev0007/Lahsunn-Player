#!/usr/bin/env node
/**
 * Lahsunn Player — Discord Rich Presence companion.
 * Made by Rajeev. No dependencies; plain Node 18+.
 *
 * WHY THIS EXISTS
 * ---------------
 * A website cannot set your Discord presence. Rich Presence is delivered over a
 * local IPC socket (`discord-ipc-N`) that the Discord *desktop app* opens on your
 * own computer. A browser tab cannot open a Unix socket / named pipe, and the web
 * server cannot either because it is not your machine. Discord has declined to
 * expose this to web apps: setting a status needs a live gateway connection
 * authenticated with a user token, which OAuth2 does not grant.
 *
 * The alternative — driving a user token yourself — is self-botting and violates
 * Discord's Terms of Service, so it is not implemented here.
 *
 * So: run this small script on the same computer where Discord is running. It
 * polls your Lahsunn Player server for what you are listening to and forwards it
 * to the local Discord socket.
 *
 * SETUP
 * -----
 * 1. Create an application at https://discord.com/developers/applications
 *    Copy its Application ID. The application's *name* is what Discord shows as
 *    the activity name, so call it something like "Lahsunn Player".
 *    (Optional) Under Rich Presence > Art Assets, upload an image named
 *    `logo` to use as a fallback cover.
 * 2. In the player, open Settings > Discord presence, enable it, and copy the key.
 * 3. Run:
 *
 *      node tools/discord-presence.mjs \
 *        --url https://your-app.onrender.com \
 *        --key <the key from Settings> \
 *        --client-id <your Application ID>
 *
 *    Or via environment variables: LAHSUNN_URL, LAHSUNN_KEY, DISCORD_CLIENT_ID.
 *
 * Leave it running. Ctrl+C clears the presence and exits.
 */

import net from "net";
import path from "path";
import process from "process";

/* ---------------- args ---------------- */

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = "true";
  }
  return out;
}

const args = parseArgs(process.argv);

if (args.help || args.h) {
  console.log(`Lahsunn Player — Discord presence companion

  --url         Player base URL          (env LAHSUNN_URL)
  --key         Presence key from Settings (env LAHSUNN_KEY)
  --client-id   Discord Application ID    (env DISCORD_CLIENT_ID)
  --interval    Poll seconds, default 5
  --large-image Asset key or image URL for the cover fallback, default "logo"
  --verbose     Log every update
`);
  process.exit(0);
}

const BASE = String(args.url || process.env.LAHSUNN_URL || "").replace(/\/+$/, "");
const KEY = String(args.key || process.env.LAHSUNN_KEY || "").trim();
const CLIENT_ID = String(args["client-id"] || process.env.DISCORD_CLIENT_ID || "").trim();
const INTERVAL = Math.max(3, Number(args.interval || 5)) * 1000;
const FALLBACK_IMAGE = String(args["large-image"] || "logo");
const VERBOSE = args.verbose === "true" || args.verbose === true;

const missing = [];
if (!BASE) missing.push("--url");
if (!KEY) missing.push("--key");
if (!CLIENT_ID) missing.push("--client-id");
if (missing.length) {
  console.error(`Missing ${missing.join(", ")}. Run with --help for usage.`);
  process.exit(1);
}
if (!/^[0-9]{15,25}$/.test(CLIENT_ID)) {
  console.error("--client-id should be the numeric Discord Application ID.");
  process.exit(1);
}

/* ---------------- Discord IPC ----------------
 * Frame format: an 8-byte little-endian header of two uint32s — opcode then the
 * byte length of the JSON payload — followed by the JSON itself.
 *   0 HANDSHAKE   1 FRAME   2 CLOSE   3 PING   4 PONG
 */

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function socketCandidates() {
  if (process.platform === "win32") {
    return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  }
  const base =
    process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
  // Flatpak and Snap builds nest the socket, so check those too.
  const dirs = [
    base,
    path.join(base, "app", "com.discordapp.Discord"),
    path.join(base, "app", "com.discordapp.DiscordCanary"),
    path.join(base, "snap.discord"),
    path.join(base, "snap.discord-canary"),
    path.join(base, ".flatpak", "com.discordapp.Discord", "xdg-run"),
  ];
  const out = [];
  for (const d of dirs) for (let i = 0; i < 10; i++) out.push(path.join(d, `discord-ipc-${i}`));
  return out;
}

function encode(op, payload) {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

class DiscordIPC {
  constructor(clientId) {
    this.clientId = clientId;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.ready = false;
    this.onReady = null;
    this.onClose = null;
  }

  connect() {
    const paths = socketCandidates();
    const tryNext = (i) => {
      if (i >= paths.length) {
        this.onClose?.(new Error("no Discord IPC socket found — is the Discord desktop app running?"));
        return;
      }
      const sock = net.createConnection(paths[i]);
      let settled = false;
      sock.once("connect", () => {
        settled = true;
        this.sock = sock;
        this.bind();
        sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
      });
      sock.once("error", () => {
        if (settled) return;
        sock.destroy();
        tryNext(i + 1);
      });
    };
    tryNext(0);
  }

  bind() {
    this.sock.on("data", (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      // Frames can arrive coalesced or split; drain only complete ones.
      while (this.buf.length >= 8) {
        const op = this.buf.readInt32LE(0);
        const len = this.buf.readInt32LE(4);
        if (this.buf.length < 8 + len) break;
        const body = this.buf.subarray(8, 8 + len).toString("utf8");
        this.buf = this.buf.subarray(8 + len);
        let msg = {};
        try {
          msg = JSON.parse(body);
        } catch {
          continue;
        }
        this.handle(op, msg);
      }
    });
    this.sock.on("close", () => {
      this.ready = false;
      this.onClose?.(new Error("Discord closed the connection"));
    });
    this.sock.on("error", (e) => {
      this.ready = false;
      this.onClose?.(e);
    });
  }

  handle(op, msg) {
    if (op === OP.PING) {
      this.sock.write(encode(OP.PONG, msg));
      return;
    }
    if (op === OP.CLOSE) {
      this.ready = false;
      this.onClose?.(new Error(msg.message || "Discord sent CLOSE"));
      return;
    }
    if (msg.evt === "READY") {
      this.ready = true;
      const user = msg.data?.user;
      this.onReady?.(user ? `${user.username}${user.discriminator && user.discriminator !== "0" ? `#${user.discriminator}` : ""}` : "unknown");
      return;
    }
    if (msg.evt === "ERROR") {
      console.error(`[discord] ${msg.data?.message || "error"} (code ${msg.data?.code ?? "?"})`);
    }
  }

  setActivity(activity) {
    if (!this.ready || !this.sock) return;
    this.sock.write(
      encode(OP.FRAME, {
        cmd: "SET_ACTIVITY",
        nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        args: { pid: process.pid, activity },
      })
    );
  }

  close() {
    try {
      this.sock?.destroy();
    } catch {
      /* nothing to do */
    }
  }
}

/* ---------------- activity shaping ---------------- */

// Discord rejects details/state shorter than 2 characters.
const pad = (s, fallback) => {
  const v = String(s || "").trim();
  if (v.length >= 2) return v.slice(0, 128);
  return fallback;
};

function buildActivity(a) {
  if (!a || !a.title) return null;

  const image =
    a.artwork && /^https?:\/\//i.test(a.artwork) ? a.artwork : FALLBACK_IMAGE;

  const activity = {
    // 2 = Listening. Some older Discord builds ignore this and render "Playing".
    type: 2,
    details: pad(a.title, "Unknown track"),
    state: pad(a.author ? `by ${a.author}` : "", "Lahsunn Player"),
    assets: {
      large_image: image,
      large_text: pad(a.album || "Lahsunn Player", "Lahsunn Player"),
      small_image: FALLBACK_IMAGE,
      small_text: a.playing ? "Playing" : "Paused",
    },
    instance: false,
  };

  // A start/end pair gives Discord a live progress bar. Only meaningful while
  // actually playing and when we know the length.
  if (a.playing && a.duration > 0) {
    const now = Date.now();
    const start = now - Math.min(a.position, a.duration) * 1000;
    activity.timestamps = { start: Math.round(start), end: Math.round(start + a.duration * 1000) };
  }

  if (a.url) {
    activity.buttons = [{ label: "Open track", url: a.url }];
  }
  return activity;
}

const activityKey = (act) =>
  act
    ? JSON.stringify([act.details, act.state, act.assets?.large_image, act.assets?.small_text, !!act.timestamps])
    : "none";

/* ---------------- main loop ---------------- */

let ipc = null;
let reconnectDelay = 2000;
let lastKey = null;
let lastSentAt = 0;
let stopped = false;

// Discord rate-limits SET_ACTIVITY, so never push faster than this.
const MIN_UPDATE_MS = 15000;

function connect() {
  ipc = new DiscordIPC(CLIENT_ID);
  ipc.onReady = (who) => {
    reconnectDelay = 2000;
    lastKey = null;
    lastSentAt = 0;
    console.log(`[discord] connected as ${who}`);
  };
  ipc.onClose = (err) => {
    if (stopped) return;
    console.warn(`[discord] ${err.message}; retrying in ${Math.round(reconnectDelay / 1000)}s`);
    ipc?.close();
    ipc = null;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  };
  ipc.connect();
}

async function poll() {
  if (stopped) return;
  try {
    const res = await fetch(`${BASE}/api/presence?key=${encodeURIComponent(KEY)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();

    // A stale mailbox means the tab was closed; drop the presence.
    const fresh = body.present && body.activity && body.activity.ageMs < 45000;
    const activity = fresh ? buildActivity(body.activity) : null;
    const key = activityKey(activity);
    const now = Date.now();

    const changed = key !== lastKey;
    const dueForRefresh = activity && now - lastSentAt > 60000;

    if (ipc?.ready && (changed || dueForRefresh) && now - lastSentAt >= (changed ? 0 : MIN_UPDATE_MS)) {
      // Coalesce rapid changes so we stay inside Discord's limit.
      if (changed && now - lastSentAt < MIN_UPDATE_MS) {
        if (VERBOSE) console.log("[presence] change held back by rate limit");
      } else {
        ipc.setActivity(activity);
        lastKey = key;
        lastSentAt = now;
        if (activity) console.log(`[presence] ${activity.details} — ${activity.state}`);
        else console.log("[presence] cleared");
      }
    }
  } catch (e) {
    if (VERBOSE) console.warn(`[player] ${e.message}`);
  } finally {
    if (!stopped) setTimeout(poll, INTERVAL);
  }
}

function shutdown() {
  if (stopped) return;
  stopped = true;
  try {
    ipc?.setActivity(null);
  } catch {
    /* best effort */
  }
  setTimeout(() => {
    ipc?.close();
    process.exit(0);
  }, 200);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`Lahsunn Player presence -> ${BASE} (polling every ${INTERVAL / 1000}s)`);
connect();
poll();
