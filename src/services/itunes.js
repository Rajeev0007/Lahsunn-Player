/* ============================================================
   Loru Player — services/itunes.js
   Apple's iTunes Search API: no key, no account, huge catalogue.

   What this gives you: excellent metadata and artwork, and a
   30-second preview that plays instantly and ad-free.

   What it cannot give you: full tracks. Apple Music full playback
   needs MusicKit with a paid Apple Developer token plus the
   listener's own subscription. So Loru uses Apple for accurate
   search results, then offers one tap to hear the full song from
   YouTube.

   The endpoint is inconsistent about CORS headers, so a JSONP
   fallback is included — the API supports a `callback` parameter.
   ============================================================ */
(function (L) {
  'use strict';

  const ENDPOINT = 'https://itunes.apple.com/search';

  /* ---------------- transport ---------------- */

  /** Loads via <script> using the API's callback parameter. */
  function jsonp(url, { timeout = 9000 } = {}) {
    return new Promise((resolve, reject) => {
      const name = '__loruItunes' + Math.random().toString(36).slice(2, 9);
      const script = document.createElement('script');

      const cleanup = () => {
        delete window[name];
        script.remove();
        clearTimeout(timer);
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Apple search timed out.')); }, timeout);

      window[name] = (data) => { cleanup(); resolve(data); };
      script.onerror = () => { cleanup(); reject(new Error('Apple search could not be reached.')); };
      script.src = `${url}&callback=${name}`;
      document.head.appendChild(script);
    });
  }

  async function request(params) {
    const qs = new URLSearchParams(params).toString();
    const url = `${ENDPOINT}?${qs}`;
    try {
      return await L.fetchJSON(url, { timeout: 9000 });
    } catch (e) {
      return jsonp(url);   // CORS blocked or network hiccup
    }
  }

  /* ---------------- normalisation ---------------- */

  function normalize(item) {
    if (!item || item.kind !== 'song' || !item.trackId) return null;
    return {
      id: 'itunes-' + item.trackId,
      source: 'itunes',
      title: item.trackName || 'Untitled',
      artist: item.artistName || 'Unknown artist',
      album: item.collectionName || '',
      genre: item.primaryGenreName || '',
      // 100px is the default; ask for something worth looking at
      artwork: (item.artworkUrl100 || '').replace('100x100bb', '512x512bb') || null,
      duration: Math.round((item.trackTimeMillis || 0) / 1000),
      previewUrl: item.previewUrl || null,
      streamUrl: item.previewUrl || null,   // playable immediately as a preview
      permalink: item.trackViewUrl || null,
      explicit: item.trackExplicitness === 'explicit',
      releaseDate: item.releaseDate || null,
      previewOnly: true,                    // flags the 30-second limitation
    };
  }

  /* ---------------- public API ---------------- */

  /**
   * Search Apple's music catalogue.
   * @returns {Promise<Array>} tracks playable as 30-second previews
   */
  async function search(query, { limit = 24, country = 'US' } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];

    const res = await request({
      term: q, media: 'music', entity: 'song', limit: String(limit), country,
    });

    return ((res && res.results) || []).map(normalize).filter((t) => t && t.previewUrl);
  }

  /** Best metadata match — useful for artwork and canonical titles. */
  async function lookup(title, artist) {
    const results = await search(`${title} ${artist}`.trim(), { limit: 5 }).catch(() => []);
    if (!results.length) return null;
    const want = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return results.find((t) => t.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === want) || results[0];
  }

  /**
   * Apple's public "most played" feed. Returns chart entries, which carry no
   * preview URL, so each is matched back through Search to become playable.
   */
  async function topSongs({ limit = 16, country = 'us' } = {}) {
    const cached = L.storage.session.get('itunes:top', null);
    if (cached && cached.length) return cached;

    const feed = await L.fetchJSON(
      `https://rss.applemarketingtools.com/api/v2/${country}/music/most-played/${limit}/songs.json`,
      { timeout: 9000 },
    );
    const entries = (feed && feed.feed && feed.feed.results) || [];
    if (!entries.length) return [];

    // Resolve previews in small batches so the row fills quickly
    const out = [];
    for (let i = 0; i < entries.length; i += 4) {
      const batch = entries.slice(i, i + 4);
      const found = await Promise.all(batch.map((e) => lookup(e.name, e.artistName).catch(() => null)));
      found.forEach((t, j) => {
        if (t) out.push(t);
        else if (batch[j]) {
          // Keep the chart entry even without a preview; the ⋯ menu can still
          // play the full song from YouTube.
          out.push({
            id: 'itunes-chart-' + batch[j].id,
            source: 'itunes',
            title: batch[j].name,
            artist: batch[j].artistName,
            album: '',
            artwork: (batch[j].artworkUrl100 || '').replace('100x100bb', '512x512bb') || null,
            duration: 0,
            previewUrl: null,
            permalink: batch[j].url || null,
            previewOnly: true,
            needsMatch: true,
          });
        }
      });
    }

    if (out.length) L.storage.session.set('itunes:top', out);
    return out;
  }

  L.itunes = { search, lookup, topSongs, normalize };
})(window.Loru);
