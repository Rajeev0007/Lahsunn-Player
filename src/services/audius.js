/* ============================================================
   Loru Player — services/audius.js
   Free, key-less music streaming via the public Audius API.
   Docs: https://docs.audius.org/api/
   ============================================================ */
(function (L) {
  'use strict';

  const { fetchJSON, store } = L;
  const APP_NAME = 'LoruPlayer';
  const DISCOVERY = 'https://api.audius.co';
  const FALLBACK_HOSTS = [
    'https://discoveryprovider.audius.co',
    'https://discoveryprovider2.audius.co',
    'https://audius-discovery-1.altego.net',
  ];

  let hostPromise = null;
  let host = null;

  async function getHost() {
    if (host) return host;
    if (hostPromise) return hostPromise;

    hostPromise = (async () => {
      try {
        const res = await fetchJSON(DISCOVERY, { timeout: 8000 });
        const hosts = (res && res.data) || [];
        if (hosts.length) {
          host = hosts[Math.floor(Math.random() * Math.min(hosts.length, 4))].replace(/\/$/, '');
        }
      } catch (e) { /* fall through to static hosts */ }

      if (!host) host = FALLBACK_HOSTS[0];
      store.setConnection('audius', { host, online: true });
      return host;
    })();

    try {
      return await hostPromise;
    } catch (e) {
      hostPromise = null;
      throw e;
    }
  }

  function api(path, params = {}) {
    const qs = new URLSearchParams({ app_name: APP_NAME, ...params }).toString();
    return getHost().then((h) => fetchJSON(`${h}/v1${path}?${qs}`));
  }

  /** Stream URL for a track id (redirects to the content node). */
  function streamUrl(id) {
    const base = host || FALLBACK_HOSTS[0];
    return `${base}/v1/tracks/${encodeURIComponent(id)}/stream?app_name=${APP_NAME}`;
  }

  function pickArtwork(art) {
    if (!art) return null;
    return art['480x480'] || art['1000x1000'] || art['150x150'] || null;
  }

  function normalizeTrack(t) {
    if (!t || !t.id) return null;
    return {
      id: t.id,
      source: 'audius',
      title: t.title || 'Untitled',
      artist: (t.user && (t.user.name || t.user.handle)) || 'Unknown artist',
      artistHandle: t.user && t.user.handle,
      album: (t.album_backlink && t.album_backlink.playlist_name) || '',
      artwork: pickArtwork(t.artwork),
      duration: Number(t.duration) || 0,
      genre: t.genre || '',
      mood: t.mood || '',
      plays: Number(t.play_count) || 0,
      favorites: Number(t.favorite_count) || 0,
      permalink: t.permalink ? `https://audius.co${t.permalink}` : null,
      streamUrl: streamUrl(t.id),
      downloadable: !!(t.is_downloadable),
    };
  }

  function normalizePlaylist(p) {
    if (!p || !p.id) return null;
    return {
      id: p.id,
      source: 'audius',
      name: p.playlist_name || 'Untitled playlist',
      description: p.description || '',
      artwork: pickArtwork(p.artwork),
      owner: (p.user && (p.user.name || p.user.handle)) || '',
      trackCount: Number(p.track_count) || (p.playlist_contents ? p.playlist_contents.length : 0),
      favorites: Number(p.favorite_count) || 0,
      externalUrl: p.permalink ? `https://audius.co${p.permalink}` : null,
      isAlbum: !!p.is_album,
    };
  }

  const clean = (arr) => (Array.isArray(arr) ? arr : []).map(normalizeTrack).filter(Boolean);

  /* ---------------- Public API ---------------- */

  async function trending({ genre = '', time = 'week', limit = 20 } = {}) {
    const params = { time, limit };
    if (genre) params.genre = genre;
    const res = await api('/tracks/trending', params);
    return clean(res.data).slice(0, limit);
  }

  async function underground({ limit = 20 } = {}) {
    const res = await api('/tracks/trending/underground', { limit });
    return clean(res.data).slice(0, limit);
  }

  async function searchTracks(query, { limit = 30 } = {}) {
    if (!query) return [];
    const res = await api('/tracks/search', { query, limit });
    return clean(res.data).slice(0, limit);
  }

  async function searchPlaylists(query, { limit = 12 } = {}) {
    if (!query) return [];
    const res = await api('/playlists/search', { query, limit });
    return (res.data || []).map(normalizePlaylist).filter(Boolean).slice(0, limit);
  }

  async function searchUsers(query, { limit = 8 } = {}) {
    if (!query) return [];
    const res = await api('/users/search', { query, limit });
    return (res.data || []).map((u) => ({
      id: u.id,
      source: 'audius',
      name: u.name || u.handle,
      handle: u.handle,
      artwork: pickArtwork(u.profile_picture),
      followers: Number(u.follower_count) || 0,
      trackCount: Number(u.track_count) || 0,
      externalUrl: u.handle ? `https://audius.co/${u.handle}` : null,
    })).filter((u) => u.id);
  }

  async function getPlaylist(id) {
    const res = await api(`/playlists/${encodeURIComponent(id)}`);
    const meta = normalizePlaylist((res.data || [])[0]);
    if (!meta) throw new Error('Playlist not found');
    const tracksRes = await api(`/playlists/${encodeURIComponent(id)}/tracks`);
    return { ...meta, tracks: clean(tracksRes.data) };
  }

  async function getTrack(id) {
    const res = await api(`/tracks/${encodeURIComponent(id)}`);
    return normalizeTrack(res.data);
  }

  async function getUserTracks(id, { limit = 40 } = {}) {
    const res = await api(`/users/${encodeURIComponent(id)}/tracks`, { limit });
    return clean(res.data);
  }

  /**
   * Resolve any audius.co URL to a track / playlist / user.
   * Returns { kind, data }.
   */
  async function resolve(url) {
    const res = await api('/resolve', { url });
    const payload = Array.isArray(res.data) ? res.data[0] : res.data;
    if (!payload) throw new Error('Nothing found at that Audius link');

    if (payload.playlist_name !== undefined) {
      const meta = normalizePlaylist(payload);
      const tracksRes = await api(`/playlists/${encodeURIComponent(meta.id)}/tracks`);
      return { kind: 'playlist', data: { ...meta, tracks: clean(tracksRes.data) } };
    }
    if (payload.title !== undefined) {
      return { kind: 'track', data: normalizeTrack(payload) };
    }
    if (payload.handle !== undefined) {
      const tracks = await getUserTracks(payload.id);
      return {
        kind: 'artist',
        data: {
          id: payload.id,
          name: payload.name || payload.handle,
          artwork: pickArtwork(payload.profile_picture),
          externalUrl: `https://audius.co/${payload.handle}`,
          tracks,
        },
      };
    }
    throw new Error('Unsupported Audius link');
  }

  function tokenSet(s) {
    return new Set(normalizeText(s).split(' ').filter(Boolean));
  }

  /** Fraction of the larger token set that both share. 1 means identical. */
  function overlap(a, b) {
    if (!a.size || !b.size) return 0;
    let hit = 0;
    a.forEach((t) => { if (b.has(t)) hit += 1; });
    return hit / Math.max(a.size, b.size);
  }

  /**
   * Find the same recording on Audius, so a Spotify / YouTube / Apple title can
   * be played as full-length audio that survives the screen locking.
   *
   * Confidence matters more than coverage here. The previous version compared
   * titles only, accepted a match when either title merely *contained* the
   * other — so "Lights" satisfied a search for "Blinding Lights" — and then
   * ended with `return results[0]`, handing back the first search result even
   * when nothing matched at all. The wrong song played, which is far worse than
   * falling back to the embed and playing the right one.
   *
   * @returns {Promise<object|null>} null when there is no confident match.
   */
  async function findMatch(title, artist, { duration = 0 } = {}) {
    const wantTitle = tokenSet(title);
    if (!wantTitle.size) return null;
    const wantArtist = tokenSet(artist);

    const attempts = [`${title} ${artist}`.trim(), title].filter(Boolean);
    let best = null;

    for (const q of attempts) {
      let results = [];
      try { results = await searchTracks(q, { limit: 8 }); } catch (e) { continue; }

      for (const t of results) {
        const titleScore = overlap(wantTitle, tokenSet(t.title));
        // The title has to be essentially the same, not merely related.
        if (titleScore < 0.8) continue;

        // An unknown uploader covering a famous song is the classic false
        // positive, so the artist has to be plausible whenever we know it.
        const artistScore = wantArtist.size ? overlap(wantArtist, tokenSet(t.artist)) : 1;
        if (wantArtist.size && artistScore < 0.5) continue;

        // Same name, very different length: a remix, a live cut, or a snippet.
        if (duration && t.duration) {
          const drift = Math.abs(t.duration - duration);
          if (drift > Math.max(12, duration * 0.12)) continue;
        }

        const closeness = (duration && t.duration)
          ? 1 - Math.min(1, Math.abs(t.duration - duration) / 30)
          : 0;
        const score = titleScore * 2 + artistScore + closeness;
        if (!best || score > best.score) best = { track: t, score };
      }

      if (best) break;
    }

    return best ? best.track : null;
  }

  function normalizeText(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/\(.*?\)|\[.*?\]/g, '')
      .replace(/feat\.?|ft\.?|official|video|audio|lyrics?|hd|remaster(ed)?/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  L.audius = {
    APP_NAME,
    getHost, streamUrl, normalizeTrack, normalizePlaylist,
    trending, underground, searchTracks, searchPlaylists, searchUsers,
    getPlaylist, getTrack, getUserTracks, resolve, findMatch,
  };
})(window.Loru);
