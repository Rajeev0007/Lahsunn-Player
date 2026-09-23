/* ============================================================
   Loru Player — services/lyrics.js
   Time-synced lyrics from LRCLIB (https://lrclib.net), a free
   public API with no key and no rate limit.

   Lyrics are fetched at runtime and never bundled with the app:
   the text belongs to its rights holders, so Loru only displays
   what the API returns and caches it for the session.
   ============================================================ */
(function (L) {
  'use strict';

  const API = 'https://lrclib.net/api';
  const CACHE_PREFIX = 'lyrics:';

  /* ---------------- query preparation ---------------- */

  /**
   * YouTube titles are messy ("Artist - Song (Official Video) [4K]"), and the
   * uploader is often a channel rather than the artist. LRCLIB needs a clean
   * artist/track pair, so derive the best guess we can.
   */
  function normalizeQuery(track) {
    if (!track) return null;

    let title = String(track.title || '').trim();
    let artist = String(track.artist || '').trim();

    // strip bracketed noise and common suffixes
    title = title
      .replace(/\s*[\(\[][^)\]]*(official|lyric|audio|video|visuali[sz]er|hd|4k|remaster\w*|mv|m\/v|full song|slowed|reverb)[^)\]]*[\)\]]/gi, '')
      .replace(/\s*\|.*$/, '')
      .trim();

    // "Artist - Song" in the title is more reliable than a channel name
    const dashed = title.split(/\s+[-–—]\s+/);
    if (dashed.length >= 2) {
      const looksLikeChannel = !artist
        || /youtube|topic|vevo|records|music|official|tv|channel/i.test(artist);
      if (looksLikeChannel) {
        artist = dashed[0].trim();
        title = dashed.slice(1).join(' - ').trim();
      } else if (dashed[0].toLowerCase().includes(artist.toLowerCase().slice(0, 6))) {
        title = dashed.slice(1).join(' - ').trim();
      }
    }

    artist = artist.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();

    // drop featured-artist clutter that rarely matches
    title = title.replace(/\s*\b(feat|ft|featuring)\b\.?.*$/i, '').trim();

    if (!title) return null;
    return { title, artist, duration: Math.round(track.duration || 0), album: track.album || '' };
  }

  function cacheKey(q) {
    return `${CACHE_PREFIX}${q.artist.toLowerCase()}|${q.title.toLowerCase()}`;
  }

  /* ---------------- LRC parsing ---------------- */

  /**
   * Parse an LRC body into ordered { time, text } lines.
   * Handles multiple timestamps per line and the [offset:] tag.
   */
  function parseLRC(lrc) {
    const lines = [];
    let offset = 0;

    String(lrc || '').split(/\r?\n/).forEach((raw) => {
      const offsetTag = /^\[offset:\s*([+-]?\d+)\s*\]/i.exec(raw);
      if (offsetTag) { offset = Number(offsetTag[1]) / 1000; return; }

      const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
      if (!stamps.length) return;

      const text = raw.replace(/\[[^\]]*\]/g, '').trim();
      stamps.forEach((m) => {
        const fraction = m[3] ? Number(('0.' + m[3])) : 0;
        const time = Number(m[1]) * 60 + Number(m[2]) + fraction + offset;
        lines.push({ time: Math.max(0, time), text });
      });
    });

    lines.sort((a, b) => a.time - b.time);

    // Collapse repeated blanks so instrumental gaps render as one break
    return lines.filter((line, i) => !(line.text === '' && lines[i - 1] && lines[i - 1].text === ''));
  }

  function parsePlain(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map((t) => ({ time: null, text: t.trim() }));
  }

  /* ---------------- fetching ---------------- */

  async function lookup(q) {
    // Exact match first: artist + track + duration gives the best sync
    const params = new URLSearchParams({ artist_name: q.artist || '', track_name: q.title });
    if (q.album) params.set('album_name', q.album);
    if (q.duration) params.set('duration', String(q.duration));

    try {
      const res = await L.fetchJSON(`${API}/get?${params}`, { timeout: 9000 });
      if (res && (res.syncedLyrics || res.plainLyrics || res.instrumental)) return res;
    } catch (err) {
      if (err.status && err.status !== 404) throw err;
    }

    // Fall back to a fuzzy search and take the closest duration
    const searchParams = new URLSearchParams({ track_name: q.title });
    if (q.artist) searchParams.set('artist_name', q.artist);

    const results = await L.fetchJSON(`${API}/search?${searchParams}`, { timeout: 9000 });
    if (!Array.isArray(results) || !results.length) return null;

    const withLyrics = results.filter((r) => r.syncedLyrics || r.plainLyrics || r.instrumental);
    if (!withLyrics.length) return null;

    if (q.duration) {
      withLyrics.sort((a, b) =>
        Math.abs((a.duration || 0) - q.duration) - Math.abs((b.duration || 0) - q.duration));
    }
    // Prefer a synced result even if its duration is slightly further off
    return withLyrics.find((r) => r.syncedLyrics) || withLyrics[0];
  }

  /**
   * Get lyrics for a track.
   * @returns {Promise<{kind:'synced'|'plain'|'instrumental', lines:Array, source:string, matched:object}|null>}
   */
  async function get(track) {
    const q = normalizeQuery(track);
    if (!q) return null;

    const key = cacheKey(q);
    const cached = L.storage.session.get(key, undefined);
    if (cached !== undefined) return cached;

    let result = null;
    try {
      const hit = await lookup(q);
      if (hit) {
        if (hit.instrumental && !hit.syncedLyrics && !hit.plainLyrics) {
          result = { kind: 'instrumental', lines: [], source: 'LRCLIB', matched: hit };
        } else if (hit.syncedLyrics) {
          const lines = parseLRC(hit.syncedLyrics);
          result = lines.length
            ? { kind: 'synced', lines, source: 'LRCLIB', matched: hit }
            : { kind: 'plain', lines: parsePlain(hit.plainLyrics), source: 'LRCLIB', matched: hit };
        } else if (hit.plainLyrics) {
          result = { kind: 'plain', lines: parsePlain(hit.plainLyrics), source: 'LRCLIB', matched: hit };
        }
      }
    } catch (err) {
      // Network failures should not be cached as "no lyrics"
      const e = new Error('Could not reach the lyrics service.');
      e.cause = err;
      throw e;
    }

    L.storage.session.set(key, result);
    return result;
  }

  /** Index of the line that should be highlighted at `position` seconds. */
  function activeIndex(lines, position) {
    if (!lines || !lines.length || lines[0].time === null) return -1;
    let lo = 0;
    let hi = lines.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= position) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return found;
  }

  L.lyrics = { get, parseLRC, parsePlain, normalizeQuery, activeIndex };
})(window.Loru);
