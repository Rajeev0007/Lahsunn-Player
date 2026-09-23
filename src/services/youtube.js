/* ============================================================
   Loru Player — services/youtube.js
   Playback + playlist import through the YouTube IFrame Player API.
   No API key required: the IFrame API can load a video or a whole
   playlist by id, and oEmbed gives us titles without credentials.
   ============================================================ */
(function (L) {
  'use strict';

  const { store } = L;
  let apiPromise = null;

  /* ---------------- URL parsing ---------------- */
  const VIDEO_ID = /^[\w-]{11}$/;
  const LIST_ID = /^[\w-]{12,60}$/;

  function parse(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;

    if (VIDEO_ID.test(raw)) return { kind: 'video', id: raw };

    let url;
    try { url = new URL(raw.startsWith('http') ? raw : 'https://' + raw); }
    catch (e) { return null; }

    const host = url.hostname.replace(/^www\.|^m\./, '');
    if (!/^(youtube\.com|youtube-nocookie\.com|youtu\.be|music\.youtube\.com)$/.test(host)) return null;

    const list = url.searchParams.get('list');
    const v = url.searchParams.get('v');

    if (host === 'youtu.be') {
      const id = url.pathname.slice(1);
      if (VIDEO_ID.test(id)) return list ? { kind: 'video', id, list } : { kind: 'video', id };
    }

    if (url.pathname.startsWith('/playlist') && list) return { kind: 'playlist', id: list };
    if (url.pathname.startsWith('/shorts/')) {
      const id = url.pathname.split('/')[2];
      if (VIDEO_ID.test(id)) return { kind: 'video', id };
    }
    if (url.pathname.startsWith('/embed/')) {
      const id = url.pathname.split('/')[2];
      if (VIDEO_ID.test(id)) return { kind: 'video', id };
    }
    if (v && VIDEO_ID.test(v)) return list ? { kind: 'video', id: v, list } : { kind: 'video', id: v };
    if (list && LIST_ID.test(list)) return { kind: 'playlist', id: list };

    return null;
  }

  function thumb(videoId, quality = 'mq') {
    return `https://i.ytimg.com/vi/${videoId}/${quality}default.jpg`;
  }

  function watchUrl(videoId) { return `https://www.youtube.com/watch?v=${videoId}`; }

  /* ---------------- IFrame API loader ---------------- */
  function ensureApi() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (apiPromise) return apiPromise;

    apiPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('YouTube player could not be loaded (offline or blocked).')), 12000);

      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof prev === 'function') { try { prev(); } catch (e) {} }
        clearTimeout(timeout);
        store.setConnection('youtube', { ready: true });
        resolve(window.YT);
      };

      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => { clearTimeout(timeout); reject(new Error('YouTube script blocked')); };
      document.head.appendChild(script);
    }).catch((err) => { apiPromise = null; throw err; });

    return apiPromise;
  }

  /* ---------------- Metadata via oEmbed ---------------- */
  const metaCache = new Map();

  async function fetchMeta(videoId) {
    if (metaCache.has(videoId)) return metaCache.get(videoId);

    const endpoints = [
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl(videoId))}&format=json`,
      `https://noembed.com/embed?url=${encodeURIComponent(watchUrl(videoId))}`,
    ];

    for (const url of endpoints) {
      try {
        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) continue;
        const data = await res.json();
        if (!data || (!data.title && !data.author_name)) continue;
        const meta = {
          title: cleanTitle(data.title || 'YouTube video'),
          artist: (data.author_name || 'YouTube').replace(/ - Topic$/, ''),
          artwork: data.thumbnail_url || thumb(videoId),
        };
        metaCache.set(videoId, meta);
        return meta;
      } catch (e) { /* next endpoint */ }
    }

    const fallback = { title: null, artist: 'YouTube', artwork: thumb(videoId) };
    metaCache.set(videoId, fallback);
    return fallback;
  }

  /** Strip the usual "(Official Video)" noise from YouTube titles. */
  function cleanTitle(title) {
    return String(title || '')
      .replace(/\s*[\(\[][^)\]]*(official|lyric|audio|visuali[sz]er|mv|m\/v|hd|4k)[^)\]]*[\)\]]/gi, '')
      .replace(/\s*\|\s*official.*$/i, '')
      .trim() || String(title || '');
  }

  function toTrack(videoId, meta = {}, index = 0) {
    return {
      id: videoId,
      source: 'youtube',
      videoId,
      title: meta.title || `YouTube track ${index + 1}`,
      artist: meta.artist || 'YouTube',
      artwork: meta.artwork || thumb(videoId),
      duration: Number(meta.duration) || 0,
      permalink: watchUrl(videoId),
      needsMeta: !meta.title,
    };
  }

  /* ---------------- Playlist resolution ---------------- */
  /**
   * Loads a playlist in a throwaway hidden player purely to read the
   * video ids, then hydrates titles through oEmbed.
   * onProgress(tracks) fires as metadata streams in.
   */
  async function resolvePlaylist(listId, { limit = 200, hydrate = 40, onProgress } = {}) {
    const YT = await ensureApi();

    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:200px;height:120px;';
    const mount = document.createElement('div');
    holder.appendChild(mount);
    document.body.appendChild(holder);

    const ids = await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Timed out reading that playlist')); } }, 15000);

      const player = new YT.Player(mount, {
        height: '120', width: '200',
        playerVars: { listType: 'playlist', list: listId, autoplay: 0, controls: 0, origin: location.origin },
        events: {
          onReady() {
            // getPlaylist populates shortly after the module loads
            let tries = 0;
            const poll = setInterval(() => {
              tries++;
              let list = null;
              try { list = player.getPlaylist(); } catch (e) {}
              if ((list && list.length) || tries > 24) {
                clearInterval(poll);
                if (!settled) {
                  settled = true;
                  clearTimeout(timer);
                  resolve(list || []);
                }
                try { player.destroy(); } catch (e) {}
                holder.remove();
              }
            }, 260);
          },
          onError(e) {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(new Error('That playlist is private, deleted, or blocks embedding (code ' + (e && e.data) + ').'));
            }
            holder.remove();
          },
        },
      });
    });

    if (!ids.length) throw new Error('No playable videos found in that playlist.');

    const capped = ids.slice(0, limit);
    const tracks = capped.map((id, i) => toTrack(id, {}, i));
    if (onProgress) onProgress(tracks.slice());

    // Hydrate titles in small parallel batches so the UI fills in progressively
    const toHydrate = capped.slice(0, hydrate);
    const BATCH = 6;
    for (let i = 0; i < toHydrate.length; i += BATCH) {
      const slice = toHydrate.slice(i, i + BATCH);
      const metas = await Promise.all(slice.map((id) => fetchMeta(id).catch(() => null)));
      metas.forEach((meta, j) => {
        if (!meta || !meta.title) return;
        const idx = i + j;
        tracks[idx] = { ...tracks[idx], title: meta.title, artist: meta.artist, artwork: meta.artwork, needsMeta: false };
      });
      if (onProgress) onProgress(tracks.slice());
    }

    return { id: listId, source: 'youtube', name: 'YouTube playlist', externalUrl: `https://www.youtube.com/playlist?list=${listId}`, tracks };
  }

  async function resolveVideo(videoId) {
    const meta = await fetchMeta(videoId).catch(() => ({}));
    return toTrack(videoId, meta);
  }

  /** Hydrate titles for tracks imported without metadata (called lazily by views). */
  async function hydrateTracks(tracks, onUpdate) {
    const pending = tracks.filter((t) => t && t.source === 'youtube' && t.needsMeta);
    const BATCH = 5;
    for (let i = 0; i < pending.length; i += BATCH) {
      const slice = pending.slice(i, i + BATCH);
      const metas = await Promise.all(slice.map((t) => fetchMeta(t.videoId).catch(() => null)));
      let changed = false;
      metas.forEach((meta, j) => {
        if (!meta || !meta.title) return;
        Object.assign(slice[j], { title: meta.title, artist: meta.artist, artwork: meta.artwork, needsMeta: false });
        changed = true;
      });
      if (changed && onUpdate) onUpdate();
    }
  }

  function searchUrl(query) {
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  }

  /* ============================================================
     Search
     ------------------------------------------------------------
     YouTube's own search endpoint needs an API key, so there are
     two routes:

       1. Official Data API v3, if the listener supplies a free key
          (most reliable, but only ~100 searches/day on the free
          quota since each search costs 100 units).
       2. Public Piped / Invidious mirrors, which expose YouTube
          metadata with CORS enabled and no key at all.

     Either way only *metadata* comes from these sources — playback
     always runs through YouTube's official embedded player, so
     view counts still reach the creator. Loru never extracts or
     downloads audio streams.
     ============================================================ */

  const DEFAULT_MIRRORS = [
    { kind: 'piped', base: 'https://pipedapi.kavin.rocks' },
    { kind: 'piped', base: 'https://api.piped.private.coffee' },
    { kind: 'piped', base: 'https://pipedapi.adminforge.de' },
    { kind: 'piped', base: 'https://pipedapi.drgns.space' },
    { kind: 'piped', base: 'https://pipedapi.ducks.party' },
    { kind: 'piped', base: 'https://api.piped.yt' },
    { kind: 'invidious', base: 'https://inv.nadeko.net' },
    { kind: 'invidious', base: 'https://invidious.nerdvpn.de' },
    { kind: 'invidious', base: 'https://invidious.fdn.fr' },
    { kind: 'invidious', base: 'https://invidious.privacyredirect.com' },
    { kind: 'invidious', base: 'https://iv.melmac.space' },
    { kind: 'invidious', base: 'https://invidious.f5.si' },
  ];

  const MIRROR_KEY = 'yt:mirror';

  function settings() { return (store.state && store.state.settings) || {}; }
  function apiKey() { return (settings().youtubeApiKey || '').trim(); }

  /** User-supplied mirror first, then the last one that worked, then the rest. */
  function mirrorList() {
    const list = [];
    const custom = (settings().youtubeMirror || '').trim().replace(/\/$/, '');
    if (custom) {
      list.push({ kind: /invidious|\/api\/v1/.test(custom) ? 'invidious' : 'piped', base: custom, custom: true });
    }
    const remembered = L.storage.get(MIRROR_KEY, null);
    if (remembered && remembered.base) list.push(remembered);
    DEFAULT_MIRRORS.forEach((m) => {
      if (!list.some((x) => x.base === m.base)) list.push(m);
    });
    return list;
  }

  /** ISO-8601 (PT3M24S) → seconds, used by the official API. */
  function parseISODuration(iso) {
    const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ''));
    if (!m) return 0;
    return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  }

  function cleanArtist(name) {
    return String(name || 'YouTube').replace(/\s*-\s*Topic$/i, '').trim() || 'YouTube';
  }

  function makeTrack({ videoId, title, artist, artwork, duration, views }) {
    if (!videoId) return null;
    return {
      id: videoId,
      source: 'youtube',
      videoId,
      title: cleanTitle(title) || title || 'Untitled',
      artist: cleanArtist(artist),
      artwork: artwork || thumb(videoId),
      duration: Number(duration) || 0,
      plays: Number(views) || 0,
      permalink: watchUrl(videoId),
    };
  }

  /* ---- route 1: official Data API ---- */
  async function searchViaApi(query, limit) {
    const key = apiKey();
    const params = new URLSearchParams({
      key, part: 'snippet', type: 'video', videoCategoryId: '10',
      maxResults: String(Math.min(limit, 25)), q: query,
    });

    let res;
    try {
      res = await L.fetchJSON(`https://www.googleapis.com/youtube/v3/search?${params}`, { timeout: 10000 });
    } catch (err) {
      const reason = err.payload && err.payload.error && err.payload.error.message;
      if (err.status === 403) {
        const e = new Error(reason && /quota/i.test(reason)
          ? 'Your YouTube API key is out of quota for today (the free tier allows about 100 searches).'
          : 'YouTube rejected that API key. Check it is enabled for the YouTube Data API v3.');
        e.code = 'yt-key';
        throw e;
      }
      if (err.status === 400) {
        const e = new Error('That YouTube API key looks invalid.');
        e.code = 'yt-key';
        throw e;
      }
      throw err;
    }

    const ids = (res.items || []).map((it) => it.id && it.id.videoId).filter(Boolean);
    if (!ids.length) return [];

    // A second call is needed because search.list omits durations.
    let details = {};
    try {
      const dRes = await L.fetchJSON(`https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({
        key, part: 'contentDetails,statistics', id: ids.join(','),
      })}`, { timeout: 10000 });
      (dRes.items || []).forEach((it) => {
        details[it.id] = {
          duration: parseISODuration(it.contentDetails && it.contentDetails.duration),
          views: it.statistics && it.statistics.viewCount,
        };
      });
    } catch (e) { /* durations are optional */ }

    return (res.items || []).map((it) => {
      const id = it.id && it.id.videoId;
      const sn = it.snippet || {};
      const extra = details[id] || {};
      return makeTrack({
        videoId: id,
        title: sn.title,
        artist: sn.channelTitle,
        artwork: (sn.thumbnails && (sn.thumbnails.medium || sn.thumbnails.default) || {}).url,
        duration: extra.duration,
        views: extra.views,
      });
    }).filter(Boolean);
  }

  /* ---- route 2: keyless metadata mirrors ---- */
  async function searchOneMirror(mirror, query, limit) {
    if (mirror.kind === 'piped') {
      const url = `${mirror.base}/search?q=${encodeURIComponent(query)}&filter=music_songs`;
      const res = await L.fetchJSON(url, { timeout: 7000 });
      const items = (res.items || res || []);
      return items
        .filter((it) => it && (it.url || it.id))
        .map((it) => {
          const videoId = it.url ? (it.url.split('v=')[1] || '').split('&')[0] : it.id;
          return makeTrack({
            videoId,
            title: it.title,
            artist: it.uploaderName || it.uploader,
            artwork: it.thumbnail,
            duration: it.duration,
            views: it.views,
          });
        })
        .filter(Boolean)
        .slice(0, limit);
    }

    // Invidious
    const url = `${mirror.base}/api/v1/search?q=${encodeURIComponent(query)}&type=video&sort_by=relevance`;
    const res = await L.fetchJSON(url, { timeout: 7000 });
    return (Array.isArray(res) ? res : [])
      .map((it) => makeTrack({
        videoId: it.videoId,
        title: it.title,
        artist: it.author,
        artwork: (it.videoThumbnails && it.videoThumbnails.find((t) => t.quality === 'medium') || {}).url,
        duration: it.lengthSeconds,
        views: it.viewCount,
      }))
      .filter(Boolean)
      .slice(0, limit);
  }

  /**
   * Races a batch of mirrors and resolves with the first non-empty result.
   * Querying them one at a time would stack every timeout, so a dead list
   * could take well over a minute before reporting failure.
   */
  function raceMirrors(batch, query, limit, tried) {
    return new Promise((resolve, reject) => {
      let pending = batch.length;
      let settled = false;
      if (!pending) { reject(new Error('no mirrors')); return; }

      const fail = (mirror, reason) => {
        tried.push(`${mirror.base} — ${reason}`);
        pending -= 1;
        if (pending === 0 && !settled) reject(new Error('batch exhausted'));
      };

      batch.forEach((mirror) => {
        searchOneMirror(mirror, query, limit)
          .then((results) => {
            if (settled) return;
            if (results && results.length) {
              settled = true;
              L.storage.set(MIRROR_KEY, { kind: mirror.kind, base: mirror.base });
              resolve(results);
            } else {
              fail(mirror, 'no results');
            }
          })
          .catch((err) => { if (!settled) fail(mirror, err.message); });
      });
    });
  }

  async function searchViaMirrors(query, limit) {
    const all = mirrorList();
    const tried = [];
    const BATCH = 5;

    for (let i = 0; i < all.length; i += BATCH) {
      try {
        return await raceMirrors(all.slice(i, i + BATCH), query, limit, tried);
      } catch (e) { /* whole batch failed, try the next */ }
    }

    const e = new Error('No YouTube metadata service responded. These are community-run and go offline often — adding your own API key in Settings makes search reliable.');
    e.code = 'yt-mirrors';
    e.tried = tried;
    throw e;
  }

  /**
   * Trending music from the mirrors (the official API's chart endpoint
   * needs a key, and charts are not worth 100 quota units per load).
   */
  async function trending({ region = 'US', limit = 20 } = {}) {
    const cacheKey = `yttrending:${region}`;
    const cached = L.storage.session.get(cacheKey, null);
    if (cached && cached.length) return cached;

    /** One mirror's attempt, so several can be raced rather than queued. */
    const fromMirror = async (mirror) => {
      let items = [];
      if (mirror.kind === 'piped') {
        const res = await L.fetchJSON(`${mirror.base}/trending?region=${encodeURIComponent(region)}`, { timeout: 7000 });
        items = (Array.isArray(res) ? res : []).map((it) => makeTrack({
          videoId: it.url ? (it.url.split('v=')[1] || '').split('&')[0] : it.id,
          title: it.title,
          artist: it.uploaderName || it.uploader,
          artwork: it.thumbnail,
          duration: it.duration,
          views: it.views,
        }));
      } else {
        const res = await L.fetchJSON(`${mirror.base}/api/v1/trending?type=Music&region=${encodeURIComponent(region)}`, { timeout: 7000 });
        items = (Array.isArray(res) ? res : []).map((it) => makeTrack({
          videoId: it.videoId,
          title: it.title,
          artist: it.author,
          artwork: (it.videoThumbnails && it.videoThumbnails.find((t) => t.quality === 'medium') || {}).url,
          duration: it.lengthSeconds,
          views: it.viewCount,
        }));
      }
      const clean = items.filter(Boolean).slice(0, limit);
      if (!clean.length) throw new Error('empty');
      return clean;
    };

    /* These mirrors are community-run and frequently dead. Trying them one at a
       time meant up to fourteen sequential 7-second timeouts — about a minute and
       a half of an empty home row. Race them in batches instead, the way search
       already does. */
    const all = mirrorList();
    const BATCH = 5;
    for (let i = 0; i < all.length; i += BATCH) {
      const batch = all.slice(i, i + BATCH);
      try {
        const clean = await Promise.any(batch.map(fromMirror));
        L.storage.session.set(cacheKey, clean);
        return clean;
      } catch (e) { /* every mirror in this batch failed; try the next */ }
    }
    throw new Error('Could not load YouTube trending right now.');
  }

  /**
   * Diagnostic for Settings: reports which search sources actually work,
   * so a dead mirror list can be identified without guesswork.
   */
  async function testSources() {
    const out = [];

    if (apiKey()) {
      const started = Date.now();
      try {
        const r = await searchViaApi('music', 1);
        out.push({ label: 'Official YouTube API key', ok: true, detail: `${r.length} result${r.length === 1 ? '' : 's'} · ${Date.now() - started}ms` });
      } catch (err) {
        out.push({ label: 'Official YouTube API key', ok: false, detail: err.message });
      }
    } else {
      out.push({ label: 'Official YouTube API key', ok: null, detail: 'Not set — using public mirrors' });
    }

    const checks = await Promise.all(mirrorList().map(async (mirror) => {
      const started = Date.now();
      try {
        const r = await searchOneMirror(mirror, 'music', 1);
        return r.length
          ? { label: mirror.base, ok: true, detail: `${Date.now() - started}ms` }
          : { label: mirror.base, ok: false, detail: 'responded but returned nothing' };
      } catch (err) {
        return { label: mirror.base, ok: false, detail: err.message };
      }
    }));

    return out.concat(checks);
  }

  /**
   * Search YouTube for songs.
   * @returns {Promise<Array>} normalized, playable tracks
   */
  async function search(query, { limit = 24, fresh = false } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];

    // Repeat searches are common (navigating back, retrying); caching them for
    // the session keeps the API key's 100-a-day quota for genuinely new queries.
    const cacheKey = 'ytsearch:' + q.toLowerCase();
    if (!fresh) {
      const cached = L.storage.session.get(cacheKey, null);
      if (cached && cached.length) return cached;
    }

    let results;
    if (apiKey()) {
      try {
        results = await searchViaApi(q, limit);
      } catch (err) {
        if (err.code === 'yt-key') throw err;        // key problems must surface
        results = await searchViaMirrors(q, limit);  // transient: fall back
      }
    } else {
      results = await searchViaMirrors(q, limit);
    }

    if (results && results.length) L.storage.session.set(cacheKey, results);
    return results;
  }

  /**
   * Resolve the top video for a search phrase using the official IFrame
   * player's search playlist. This needs no API key and no third-party
   * mirror, which makes it the most dependable way to turn "song name"
   * into something playable — so it backstops every other route.
   *
   * A throwaway hidden player is used purely as a resolver; the video is
   * then played normally, keeping Loru's own queue in control instead of
   * letting YouTube auto-advance through search results.
   */
  async function resolveSearchTopResult(query) {
    const YT = await ensureApi();

    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:200px;height:120px;';
    const mount = document.createElement('div');
    holder.appendChild(mount);
    document.body.appendChild(holder);

    return new Promise((resolve, reject) => {
      let settled = false;
      let player = null;
      let poll = null;

      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (poll) clearInterval(poll);
        try { player && player.destroy(); } catch (e) {}
        holder.remove();
        fn();
      };

      const timer = setTimeout(
        () => finish(() => reject(new Error('YouTube did not answer that search in time.'))),
        15000,
      );

      player = new YT.Player(mount, {
        height: '120', width: '200',
        playerVars: {
          listType: 'search', list: query,
          autoplay: 0, controls: 0, origin: location.origin,
        },
        events: {
          onReady() {
            let tries = 0;
            poll = setInterval(() => {
              tries += 1;
              let data = null;
              let list = null;
              try { data = player.getVideoData(); list = player.getPlaylist(); } catch (e) {}
              const videoId = (data && data.video_id) || (Array.isArray(list) && list[0]) || null;

              if (videoId) {
                finish(() => resolve({
                  videoId,
                  title: (data && data.title) || null,
                  artist: (data && data.author) || null,
                }));
              } else if (tries > 28) {
                finish(() => reject(new Error('YouTube returned no results for that search.')));
              }
            }, 250);
          },
          onError(e) {
            finish(() => reject(new Error(`YouTube refused that search (code ${e && e.data}).`)));
          },
        },
      });
    });
  }

  /**
   * Best playable match for a title/artist. Tries the metadata routes for
   * richer results, then falls back to the key-less official resolver so a
   * song stays playable even with no API key and every mirror down.
   */
  async function findMatch(title, artist) {
    const query = `${title} ${artist}`.trim();

    try {
      const results = await search(query, { limit: 5 });
      if (results.length) {
        const want = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        return results.find((t) => t.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().includes(want))
          || results[0];
      }
    } catch (e) { /* fall through to the official resolver */ }

    const top = await resolveSearchTopResult(query).catch(() => null);
    if (!top) return null;
    return makeTrack({
      videoId: top.videoId,
      title: top.title || title,
      artist: top.artist || artist,
    });
  }

  L.youtube = {
    parse, thumb, watchUrl, ensureApi, fetchMeta, cleanTitle, toTrack,
    resolvePlaylist, resolveVideo, hydrateTracks, searchUrl,
    search, findMatch, resolveSearchTopResult, trending,
    mirrorList, testSources, DEFAULT_MIRRORS,
  };
})(window.Loru);
