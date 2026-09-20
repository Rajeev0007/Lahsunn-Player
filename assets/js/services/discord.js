/* ============================================================
   Loru Player — services/discord.js
   Sends the current track to a Discord Rich Presence helper.

   A web page cannot talk to Discord directly: Rich Presence uses a
   local IPC socket (a named pipe on Windows, a unix socket
   elsewhere), which browsers have no access to by design. So Loru
   posts the now-playing details to a small helper you run on your
   own machine — tools/discord-presence.mjs — and the helper does
   the Discord part.

   Nothing leaves your computer: the only request is to 127.0.0.1.
   ============================================================ */
(function (L) {
  'use strict';

  const { store } = L;

  const DEFAULT_PORT = 6472;
  const HEARTBEAT_MS = 15000;

  let timer = null;
  let lastPayload = '';
  let online = null;        // null = untested, true/false = last result
  let failures = 0;

  function enabled() { return !!store.state.settings.discordPresence; }
  function port() { return Number(store.state.settings.discordPort) || DEFAULT_PORT; }
  function base() { return `http://127.0.0.1:${port()}`; }

  /** Current listening state, shaped for the helper. */
  function payload() {
    const track = store.currentTrack();
    if (!track) return { clear: true };

    return {
      playing: !!store.state.playing,
      title: String(track.title || '').slice(0, 128),
      artist: String(track.artist || '').slice(0, 128),
      album: String(track.album || '').slice(0, 128),
      source: track.source || 'loru',
      artwork: track.artwork || null,
      url: track.permalink || null,
      duration: Math.round(track.duration || store.state.duration || 0),
      position: Math.round(store.state.position || 0),
    };
  }

  async function send(body, { silent = true } = {}) {
    const res = await fetch(`${base()}/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // The helper is on the loopback interface; never send credentials
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Helper responded ${res.status}`);
    online = true;
    failures = 0;
    if (!silent) store.set({ discordOnline: true });
    return res.json().catch(() => ({}));
  }

  /** Pushes presence if anything meaningful changed. */
  async function push({ force = false } = {}) {
    if (!enabled()) return;

    const body = payload();
    // Position changes constantly; only the identity and play state matter
    const signature = JSON.stringify({ ...body, position: undefined });
    if (!force && signature === lastPayload) return;
    lastPayload = signature;

    try {
      await send(body);
    } catch (e) {
      failures += 1;
      online = false;
      store.set({ discordOnline: false });
      // Stop hammering a helper that clearly is not running
      if (failures >= 3) stop();
    }
  }

  function start() {
    if (!enabled() || timer) return;
    push({ force: true });
    timer = setInterval(() => push({ force: true }), HEARTBEAT_MS);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** Clears the Discord status without disabling the integration. */
  async function clear() {
    try { await send({ clear: true }); } catch (e) { /* helper gone */ }
  }

  /** Explicit connection test for the Settings screen. */
  async function test() {
    const res = await fetch(`${base()}/status`, { cache: 'no-store', mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(`Helper responded ${res.status}`);
    const info = await res.json();
    online = true;
    store.set({ discordOnline: true });
    return info;     // { ok, discord, user, clientId }
  }

  function init() {
    // Track identity or play state changing is what Discord cares about
    store.on(['index', 'playing', 'queue'], () => push());

    store.on('settings', () => {
      if (enabled()) start();
      else { stop(); clear(); lastPayload = ''; }
    });

    if (enabled()) start();

    // Leaving the page should not leave a stale "listening" status behind
    window.addEventListener('pagehide', () => { if (enabled()) clear(); });
  }

  L.discord = {
    init, push, start, stop, clear, test,
    DEFAULT_PORT,
    get online() { return online; },
    get enabled() { return enabled(); },
  };
})(window.Loru);
