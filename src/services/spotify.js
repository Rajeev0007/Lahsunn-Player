/* ============================================================
   Loru Player — services/spotify.js
   Authorization Code + PKCE (no server, no client secret).
   Reading playlists needs only a free Spotify account.
   Full-track playback additionally needs Premium (Web Playback SDK);
   without it we fall back to 30-second previews or an Audius match.
   ============================================================ */
(function (L) {
  'use strict';

  const { storage, fetchJSON, store } = L;

  const AUTH_URL = 'https://accounts.spotify.com/authorize';
  const TOKEN_URL = 'https://accounts.spotify.com/api/token';
  const API = 'https://api.spotify.com/v1';
  /* Reading a library needs none of Spotify's playback scopes. Requesting
     them made the consent screen imply Premium was required, and the Web
     Playback SDK refuses to start without it. Loru plays full tracks through
     YouTube instead, so these are only requested if the listener explicitly
     opts into Spotify's own player. */
  const READ_SCOPES = [
    'user-read-private', 'user-read-email',
    'playlist-read-private', 'playlist-read-collaborative',
    'user-library-read', 'user-top-read',
    // recentlyPlayed() calls /me/player/recently-played, which 403s without this.
    'user-read-recently-played',
  ].join(' ');

  const PLAYBACK_SCOPES = [
    'streaming', 'user-modify-playback-state', 'user-read-playback-state',
  ].join(' ');

  function usePremiumPlayer() {
    return !!store.state.settings.spotifyUsePremiumPlayer;
  }

  /**
   * Always ask for the playback scopes, even though most listeners never use
   * them. Scopes are fixed at consent time, so requesting them conditionally
   * meant anyone who connected first and enabled Spotify's own player afterwards
   * held a token without `streaming` — the SDK then failed with a raw
   * authentication error and no way to recover short of disconnecting by hand.
   * A slightly longer consent screen is worth not having that trap.
   */
  function scopes() {
    return `${READ_SCOPES} ${PLAYBACK_SCOPES}`;
  }

  const SCOPES = scopes();

  /* Filled in from /me. Spotify removed `market=from_token`, so requests that
     need a market use the real country code and simply omit it otherwise. */
  let userCountry = null;
  function marketQuery(extra = {}) {
    return userCountry ? { ...extra, market: userCountry } : { ...extra };
  }

  const KEY_TOKENS = 'spotify:tokens';
  const KEY_VERIFIER = 'spotify:verifier';
  const KEY_STATE = 'spotify:state';

  /* ---------------- config ---------------- */
  function clientId() {
    return (store.state.settings.spotifyClientId || '').trim();
  }
  function isConfigured() { return !!clientId(); }

  /**
   * The redirect URI must match what is registered in the Spotify dashboard
   * byte for byte, so it is canonicalised: `/index.html` is dropped in favour
   * of the directory form. That way `example.com/` and `example.com/index.html`
   * both produce `https://example.com/` and a single registered entry works.
   */
  function redirectUri() {
    const path = location.pathname.replace(/index\.html?$/i, '');
    return location.origin + (path || '/');
  }

  /* ---------------- PKCE helpers ---------------- */
  function randomString(len = 96) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  }

  async function challengeFrom(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /* ---------------- tokens ---------------- */
  function readTokens() { return storage.get(KEY_TOKENS, null); }
  function writeTokens(t) {
    storage.set(KEY_TOKENS, t);
  }
  function isConnected() {
    const t = readTokens();
    return !!(t && t.refresh_token);
  }

  function logout() {
    storage.remove(KEY_TOKENS);
    store.setConnection('spotify', { connected: false, user: null, premium: false });
    destroyPlayer();
  }

  async function login() {
    if (!isConfigured()) throw new Error('Add your Spotify Client ID in Settings first.');
    const verifier = randomString();
    const challenge = await challengeFrom(verifier);
    const state = randomString(24);

    /* Deliberately localStorage, not sessionStorage. On phones the Spotify
       consent screen often returns through a different tab or an in-app
       browser, which starts a fresh session and would lose the verifier —
       the login then fails with "session expired". The verifier is
       single-use and cleared immediately after the exchange. */
    storage.set(KEY_VERIFIER, verifier);
    storage.set(KEY_STATE, state);
    storage.set('spotify:returnTo', location.hash || '#/sources');

    const params = new URLSearchParams({
      client_id: clientId(),
      response_type: 'code',
      redirect_uri: redirectUri(),
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state,
      scope: scopes(),
      show_dialog: 'false',
    });
    location.assign(`${AUTH_URL}?${params}`);
  }

  /** Called on boot: completes the redirect leg if ?code= is present. */
  async function handleRedirect() {
    const url = new URL(location.href);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (!code && !error) return false;

    // Clean the URL immediately so a refresh doesn't retry a used code
    const returnTo = storage.get('spotify:returnTo', '#/sources');
    storage.remove('spotify:returnTo');
    history.replaceState(null, '', location.pathname + (returnTo || ''));

    if (error) {
      const hint = error === 'access_denied'
        ? 'You declined the permission prompt.'
        : 'Check that the Redirect URI in your Spotify app matches the one shown in Settings exactly.';
      throw new Error(`Spotify refused the login (${error}). ${hint}`);
    }

    const expectedState = storage.get(KEY_STATE, null);
    const gotState = url.searchParams.get('state');
    storage.remove(KEY_STATE);
    if (expectedState && gotState && expectedState !== gotState) {
      throw new Error('Login response did not match the request. Please try connecting again.');
    }

    // Migrate any verifier left in sessionStorage by an older version
    const verifier = storage.get(KEY_VERIFIER, null) || storage.session.get(KEY_VERIFIER, null);
    if (!verifier) throw new Error('Login could not be completed — please tap Connect and try once more.');
    storage.remove(KEY_VERIFIER);
    storage.session.remove(KEY_VERIFIER);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: clientId(),
      code_verifier: verifier,
    });

    let tokens;
    try {
      tokens = await fetchJSON(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (err) {
      // Spotify's errors here are famously opaque; translate the common ones
      const detail = (err.payload && (err.payload.error_description || err.payload.error)) || '';
      if (/redirect_uri/i.test(detail)) {
        throw new Error(`Spotify rejected the Redirect URI. Add exactly "${redirectUri()}" to your app in the Spotify dashboard.`);
      }
      if (/client/i.test(detail)) {
        throw new Error('Spotify rejected the Client ID. Check it was copied in full from the dashboard.');
      }
      throw new Error(detail ? `Spotify login failed: ${detail}` : 'Spotify login failed.');
    }
    tokens.expires_at = Date.now() + (tokens.expires_in - 60) * 1000;
    writeTokens(tokens);
    await loadProfile();
    return true;
  }

  async function refresh() {
    const t = readTokens();
    if (!t || !t.refresh_token) throw new Error('Not connected to Spotify.');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: clientId(),
    });
    const next = await fetchJSON(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    next.refresh_token = next.refresh_token || t.refresh_token;
    next.expires_at = Date.now() + (next.expires_in - 60) * 1000;
    writeTokens(next);
    return next.access_token;
  }

  async function token() {
    const t = readTokens();
    if (!t) throw new Error('Not connected to Spotify.');
    if (!t.expires_at || t.expires_at <= Date.now()) return refresh();
    return t.access_token;
  }

  /* ---------------- API ---------------- */
  async function api(path, { method = 'GET', body, query } = {}, retried = false) {
    const access = await token();
    const url = path.startsWith('http')
      ? path
      : `${API}${path}${query ? '?' + new URLSearchParams(query) : ''}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${access}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;

    /* A 401 used to call logout(), which deletes the refresh token — so one
       transient 401 (clock skew, a token revoked a second early, a hiccup on
       Spotify's side) permanently signed the listener out and demanded a full
       re-consent. Force one refresh and retry before concluding the session is
       really gone. */
    if (res.status === 401 && !retried) {
      try { await refresh(); } catch (e) {
        logout();
        throw new Error('Spotify sign-in expired — reconnect in Settings.');
      }
      return api(path, { method, body, query }, true);
    }
    if (res.status === 401) {
      logout();
      throw new Error('Spotify sign-in expired — reconnect in Settings.');
    }

    if (res.status === 403) {
      /* "Premium may be required" was shown for every 403, including missing
         scopes and region blocks, which sent people chasing the wrong problem. */
      let detail = '';
      try { detail = (await res.json()).error.message; } catch (e) {}
      throw new Error(detail
        ? `Spotify refused that request: ${detail}`
        : 'Spotify refused that request. Full-length playback needs Premium; everything else needs the app reconnected.');
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get('Retry-After') || 0);
      throw new Error(wait
        ? `Spotify rate limit hit — try again in ${wait}s.`
        : 'Spotify rate limit hit — wait a moment and retry.');
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error.message; } catch (e) {}
      throw new Error(detail || `Spotify error ${res.status}`);
    }
    return res.json();
  }

  async function loadProfile() {
    try {
      const me = await api('/me');
      const premium = me.product === 'premium';
      userCountry = me.country || null;
      store.setConnection('spotify', {
        connected: true,
        premium,
        country: userCountry,
        user: { id: me.id, name: me.display_name || me.id, image: (me.images && me.images[0] && me.images[0].url) || null, product: me.product },
      });
      return me;
    } catch (e) {
      store.setConnection('spotify', { connected: false, user: null, premium: false });
      throw e;
    }
  }

  /* ---------------- normalisation ---------------- */
  function normalizeTrack(item) {
    const t = item && (item.track || item);
    if (!t || !t.id) return null;
    const images = (t.album && t.album.images) || [];
    return {
      id: t.id,
      source: 'spotify',
      uri: t.uri,
      title: t.name,
      artist: (t.artists || []).map((a) => a.name).join(', ') || 'Unknown artist',
      album: (t.album && t.album.name) || '',
      artwork: (images[1] || images[0] || {}).url || null,
      duration: Math.round((t.duration_ms || 0) / 1000),
      previewUrl: t.preview_url || null,
      permalink: (t.external_urls && t.external_urls.spotify) || null,
      explicit: !!t.explicit,
      popularity: t.popularity,
    };
  }

  function normalizePlaylist(p) {
    if (!p || !p.id) return null;
    return {
      id: p.id,
      source: 'spotify',
      name: p.name || 'Untitled playlist',
      description: (p.description || '').replace(/<[^>]*>/g, ''),
      artwork: (p.images && p.images[0] && p.images[0].url) || null,
      owner: (p.owner && (p.owner.display_name || p.owner.id)) || '',
      trackCount: (p.tracks && p.tracks.total) || 0,
      externalUrl: (p.external_urls && p.external_urls.spotify) || null,
    };
  }

  /* ---------------- reads ---------------- */
  async function myPlaylists({ limit = 50 } = {}) {
    const res = await api('/me/playlists', { query: { limit } });
    return (res.items || []).map(normalizePlaylist).filter(Boolean);
  }

  async function playlistTracks(id, { max = 400, onProgress } = {}) {
    const out = [];
    let url = `${API}/playlists/${encodeURIComponent(id)}/tracks?limit=100&fields=items(track(id,uri,name,duration_ms,preview_url,explicit,popularity,external_urls,artists(name),album(name,images))),next`;
    while (url && out.length < max) {
      const page = await api(url);
      (page.items || []).forEach((it) => {
        const t = normalizeTrack(it);
        if (t) out.push(t);
      });
      if (onProgress) onProgress(out.slice());
      url = page.next;
    }
    return out;
  }

  async function getPlaylist(id) {
    const meta = normalizePlaylist(await api(`/playlists/${encodeURIComponent(id)}`, {
      query: { fields: 'id,name,description,images,owner(display_name,id),tracks(total),external_urls' },
    }));
    const tracks = await playlistTracks(id);
    return { ...meta, tracks };
  }

  async function getAlbum(id) {
    const album = await api(`/albums/${encodeURIComponent(id)}`);
    const tracks = (album.items || (album.tracks && album.tracks.items) || []).map((t) =>
      normalizeTrack({ ...t, album: { name: album.name, images: album.images } })).filter(Boolean);
    return {
      id: album.id, source: 'spotify', name: album.name,
      description: `Album · ${(album.artists || []).map((a) => a.name).join(', ')}`,
      artwork: (album.images && album.images[0] && album.images[0].url) || null,
      owner: (album.artists || []).map((a) => a.name).join(', '),
      externalUrl: (album.external_urls && album.external_urls.spotify) || null,
      tracks,
    };
  }

  async function getTrack(id) { return normalizeTrack(await api(`/tracks/${encodeURIComponent(id)}`)); }

  async function artistTop(id) {
    const res = await api(`/artists/${encodeURIComponent(id)}/top-tracks`, { query: marketQuery() });
    return (res.tracks || []).map(normalizeTrack).filter(Boolean);
  }

  async function search(q, { limit = 25, types = 'track,playlist' } = {}) {
    const res = await api('/search', { query: { q, type: types, limit } });
    return {
      tracks: ((res.tracks && res.tracks.items) || []).map(normalizeTrack).filter(Boolean),
      playlists: ((res.playlists && res.playlists.items) || []).map(normalizePlaylist).filter(Boolean),
    };
  }

  /**
   * Newly released albums, flattened to their tracks.
   *
   * Note: Spotify retired /recommendations, /featured-playlists and
   * /categories for apps created after November 2024, so "trending" is built
   * from new releases plus the listener's own top tracks instead.
   */
  async function newReleases({ limit = 12 } = {}) {
    const res = await api('/browse/new-releases', { query: marketQuery({ limit }) });
    const albums = (res.albums && res.albums.items) || [];
    const picks = await Promise.all(albums.slice(0, limit).map(async (album) => {
      try {
        const full = await api(`/albums/${album.id}/tracks`, { query: { limit: 1 } });
        const first = (full.items || [])[0];
        if (!first) return null;
        return normalizeTrack({ ...first, album: { name: album.name, images: album.images } });
      } catch (e) { return null; }
    }));
    return picks.filter(Boolean);
  }

  /** The listener's most played tracks — the basis for recommendations. */
  async function topTracks({ limit = 30, range = 'medium_term' } = {}) {
    const res = await api('/me/top/tracks', { query: { limit, time_range: range } });
    return (res.items || []).map(normalizeTrack).filter(Boolean);
  }

  async function topArtists({ limit = 15, range = 'medium_term' } = {}) {
    const res = await api('/me/top/artists', { query: { limit, time_range: range } });
    return (res.items || []).map((a) => ({
      id: a.id,
      name: a.name,
      genres: a.genres || [],
      artwork: (a.images && a.images[0] && a.images[0].url) || null,
      followers: (a.followers && a.followers.total) || 0,
    })).filter((a) => a.id);
  }

  async function recentlyPlayed({ limit = 30 } = {}) {
    const res = await api('/me/player/recently-played', { query: { limit } });
    return (res.items || []).map((i) => normalizeTrack(i.track)).filter(Boolean);
  }

  async function savedTracks({ max = 200 } = {}) {
    const out = [];
    let url = `${API}/me/tracks?limit=50`;
    while (url && out.length < max) {
      const page = await api(url);
      (page.items || []).forEach((it) => { const t = normalizeTrack(it); if (t) out.push(t); });
      url = page.next;
    }
    return out;
  }

  /* ---------------- URL parsing ---------------- */
  function parse(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;

    const uriMatch = raw.match(/^spotify:(playlist|track|album|artist):([A-Za-z0-9]+)$/);
    if (uriMatch) return { kind: uriMatch[1], id: uriMatch[2] };

    let url;
    try { url = new URL(raw.startsWith('http') ? raw : 'https://' + raw); }
    catch (e) { return null; }
    if (!/(^|\.)spotify\.com$/.test(url.hostname)) return null;

    const parts = url.pathname.split('/').filter(Boolean);
    // Handles /playlist/ID and localised /intl-xx/playlist/ID
    const kindIdx = parts.findIndex((p) => ['playlist', 'track', 'album', 'artist'].includes(p));
    if (kindIdx >= 0 && parts[kindIdx + 1]) {
      return { kind: parts[kindIdx], id: parts[kindIdx + 1].split('?')[0] };
    }
    return null;
  }

  /* ---------------- Web Playback SDK (Premium) ---------------- */
  let sdkPromise = null;
  let player = null;
  let deviceId = null;
  let sdkHandlers = {};

  function ensureSdk() {
    if (window.Spotify && window.Spotify.Player) return Promise.resolve(window.Spotify);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Spotify player script could not load.')), 12000);
      window.onSpotifyWebPlaybackSDKReady = () => { clearTimeout(timer); resolve(window.Spotify); };
      const s = document.createElement('script');
      s.src = 'https://sdk.scdn.co/spotify-player.js';
      s.async = true;
      s.onerror = () => { clearTimeout(timer); reject(new Error('Spotify player script blocked.')); };
      document.head.appendChild(s);
    }).catch((e) => { sdkPromise = null; throw e; });
    return sdkPromise;
  }

  /** Creates (once) a Spotify device we can push tracks to. */
  async function ensurePlayer(handlers = {}) {
    sdkHandlers = { ...sdkHandlers, ...handlers };
    if (player && deviceId) return { player, deviceId };
    if (!usePremiumPlayer()) throw new Error('Spotify’s own player is switched off — Loru plays these tracks through YouTube instead.');
    if (!store.state.connections.spotify.premium) throw new Error('Spotify Premium is required to use Spotify’s own player. Loru will use YouTube instead.');

    const Spotify = await ensureSdk();
    player = new Spotify.Player({
      name: 'Loru Player',
      volume: store.state.volume,
      getOAuthToken: (cb) => { token().then(cb).catch(() => cb('')); },
    });

    player.addListener('player_state_changed', (s) => { sdkHandlers.onState && sdkHandlers.onState(s); });
    player.addListener('initialization_error', ({ message }) => sdkHandlers.onError && sdkHandlers.onError(message));
    player.addListener('authentication_error', ({ message }) => sdkHandlers.onError && sdkHandlers.onError(message));
    player.addListener('account_error', () => sdkHandlers.onError && sdkHandlers.onError('Spotify Premium required.'));
    player.addListener('playback_error', ({ message }) => sdkHandlers.onError && sdkHandlers.onError(message));

    deviceId = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Spotify device did not come online.')), 12000);
      player.addListener('ready', ({ device_id }) => { clearTimeout(timer); resolve(device_id); });
      player.addListener('not_ready', () => { deviceId = null; });
      player.connect().then((ok) => { if (!ok) { clearTimeout(timer); reject(new Error('Could not connect the Spotify player.')); } });
    });

    return { player, deviceId };
  }

  function destroyPlayer() {
    try { player && player.disconnect(); } catch (e) {}
    player = null; deviceId = null; sdkPromise = null;
  }

  async function playUri(uri, positionMs = 0) {
    const { deviceId: id } = await ensurePlayer();
    await api(`/me/player/play?device_id=${id}`, { method: 'PUT', body: { uris: [uri], position_ms: positionMs } });
  }

  const sdk = {
    ensurePlayer, destroyPlayer, playUri,
    get player() { return player; },
    get deviceId() { return deviceId; },
    pause: () => player && player.pause(),
    resume: () => player && player.resume(),
    seek: (ms) => player && player.seek(ms),
    setVolume: (v) => player && player.setVolume(v),
  };

  L.spotify = {
    isConfigured, isConnected, clientId, redirectUri,
    login, logout, handleRedirect, token, loadProfile, api,
    myPlaylists, playlistTracks, getPlaylist, getAlbum, getTrack, artistTop,
    search, savedTracks, parse, normalizeTrack, normalizePlaylist,
    newReleases, topTracks, topArtists, recentlyPlayed,
    sdk, SCOPES, scopes, usePremiumPlayer,
  };
})(window.Loru);
