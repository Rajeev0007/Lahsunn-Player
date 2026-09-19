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

  /** Search fallback: we cannot query the Data API without a key, so we
      hand the user a ready-made search URL instead of failing silently. */
  function searchUrl(query) {
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  }

  L.youtube = {
    parse, thumb, watchUrl, ensureApi, fetchMeta, cleanTitle, toTrack,
    resolvePlaylist, resolveVideo, hydrateTracks, searchUrl,
  };
})(window.Loru);
