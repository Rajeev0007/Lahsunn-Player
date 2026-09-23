/* ============================================================
   Loru Player — content/data.js
   The single place that decides *where* music comes from.

   Views ask for "charts" or "a mix" or "recommendations" and this
   layer picks the service, handles fallbacks and normalises the
   result. Nothing here touches the DOM.
   ============================================================ */
(function (L) {
  'use strict';

  const { store, catalog, audius, youtube, spotify } = L;

  /** Drop duplicates by title+artist, which differ per service. */
  function dedupe(tracks) {
    const seen = new Set();
    return (tracks || []).filter((t) => {
      if (!t || !t.title) return false;
      const key = `${t.title}|${t.artist}`.toLowerCase().replace(/[^a-z0-9|]+/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Round-robin merge so no single service dominates a row. */
  function interleave(lists) {
    const out = [];
    const max = Math.max(0, ...lists.map((l) => (l ? l.length : 0)));
    for (let i = 0; i < max; i++) {
      lists.forEach((list) => { if (list && list[i]) out.push(list[i]); });
    }
    return out;
  }

  const data = {
    /* ---------------- mode ---------------- */
    get demo() { return !!store.state.settings.demoMode; },
    get source() { return store.state.settings.defaultSource || 'youtube'; },
    get spotifyReady() { return !!store.state.connections.spotify.connected; },

    /** Adds the sample playlists / history so every screen has content. */
    seed() {
      catalog.demo.activate();
      const known = new Set(store.state.playlists.map((p) => p.id));
      const missing = catalog.demo.playlists.filter((p) => !known.has(p.id));
      const patch = {};
      if (missing.length) patch.playlists = [...missing, ...store.state.playlists];
      if (!store.state.liked.some((t) => t.source === 'demo')) {
        patch.liked = [...catalog.demo.tracks.slice(0, 6).map((t) => ({ ...t, likedAt: Date.now() })), ...store.state.liked];
      }
      if (!store.state.recents.some((t) => t.source === 'demo')) {
        patch.recents = [...catalog.demo.tracks.slice(6, 14).map((t, i) => ({ ...t, playedAt: Date.now() - i * 36e5 })), ...store.state.recents];
      }
      if (Object.keys(patch).length) store.set(patch);
    },

    enableDemo() {
      store.updateSettings({ demoMode: true });
      this.seed();
      L.toast({ kind: 'success', title: 'Demo content enabled', text: 'Explore the full interface without a connection.' });
      L.views.render(store.state.route, true);
    },

    disableDemo() {
      store.updateSettings({ demoMode: false });
      store.set({
        playlists: store.state.playlists.filter((p) => p.source !== 'demo'),
        liked: store.state.liked.filter((t) => t.source !== 'demo'),
        recents: store.state.recents.filter((t) => t.source !== 'demo'),
      });
      L.views.render(store.state.route, true);
    },

    /* ---------------- per-service fetchers ---------------- */
    fetchers: {
      youtube: (limit) => youtube.trending({ limit }),
      apple: (limit) => L.itunes.topSongs({ limit }),
      audius: (limit) => audius.trending({ limit }),
    },

    searchers: {
      youtube: (q, limit) => youtube.search(q, { limit }),
      apple: (q, limit) => L.itunes.search(q, { limit }),
      audius: (q, limit) => audius.searchTracks(q, { limit }),
    },

    /** Selected source first, then the rest, so a row is never empty. */
    order() {
      return [this.source, 'youtube', 'apple', 'audius'].filter((s, i, a) => a.indexOf(s) === i);
    },

    /* ---------------- charts ---------------- */
    async charts({ limit = 16 } = {}) {
      if (this.demo) { catalog.demo.activate(); return { source: 'demo', tracks: catalog.demo.trending(14) }; }

      let lastError = null;
      for (const src of this.order()) {
        try {
          const tracks = await this.fetchers[src](limit);
          if (tracks && tracks.length) return { source: src, tracks: dedupe(tracks) };
        } catch (e) { lastError = e; }
      }
      throw lastError || new Error('No music service responded.');
    },

    /**
     * Trending pulled from every service at once. Used for the main home row
     * so it reflects more than a single platform's idea of popular.
     */
    async trendingEverywhere({ limit = 18 } = {}) {
      if (this.demo) { catalog.demo.activate(); return { tracks: catalog.demo.trending(14), sources: ['demo'] }; }

      /* Called through a helper rather than inline: `fetchers[src](12)` throws
         synchronously if src is not a known fetcher (a stale or hand-edited
         defaultSource), and a synchronous throw happens before .catch() can
         apply, rejecting the whole row instead of degrading. */
      const fetch = (src, n) => {
        const fn = this.fetchers[src];
        if (!fn) return Promise.resolve([]);
        try { return Promise.resolve(fn(n)).catch(() => []); } catch (e) { return Promise.resolve([]); }
      };

      const jobs = [
        fetch(this.source, 12),
        ...this.order().slice(1, 3).map((s) => fetch(s, 8)),
      ];
      if (this.spotifyReady) jobs.push(spotify.newReleases({ limit: 8 }).catch(() => []));

      const lists = await Promise.all(jobs);
      const tracks = dedupe(interleave(lists)).slice(0, limit);
      if (!tracks.length) throw new Error('No music service responded.');

      const sources = [...new Set(tracks.map((t) => t.source))];
      return { tracks, sources };
    },

    /** New releases plus the listener's own top tracks. */
    async spotifyPicks({ limit = 14 } = {}) {
      if (!this.spotifyReady) return null;
      const [fresh, top] = await Promise.all([
        spotify.newReleases({ limit: 8 }).catch(() => []),
        spotify.topTracks({ limit: 10 }).catch(() => []),
      ]);
      const tracks = dedupe(interleave([top, fresh])).slice(0, limit);
      return tracks.length ? tracks : null;
    },

    /* ---------------- recommendations ---------------- */
    /**
     * Spotify retired its /recommendations endpoint for new apps, so this is
     * built locally: the artists you actually play become search seeds, and
     * anything already in your history is filtered out.
     *
     * @returns {Promise<{tracks:Array, seeds:Array<string>}|null>}
     */
    async recommendations({ limit = 18 } = {}) {
      if (this.demo) {
        catalog.demo.activate();
        return { tracks: catalog.demo.trending(18).slice().reverse(), seeds: ['your demo history'] };
      }

      const known = new Set(
        [...store.state.liked, ...store.state.recents]
          .map((t) => `${t.title}|${t.artist}`.toLowerCase().replace(/[^a-z0-9|]+/g, '')),
      );

      const seeds = await this.seedArtists();
      const search = this.searchers[this.source] || this.searchers.youtube;
      const picked = seeds.slice(0, 4);
      const lists = await Promise.all(picked.map((artist) =>
        search(artist, 6).catch(() => [])));
      const labels = picked.slice();

      /* Spotify's own /recommendations is gone for apps registered after
         November 2024, but the endpoints that still exist are better signals
         than an artist-name search: short_term top tracks are literally "what
         you have played lately", and new-releases is the freshest catalogue
         Spotify will hand out. Blend both in when connected. */
      if (this.spotifyReady) {
        const [recent, fresh] = await Promise.all([
          spotify.topTracks({ limit: 12, range: 'short_term' }).catch(() => []),
          spotify.newReleases({ limit: 8 }).catch(() => []),
        ]);
        if (recent.length) { lists.unshift(recent); labels.unshift('your recent Spotify plays'); }
        if (fresh.length) { lists.push(fresh); labels.push('new on Spotify'); }
      }

      /* Only now give up: with Spotify connected there is something to show even
         on a first run, which the old seeds-only guard ruled out. */
      if (!lists.some((l) => l.length)) return null;

      const tracks = dedupe(interleave(lists))
        .filter((t) => !known.has(`${t.title}|${t.artist}`.toLowerCase().replace(/[^a-z0-9|]+/g, '')))
        .slice(0, limit);

      return tracks.length ? { tracks, seeds: labels.slice(0, 5) } : null;
    },

    /** Most frequent artists across likes, history and Spotify tops. */
    async seedArtists() {
      const counts = new Map();
      const bump = (name, weight) => {
        const key = String(name || '').trim();
        if (!key || /^(youtube|various artists|unknown artist)$/i.test(key)) return;
        counts.set(key, (counts.get(key) || 0) + weight);
      };

      store.state.liked.forEach((t) => bump(t.artist, 3));
      store.state.recents.slice(0, 30).forEach((t) => bump(t.artist, 2));
      store.state.playlists.forEach((p) => (p.tracks || []).slice(0, 20).forEach((t) => bump(t.artist, 1)));

      if (this.spotifyReady) {
        try {
          (await spotify.topArtists({ limit: 10 })).forEach((a) => bump(a.name, 4));
        } catch (e) { /* optional */ }
      }

      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name);
    },

    /* ---------------- search / mixes ---------------- */
    async mix(query, { limit = 24 } = {}) {
      if (this.demo) { catalog.demo.activate(); return catalog.demo.search(query); }

      let lastError = null;
      for (const src of this.order()) {
        try {
          const tracks = await this.searchers[src](query, limit);
          if (tracks && tracks.length) return dedupe(tracks);
        } catch (e) { lastError = e; }
      }
      throw lastError || new Error('No music service responded.');
    },

    async searchTracks(q) {
      if (this.demo) { catalog.demo.activate(); return catalog.demo.search(q); }
      return audius.searchTracks(q, { limit: 30 });
    },

    async searchPlaylists(q) {
      if (this.demo) return [];
      return audius.searchPlaylists(q, { limit: 10 });
    },

    async searchUsers(q) {
      if (this.demo) return [];
      return audius.searchUsers(q, { limit: 8 });
    },

    async trending(genre) {
      if (this.demo) {
        catalog.demo.activate();
        return genre ? catalog.demo.byGenre(genre) : catalog.demo.trending(14);
      }
      /* Genres used to be hardcoded to Audius, which is why every genre page
         looked like nothing but obscure independent releases regardless of the
         chosen source. Search the selected service by genre name and keep Audius
         as the fallback, since it is the only one with a real genre filter. */
      if (genre) {
        const search = this.searchers[this.source];
        if (search && this.source !== 'audius') {
          const tracks = await search(genre, 14).catch(() => []);
          if (tracks.length) return tracks;
        }
        return audius.trending({ genre, limit: 14 });
      }
      return audius.trending({ limit: 14 });
    },

    /**
     * Newest independent releases. home.js has always called this; it was never
     * implemented, so that row rendered "data.underground is not a function"
     * every single load.
     */
    async underground({ limit = 20 } = {}) {
      if (this.demo) { catalog.demo.activate(); return catalog.demo.trending(12); }
      return audius.underground({ limit });
    },
  };

  L.data = data;
})(window.Loru);
