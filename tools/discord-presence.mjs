#!/usr/bin/env node
/* ============================================================
   Loru Player — Discord Rich Presence helper
   ------------------------------------------------------------
   Browsers cannot reach Discord: Rich Presence runs over a local
   IPC socket (a named pipe on Windows, a unix socket elsewhere).
   This helper bridges the two — it listens on 127.0.0.1 for
   now-playing updates from Loru in your browser, and forwards
   them to the Discord desktop app.

   Zero dependencies: the Discord IPC protocol is implemented
   directly below.

   Usage:
     DISCORD_CLIENT_ID=your_app_id node tools/discord-presence.mjs
     node tools/discord-presence.mjs --client-id 123 --port 6472

   Get a client id at https://discord.com/developers/applications
   (create an application; the Application ID is the client id).
   ============================================================ */

import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

/* ---------------- options ---------------- */
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const CLIENT_ID = flag('client-id', process.env.DISCORD_CLIENT_ID || '');
const PORT = Number(flag('port', process.env.LORU_PRESENCE_PORT || 6472));
const ORIGIN = flag('origin', process.env.LORU_ORIGIN || '*');
const VERBOSE = args.includes('--verbose');

if (!CLIENT_ID) {
  console.error(`
Missing Discord client id.

  1. Open https://discord.com/developers/applications and create an application
  2. Copy its Application ID
  3. Run:  DISCORD_CLIENT_ID=<that id> node tools/discord-presence.mjs

Optionally upload an image named "loru" under Rich Presence → Art Assets
so your status shows the Loru artwork.
`);
  process.exit(1);
}

const log = (...a) => console.log('[loru-presence]', ...a);
const debug = (...a) => { if (VERBOSE) console.log('[loru-presence]', ...a); };

/* ============================================================
   Discord IPC
   Frames are an 8-byte little-endian header (op, length) followed
   by a JSON payload. Ops: 0 handshake, 1 frame, 2 close, 3 ping.
   ============================================================ */
const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function socketPaths() {
  if (process.platform === 'win32') {
    return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  }
  // Discord may sit directly in the runtime dir or under a sandbox subdirectory
  const bases = [
    process.env.XDG_RUNTIME_DIR,
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP,
    '/tmp',
  ].filter(Boolean);

  const subdirs = ['', 'app/com.discordapp.Discord/', 'snap.discord/', '.flatpak/dev.vencord.Vesktop/xdg-run/'];
  const out = [];
  for (const b of bases) {
    for (const sub of subdirs) {
      for (let i = 0; i < 10; i++) out.push(path.join(b, sub, `discord-ipc-${i}`));
    }
  }
  return out;
}

class DiscordIPC {
  constructor(clientId) {
    this.clientId = clientId;
    this.socket = null;
    this.ready = false;
    this.user = null;
    this.buffer = Buffer.alloc(0);
    this.retryDelay = 3000;
  }

  connect() {
    const candidates = socketPaths();

    const attempt = (index) => {
      if (index >= candidates.length) {
        this.ready = false;
        debug('no Discord IPC socket found; retrying shortly');
        setTimeout(() => this.connect(), this.retryDelay);
        return;
      }

      const socket = net.createConnection(candidates[index]);
      socket.once('error', () => { socket.destroy(); attempt(index + 1); });
      socket.once('connect', () => {
        this.socket = socket;
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('close', () => this.onClose());
        socket.on('error', () => this.onClose());
        this.write(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
        debug('connected via', candidates[index]);
      });
    };

    attempt(0);
  }

  onClose() {
    if (this.ready) log('Discord disconnected — will reconnect');
    this.ready = false;
    this.user = null;
    this.socket = null;
    setTimeout(() => this.connect(), this.retryDelay);
  }

  write(op, data) {
    if (!this.socket || this.socket.destroyed) return false;
    const json = Buffer.from(JSON.stringify(data), 'utf8');
    const header = Buffer.alloc(8);
    header.writeInt32LE(op, 0);
    header.writeInt32LE(json.length, 4);
    try { this.socket.write(Buffer.concat([header, json])); return true; }
    catch (e) { return false; }
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const len = this.buffer.readInt32LE(4);
      if (this.buffer.length < 8 + len) break;

      const body = this.buffer.subarray(8, 8 + len).toString('utf8');
      this.buffer = this.buffer.subarray(8 + len);

      let msg = null;
      try { msg = JSON.parse(body); } catch (e) { continue; }

      if (op === OP.PING) { this.write(OP.PONG, msg); continue; }

      if (msg.cmd === 'DISPATCH' && msg.evt === 'READY') {
        this.ready = true;
        this.user = (msg.data && msg.data.user) || null;
        log(`connected to Discord as ${this.user ? this.user.username : 'unknown user'}`);
        if (this.pending) { this.setActivity(this.pending); this.pending = null; }
      } else if (msg.evt === 'ERROR') {
        log('Discord error:', (msg.data && msg.data.message) || 'unknown');
      }
    }
  }

  setActivity(activity) {
    if (!this.ready) { this.pending = activity; return false; }
    return this.write(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity },
      nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
  }

  clearActivity() {
    if (!this.ready) { this.pending = null; return false; }
    return this.write(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: null },
      nonce: `${Date.now()}-clear`,
    });
  }
}

/* ============================================================
   Presence shaping
   ============================================================ */
const SOURCE_LABEL = {
  youtube: 'YouTube', spotify: 'Spotify', audius: 'Audius',
  soundcloud: 'SoundCloud', itunes: 'Apple Music', url: 'Stream', demo: 'Demo',
};

function buildActivity(body) {
  const title = (body.title || 'Unknown track').slice(0, 128);
  const artist = (body.artist || '').slice(0, 128);
  const via = SOURCE_LABEL[body.source] || 'Loru';

  const activity = {
    // 2 = Listening. Some Discord builds still render RPC as "Playing";
    // the details below are what actually matters visually.
    type: 2,
    details: title,
    state: artist ? `by ${artist}` : `on Loru Player`,
    instance: false,
    assets: {
      large_image: body.artwork || 'loru',
      large_text: (body.album || `Listening on Loru Player`).slice(0, 128),
      small_image: 'loru',
      small_text: `via ${via}`,
    },
  };

  if (body.playing && body.duration > 0) {
    // Giving Discord both ends draws a progress bar
    const startMs = Date.now() - Math.max(0, body.position || 0) * 1000;
    activity.timestamps = {
      start: Math.round(startMs),
      end: Math.round(startMs + body.duration * 1000),
    };
  } else if (body.playing) {
    activity.timestamps = { start: Date.now() - Math.max(0, body.position || 0) * 1000 };
  } else {
    activity.state = artist ? `by ${artist} · paused` : 'Paused';
  }

  if (body.url && /^https?:\/\//.test(body.url)) {
    activity.buttons = [{ label: `Listen on ${via}`, url: body.url }];
  }

  return activity;
}

/* ============================================================
   Local HTTP bridge
   ============================================================ */
const ipc = new DiscordIPC(CLIENT_ID);
ipc.connect();

let current = null;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Required by Chrome's Private Network Access checks for loopback
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const json = (res, code, obj) => {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url.startsWith('/status')) {
    json(res, 200, {
      ok: true,
      discord: ipc.ready,
      user: ipc.user ? ipc.user.username : null,
      clientId: CLIENT_ID,
      nowPlaying: current ? { title: current.title, artist: current.artist } : null,
    });
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/presence')) {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024) req.destroy();   // nothing legitimate is this big
    });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (e) { json(res, 400, { ok: false, error: 'invalid json' }); return; }

      if (body.clear) {
        current = null;
        ipc.clearActivity();
        debug('cleared');
        json(res, 200, { ok: true, cleared: true, discord: ipc.ready });
        return;
      }

      current = body;
      const sent = ipc.setActivity(buildActivity(body));
      debug(sent ? 'updated' : 'queued', '·', body.title, '—', body.artist);
      json(res, 200, { ok: true, discord: ipc.ready, queued: !sent });
    });
    return;
  }

  json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT}`);
  log('now enable Discord presence in Loru: Settings → Discord');
  if (ORIGIN === '*') log('tip: pass --origin https://yoursite to restrict which page may post');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[loru-presence] port ${PORT} is already in use — is the helper already running?`);
    process.exit(1);
  }
  console.error('[loru-presence]', err.message);
});

const shutdown = () => {
  log('shutting down');
  try { ipc.clearActivity(); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(0), 150);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
