/* ============================================================
   Loru Player — core/store.js
   Reactive state container + persisted library
   ============================================================ */
(function (L) {
  'use strict';

  const { storage, uid } = L;

  const PERSIST_KEYS = ['playlists', 'liked', 'recents', 'settings', 'playback', 'connections'];

  const defaultSettings = {
    theme: 'dark',
    accent: 'violet',
    autoplayNext: true,
    showVisualizer: true,
    backgroundAudio: true,   // keep playing when hidden, even if the real spectrum has to go
    keepAwake: false,        // hold a screen lock while playing (costs battery)
    preferYouTubeForSpotify: true,
    spotifyClientId: '',
    youtubeApiKey: '',
    youtubeMirror: '',
    defaultSource: 'youtube',
    adFreeFirst: false,
    spotifyUsePremiumPlayer: false,
    discordPresence: false,
    discordPort: 6472,
    demoMode: false,
    reduceData: false,
  };

  const state = {
    /* navigation */
    route: { name: 'home', params: {} },

    /* playback */
    queue: [],
    queueOrigin: [],       // unshuffled order, used when shuffle toggles off
    index: -1,
    playing: false,
    loading: false,
    position: 0,
    duration: 0,
    volume: 0.8,
    muted: false,
    shuffle: false,
    repeat: 'off',         // off | all | one
    context: null,         // { type, id, name }

    /* library */
    playlists: [],
    liked: [],
    recents: [],

    /* sources */
    connections: {
      spotify: { connected: false, user: null, premium: false },
      youtube: { ready: false },
      audius: { host: null, online: null },
    },

    /* ui */
    settings: { ...defaultSettings },
    device: 'desktop',     // phone | tablet | desktop
    touch: false,
    standalone: false,
    backend: 'none',       // none | audio | youtube | spotify | demo
    awaitingGesture: false, // mobile blocked autoplay; needs a real tap
    discordOnline: null,    // null untested, true/false last helper result
    queueOpen: false,
    npOpen: false,
    sidebarCollapsed: false,
    drawerOpen: false,
    searchQuery: '',
  };

  /* ---------------- pub/sub ---------------- */
  const listeners = new Map();   // key -> Set<fn>
  const anyListeners = new Set();

  function on(keys, fn) {
    const list = Array.isArray(keys) ? keys : [keys];
    list.forEach((k) => {
      if (!listeners.has(k)) listeners.set(k, new Set());
      listeners.get(k).add(fn);
    });
    return () => list.forEach((k) => listeners.get(k) && listeners.get(k).delete(fn));
  }

  function onAny(fn) { anyListeners.add(fn); return () => anyListeners.delete(fn); }

  function emit(keys) {
    const changed = new Set(keys);
    changed.forEach((k) => {
      const set = listeners.get(k);
      if (set) set.forEach((fn) => { try { fn(state[k], k); } catch (e) { console.error(e); } });
    });
    anyListeners.forEach((fn) => { try { fn(changed); } catch (e) { console.error(e); } });
  }

  /** Shallow-merge a patch into state, notify listeners for changed keys. */
  function set(patch) {
    const changed = [];
    for (const [k, v] of Object.entries(patch)) {
      if (state[k] !== v) { state[k] = v; changed.push(k); }
      else if (typeof v === 'object' && v !== null) { changed.push(k); }
    }
    if (changed.length) {
      emit(changed);
      schedulePersist(changed);
    }
    return state;
  }

  function get(key) { return key === undefined ? state : state[key]; }

  /* ---------------- persistence ---------------- */
  let persistTimer = null;
  function schedulePersist(changed) {
    const relevant = changed.some((k) =>
      PERSIST_KEYS.includes(k) ||
      ['queue', 'queueOrigin', 'index', 'volume', 'muted', 'shuffle', 'repeat', 'context', 'sidebarCollapsed', 'connections'].includes(k));
    if (!relevant) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, 400);
  }

  function persistNow() {
    storage.set('playlists', state.playlists);
    storage.set('liked', state.liked);
    storage.set('recents', state.recents.slice(0, 60));
    storage.set('settings', state.settings);
    storage.set('connections', {
      spotify: { connected: state.connections.spotify.connected },
    });
    storage.set('playback', {
      queue: state.queue.slice(0, 250),
      queueOrigin: state.queueOrigin.slice(0, 250),
      index: state.index,
      volume: state.volume,
      muted: state.muted,
      shuffle: state.shuffle,
      repeat: state.repeat,
      context: state.context,
      sidebarCollapsed: state.sidebarCollapsed,
    });
  }

  function hydrate() {
    const settings = storage.get('settings', null);
    if (settings) state.settings = { ...defaultSettings, ...settings };

    state.playlists = storage.get('playlists', []) || [];
    state.liked = storage.get('liked', []) || [];
    state.recents = storage.get('recents', []) || [];

    const pb = storage.get('playback', null);
    if (pb) {
      state.queue = Array.isArray(pb.queue) ? pb.queue : [];
      state.queueOrigin = Array.isArray(pb.queueOrigin) ? pb.queueOrigin : state.queue.slice();
      state.index = Number.isInteger(pb.index) ? Math.min(pb.index, state.queue.length - 1) : -1;
      if (typeof pb.volume === 'number') state.volume = pb.volume;
      state.muted = !!pb.muted;
      state.shuffle = !!pb.shuffle;
      state.repeat = ['off', 'all', 'one'].includes(pb.repeat) ? pb.repeat : 'off';
      state.context = pb.context || null;
      state.sidebarCollapsed = !!pb.sidebarCollapsed;
    }
  }

  /* ---------------- selectors ---------------- */
  function currentTrack() {
    return state.index >= 0 && state.index < state.queue.length ? state.queue[state.index] : null;
  }

  function trackKey(track) {
    if (!track) return '';
    return `${track.source || 'x'}:${track.id}`;
  }

  function isLiked(track) {
    const key = trackKey(track);
    return state.liked.some((t) => trackKey(t) === key);
  }

  function findPlaylist(id) {
    return state.playlists.find((p) => p.id === id) || null;
  }

  /* ---------------- library actions ---------------- */
  function createPlaylist({ name, description = '', source = 'local', artwork = null, tracks = [], externalUrl = null, id = null, owner = null } = {}) {
    const pl = {
      id: id || uid('pl'),
      name: name || 'New playlist',
      description,
      source,
      artwork,
      externalUrl,
      owner,
      tracks: tracks.slice(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    set({ playlists: [pl, ...state.playlists] });
    return pl;
  }

  function updatePlaylist(id, patch) {
    const idx = state.playlists.findIndex((p) => p.id === id);
    if (idx < 0) return null;
    const next = state.playlists.slice();
    next[idx] = { ...next[idx], ...patch, updatedAt: Date.now() };
    set({ playlists: next });
    return next[idx];
  }

  function deletePlaylist(id) {
    set({ playlists: state.playlists.filter((p) => p.id !== id) });
  }

  function addTracksToPlaylist(id, tracks) {
    const pl = findPlaylist(id);
    if (!pl) return 0;
    const existing = new Set(pl.tracks.map(trackKey));
    const incoming = (Array.isArray(tracks) ? tracks : [tracks]).filter((t) => t && !existing.has(trackKey(t)));
    if (!incoming.length) return 0;
    updatePlaylist(id, { tracks: [...pl.tracks, ...incoming] });
    return incoming.length;
  }

  function removeTrackFromPlaylist(id, key) {
    const pl = findPlaylist(id);
    if (!pl) return;
    updatePlaylist(id, { tracks: pl.tracks.filter((t) => trackKey(t) !== key) });
  }

  function toggleLike(track) {
    if (!track) return false;
    const key = trackKey(track);
    const exists = state.liked.some((t) => trackKey(t) === key);
    set({ liked: exists ? state.liked.filter((t) => trackKey(t) !== key) : [{ ...track, likedAt: Date.now() }, ...state.liked] });
    return !exists;
  }

  function pushRecent(track) {
    if (!track) return;
    const key = trackKey(track);
    const next = [{ ...track, playedAt: Date.now() }, ...state.recents.filter((t) => trackKey(t) !== key)];
    set({ recents: next.slice(0, 60) });
  }

  function updateSettings(patch) {
    set({ settings: { ...state.settings, ...patch } });
  }

  function setConnection(name, patch) {
    set({ connections: { ...state.connections, [name]: { ...state.connections[name], ...patch } } });
  }

  hydrate();

  L.store = {
    state, get, set, on, onAny, emit, persistNow,
    currentTrack, trackKey, isLiked, findPlaylist,
    createPlaylist, updatePlaylist, deletePlaylist,
    addTracksToPlaylist, removeTrackFromPlaylist,
    toggleLike, pushRecent, updateSettings, setConnection,
    defaultSettings,
  };
})(window.Loru);
