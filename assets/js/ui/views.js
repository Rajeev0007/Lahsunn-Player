/* ============================================================
   Loru Player — ui/views.js
   Every screen in the app + the data helpers they need
   ============================================================ */
(function (L) {
  'use strict';

  const {
    el, icon, $, store, engine, ui, audius, youtube, spotify, importer, catalog,
    toast, formatTime, formatTotal, formatCount, pluralize, relativeTime, setArt, debounce,
  } = L;

  /* ============================================================
     Data helpers — demo mode aware
     ============================================================ */
  const data = {
    get demo() { return !!store.state.settings.demoMode; },

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
      toast({ kind: 'success', title: 'Demo content enabled', text: 'Explore the full interface without a connection.' });
      render(store.state.route, true);
    },

    /** Removes everything the demo added, leaving real user data intact. */
    disableDemo() {
      store.updateSettings({ demoMode: false });
      store.set({
        playlists: store.state.playlists.filter((p) => p.source !== 'demo'),
        liked: store.state.liked.filter((t) => t.source !== 'demo'),
        recents: store.state.recents.filter((t) => t.source !== 'demo'),
      });
      render(store.state.route, true);
    },

    get youtubeFirst() { return store.state.settings.defaultSource !== 'audius'; },

    async trending(genre) {
      if (this.demo) {
        catalog.demo.activate();
        return genre ? catalog.demo.byGenre(genre) : catalog.demo.trending(14);
      }
      return genre ? audius.trending({ genre, limit: 14 }) : audius.trending({ limit: 14 });
    },

    /** Charts for the home screen — YouTube first, Audius as the backstop. */
    async charts() {
      if (this.demo) { catalog.demo.activate(); return { source: 'demo', tracks: catalog.demo.trending(14) }; }
      if (this.youtubeFirst) {
        try {
          return { source: 'youtube', tracks: await youtube.trending({ limit: 16 }) };
        } catch (e) { /* fall back to Audius so the row still fills */ }
      }
      return { source: 'audius', tracks: await audius.trending({ limit: 14 }) };
    },

    /** A themed mix: YouTube search when it is the default source. */
    async mix(query) {
      if (this.demo) { catalog.demo.activate(); return catalog.demo.search(query); }
      if (this.youtubeFirst) {
        try {
          const tracks = await youtube.search(query, { limit: 24 });
          if (tracks.length) return tracks;
        } catch (e) { /* fall through */ }
      }
      return audius.searchTracks(query, { limit: 30 });
    },

    async underground() {
      if (this.demo) { catalog.demo.activate(); return catalog.demo.trending(14).slice().reverse(); }
      return audius.underground({ limit: 14 });
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
  };

  /* ============================================================
     Small shared pieces
     ============================================================ */

  /** Render an async block with skeleton → content → error states. */
  function asyncBlock(loader, render, { skeleton, onEmpty, onError } = {}) {
    const host = el('div');
    host.appendChild(skeleton || ui.skeletonCards(6));

    let cancelled = false;
    host.addEventListener('loru:cancel', () => { cancelled = true; });

    function run() {
      host.replaceChildren(skeleton ? skeleton.cloneNode(true) : ui.skeletonCards(6));
      Promise.resolve()
        .then(loader)
        .then((result) => {
          if (cancelled) return;
          const empty = !result || (Array.isArray(result) && !result.length);
          host.replaceChildren(empty
            ? (onEmpty ? onEmpty() : ui.emptyState({ title: 'Nothing here yet' }))
            : render(result));
        })
        .catch((err) => {
          if (cancelled) return;
          host.replaceChildren(onError ? onError(err, run) : offlineState(err, run));
        });
    }
    run();
    return host;
  }

  function offlineState(err, retry) {
    const message = (err && err.message) || 'Something went wrong.';
    const looksOffline = /failed to fetch|networkerror|load failed|abort|timeout|http 0/i.test(message) || !navigator.onLine;
    return ui.emptyState({
      icon: looksOffline ? 'globe' : 'info',
      title: looksOffline ? 'No connection to the music services' : 'Couldn’t load that',
      text: looksOffline
        ? 'Loru streams everything from the web, so it needs a live connection. You can still explore the interface with demo content.'
        : message,
      actions: [
        { label: 'Try again', icon: 'repeat', variant: 'soft', onClick: retry },
        !data.demo ? { label: 'Use demo content', icon: 'sparkle', variant: 'primary', onClick: () => data.enableDemo() } : null,
      ].filter(Boolean),
    });
  }

  /**
   * YouTube search can fail in two distinct ways, and the fix differs:
   * a bad/exhausted API key, or every keyless mirror being down.
   */
  function youtubeSearchError(err, retry, query) {
    const isKey = err.code === 'yt-key';
    if (err.tried) console.info('[Loru] YouTube mirrors tried:', err.tried);

    return ui.emptyState({
      compact: true,
      icon: 'youtube',
      title: isKey ? 'YouTube API key problem' : 'Can’t list results right now',
      text: `${err.message} You can still play the song directly — that route needs no key or mirror.`,
      actions: [
        { label: `Play “${query.length > 28 ? query.slice(0, 28) + '…' : query}”`, icon: 'play', variant: 'primary', onClick: () => playTopResult(query) },
        { label: 'Try again', icon: 'repeat', variant: 'soft', onClick: retry },
        { label: isKey ? 'Fix key' : 'Add an API key', icon: 'settings', onClick: () => { location.hash = '#/settings'; } },
      ],
    });
  }

  /**
   * Plays the top YouTube result for a phrase via the official player.
   * Independent of API keys and mirrors, so it is the reliable last resort
   * for "just play this song".
   */
  async function playTopResult(query) {
    const close = toast({ title: 'Finding that song…', text: query, timeout: 0 });
    try {
      const top = await youtube.resolveSearchTopResult(query);
      close();
      const track = youtube.toTrack(top.videoId, {
        title: top.title || query,
        artist: top.artist || 'YouTube',
      });
      engine.playTrack(track, { type: 'search', id: query, name: `Search: ${query}` });
      toast({ kind: 'success', title: 'Playing', text: track.title, timeout: 2600 });
    } catch (err) {
      close();
      toast({
        kind: 'error', title: 'Couldn’t find that song', text: err.message, timeout: 6000,
        action: { label: 'Open YouTube', onClick: () => window.open(youtube.searchUrl(query), '_blank', 'noopener') },
      });
    }
  }

  function trackRail(tracks, context) {
    return el('div.rail', tracks.map((t, i) => ui.mediaCard({
      title: t.title,
      sub: t.artist,
      artwork: t.artwork,
      badge: t.source,
      seed: t.title + t.artist,
      onOpen: () => engine.playCollection(tracks, i, context),
      onPlay: () => engine.playCollection(tracks, i, context),
    })));
  }

  function playlistCard(pl, { onOpen, onPlay } = {}) {
    return ui.mediaCard({
      title: pl.name,
      sub: pl.description ? pl.description.slice(0, 64) : (pl.owner ? `By ${pl.owner}` : pluralize(pl.trackCount || (pl.tracks || []).length, 'track')),
      artwork: pl.artwork || (pl.tracks && pl.tracks[0] && pl.tracks[0].artwork),
      badge: pl.source,
      seed: pl.name,
      onOpen, onPlay,
    });
  }

  /* ============================================================
     HOME
     ============================================================ */
  function viewHome() {
    const view = el('div.view');
    const hasLibrary = store.state.playlists.length || store.state.liked.length || store.state.recents.length;

    /* ---- hero ---- */
    view.appendChild(el('section.hero', el('div.hero__inner', [
      el('span.hero__eyebrow', [icon('sparkle'), 'Online player · nothing to install']),
      el('h1.hero__title', [
        'Every playlist you own, ',
        el('span.gradient-text', 'in one player.'),
      ]),
      el('p.hero__lead', 'Search any song on YouTube and hear it in full — no account, no Premium, nothing to install. Link your Spotify and YouTube playlists, or drop in a direct stream, then listen on phone, tablet or desktop with the same player.'),
      el('div.hero__actions', [
        el('button.btn.btn--primary.btn--lg', { type: 'button', onclick: () => { location.hash = '#/sources'; } }, [icon('link'), 'Link a playlist']),
        el('button.btn.btn--outline.btn--lg', { type: 'button', onclick: () => { location.hash = '#/search'; } }, [icon('search'), 'Browse music']),
      ]),
      el('div.hero__stats', [
        el('div.hero__stat', [el('strong', 'Any'), el('span', 'song, in full')]),
        el('div.hero__stat', [el('strong', { text: String(store.state.playlists.length) }), el('span', 'your playlists')]),
        el('div.hero__stat', [el('strong', { text: String(store.state.liked.length) }), el('span', 'liked songs')]),
        el('div.hero__stat', [el('strong', '0'), el('span', 'files stored')]),
      ]),
    ])));

    /* ---- quick access ---- */
    const quickItems = [];
    quickItems.push(ui.quickTile({
      title: 'Liked Songs',
      sub: pluralize(store.state.liked.length, 'song'),
      artwork: store.state.liked[0] && store.state.liked[0].artwork,
      seed: 'liked-songs',
      onOpen: () => { location.hash = '#/collection/liked'; },
      onPlay: store.state.liked.length ? () => engine.playCollection(store.state.liked, 0, { type: 'collection', id: 'liked', name: 'Liked Songs' }) : null,
    }));
    store.state.playlists.slice(0, 5).forEach((pl) => quickItems.push(ui.quickTile({
      title: pl.name,
      sub: `${pluralize(pl.tracks.length, 'track')} · ${(ui.SOURCE_META[pl.source] || ui.SOURCE_META.local).label}`,
      artwork: pl.artwork || (pl.tracks[0] && pl.tracks[0].artwork),
      seed: pl.name,
      onOpen: () => { location.hash = `#/playlist/${pl.id}`; },
      onPlay: pl.tracks.length ? () => engine.playCollection(pl.tracks, 0, { type: 'playlist', id: pl.id, name: pl.name }) : null,
    })));
    if (!store.state.playlists.length) {
      quickItems.push(ui.quickTile({
        title: 'Link a playlist',
        sub: 'Spotify · YouTube · Audius',
        seed: 'link-source',
        onOpen: () => { location.hash = '#/sources'; },
      }));
    }
    view.appendChild(el('section.section', el('div.grid.grid--quick', quickItems)));

    /* ---- recently played ---- */
    if (store.state.recents.length) {
      view.appendChild(ui.section(
        { title: 'Jump back in', sub: 'Picked up from where you stopped', link: { label: 'See all', onClick: () => { location.hash = '#/collection/recents'; } } },
        trackRail(store.state.recents.slice(0, 12), { type: 'collection', id: 'recents', name: 'Recently played' }),
      ));
    }

    /* ---- charts (live) ---- */
    const chartsHead = el('div.section__head', [
      el('div', [
        el('h2.section__title', { text: data.demo ? 'Demo picks' : 'Trending now' }),
        el('div.section__sub', { id: 'chartsSub', text: data.demo ? 'Offline sample catalogue' : 'Charting music, played in full' }),
      ]),
    ]);
    view.appendChild(el('section.section', [
      chartsHead,
      asyncBlock(
        () => data.charts(),
        (result) => {
          const sub = chartsHead.querySelector('#chartsSub');
          if (sub && !data.demo) {
            sub.textContent = result.source === 'youtube'
              ? 'Top music on YouTube, played in full'
              : 'Free independent music on Audius';
          }
          return trackRail(result.tracks, { type: 'collection', id: 'trending', name: 'Trending now' });
        },
      ),
    ]));

    /* ---- moods ---- */
    view.appendChild(ui.section(
      { title: 'Moods & moments', sub: 'One tap and the queue fills itself' },
      el('div.grid.grid--tiles', catalog.MOODS.map((m) => ui.moodTile(m, () => { location.hash = `#/mood/${m.id}`; }))),
    ));

    /* ---- genres ---- */
    view.appendChild(ui.section(
      { title: 'Browse by genre' },
      el('div.chips', catalog.GENRES.map((g) => el('button.chip', {
        type: 'button', onclick: () => { location.hash = `#/genre/${encodeURIComponent(g.id)}`; },
      }, g.name))),
    ));

    /* ---- underground ---- */
    if (!data.demo) {
      view.appendChild(ui.section(
        { title: 'Fresh from the underground', sub: 'Independent artists uploading right now' },
        asyncBlock(() => data.underground(), (tracks) => trackRail(tracks, { type: 'collection', id: 'underground', name: 'Underground' })),
      ));
    }

    /* ---- feature strip ---- */
    if (!hasLibrary) {
      view.appendChild(ui.section(
        { title: 'Why Loru' },
        el('div.features', catalog.FEATURES.map((f) => el('div.feature', [
          el('div.feature__icon', icon(f.icon)),
          el('div.feature__title', { text: f.title }),
          el('div.feature__text', { text: f.text }),
        ]))),
      ));
    }

    return view;
  }

  /* ============================================================
     SEARCH
     ============================================================ */
  let searchFilter = 'all';

  function viewSearch(params) {
    const q = (params.q || '').trim();
    const view = el('div.view');

    if (!q) {
      view.appendChild(el('section.section', [
        ui.sectionHead({ title: 'Search', sub: 'Songs, artists, playlists — or paste a link from Spotify, YouTube or Audius' }),
        el('div.grid.grid--tiles', catalog.MOODS.map((m) => ui.moodTile(m, () => { location.hash = `#/mood/${m.id}`; }))),
      ]));
      view.appendChild(ui.section({ title: 'Genres' },
        el('div.grid.grid--cards', catalog.GENRES.map((g) => el('button.card', {
          type: 'button', onclick: () => { location.hash = `#/genre/${encodeURIComponent(g.id)}`; },
        }, [
          el('div.card__art', el('div.art', { style: { background: L.gradientFor(g.id) } }, el('span.art__placeholder', { style: { background: L.gradientFor(g.id) } }, icon('wave')))),
          el('div.card__body', el('div.card__title', { text: g.name })),
        ])))));
      return view;
    }

    /* link pasted into the search bar */
    const detected = importer.detect(q);
    if (['spotify', 'youtube', 'audius', 'url', 'unsupported'].includes(detected.source)) {
      view.appendChild(importPreviewCard(q, detected));
    }

    /* Always-available instant play: works with no key and no mirrors. */
    if (!data.demo) {
      view.appendChild(el('section.section', { style: { marginTop: '14px' } },
        el('div.tile', { style: { background: 'var(--accent-grad-soft)', borderColor: 'var(--border-strong)' } }, [
          el('span.pl-item__art', { style: { background: 'var(--accent-grad)', color: 'var(--accent-ink)' } }, icon('play')),
          el('div.tile__body', [
            el('div.tile__title', { text: `Play “${q}” now` }),
            el('div.tile__sub', 'Top YouTube result · full length · no setup'),
          ]),
          el('button.btn.btn--primary.btn--sm', { type: 'button', onclick: () => playTopResult(q) }, [icon('play'), 'Play']),
        ])));
    }

    view.appendChild(el('section.section', [
      ui.sectionHead({ title: `Results for “${q}”` }),
      el('div.chips', { style: { marginBottom: '18px' } }, [
        ['all', 'Everything'], ['youtube', 'YouTube'], ['audius', 'Audius'],
        ['playlists', 'Playlists'], ['artists', 'Artists'],
      ].map(([id, label]) => el('button.chip' + (searchFilter === id ? '.is-active' : ''), {
        type: 'button',
        onclick: () => { searchFilter = id; render(store.state.route, true); },
      }, label))),
    ]));

    /* YouTube first — it is the only source with a mainstream catalogue. */
    if (!data.demo && (searchFilter === 'all' || searchFilter === 'youtube')) {
      view.appendChild(ui.section(
        { title: 'Songs on YouTube', sub: 'Full-length playback through YouTube’s player' },
        asyncBlock(
          () => youtube.search(q, { limit: 24 }),
          (tracks) => ui.trackList(tracks, { context: { type: 'search', id: 'yt:' + q, name: `YouTube: ${q}` } }),
          {
            skeleton: ui.skeletonRows(8),
            onEmpty: () => ui.emptyState({ compact: true, title: 'No YouTube results', text: 'Try fewer words, or the artist name on its own.' }),
            onError: (err, retry) => youtubeSearchError(err, retry, q),
          },
        ),
      ));
    }

    if (searchFilter === 'all' || searchFilter === 'audius') {
      view.appendChild(ui.section(
        { title: data.demo ? 'Songs' : 'Free on Audius', sub: data.demo ? 'From the demo catalogue' : 'Independent artists, no account needed' },
        asyncBlock(
          () => data.searchTracks(q),
          (tracks) => ui.trackList(tracks, { context: { type: 'search', id: q, name: `Search: ${q}` } }),
          {
            skeleton: ui.skeletonRows(6),
            onEmpty: () => ui.emptyState({
              compact: true,
              title: 'Nothing on Audius',
              text: 'Audius carries independent uploads, so mainstream tracks usually only appear on YouTube.',
            }),
          },
        ),
      ));
    }

    /* Playlists and artist pages are live Audius lookups, so they are
       skipped while the offline demo catalogue is in use. */
    const demoNote = (what) => ui.emptyState({
      compact: true, icon: 'sparkle',
      title: `${what} need a live connection`,
      text: 'Turn off demo content in Settings to search the real Audius catalogue.',
      actions: [{ label: 'Turn off demo', variant: 'soft', onClick: () => data.disableDemo() }],
    });

    if (searchFilter === 'all' || searchFilter === 'playlists') {
      view.appendChild(ui.section({ title: 'Playlists' }, data.demo ? demoNote('Playlist results') : asyncBlock(
        () => data.searchPlaylists(q),
        (pls) => el('div.rail', pls.map((pl) => playlistCard(pl, {
          onOpen: () => { location.hash = `#/audius/playlist/${pl.id}`; },
          onPlay: () => { location.hash = `#/audius/playlist/${pl.id}`; },
        }))),
        { onEmpty: () => ui.emptyState({ compact: true, title: 'No playlists found', text: 'Try a different wording.' }) },
      )));
    }

    if (searchFilter === 'all' || searchFilter === 'artists') {
      view.appendChild(ui.section({ title: 'Artists' }, data.demo ? demoNote('Artist results') : asyncBlock(
        () => data.searchUsers(q),
        (users) => el('div.rail', users.map((u) => ui.mediaCard({
          title: u.name,
          sub: `${formatCount(u.followers)} followers · ${pluralize(u.trackCount, 'track')}`,
          artwork: u.artwork,
          badge: 'audius',
          seed: u.handle,
          onOpen: () => { location.hash = `#/audius/artist/${u.id}`; },
        }))),
        { onEmpty: () => ui.emptyState({ compact: true, title: 'No artists found' }) },
      )));
    }

    if (spotify.isConnected()) {
      view.appendChild(ui.section({ title: 'From your Spotify', sub: 'Played in full from YouTube — no Premium needed' }, asyncBlock(
        () => spotify.search(q, { limit: 12 }).then((r) => r.tracks),
        (tracks) => ui.trackList(tracks, { context: { type: 'search', id: 'sp:' + q, name: `Spotify: ${q}` } }),
        { skeleton: ui.skeletonRows(4), onEmpty: () => ui.emptyState({ title: 'Nothing on Spotify either' }) },
      )));
    }

    return view;
  }

  /** Card shown when the user pastes a link instead of a search term. */
  function importPreviewCard(raw, detected) {
    const meta = ui.SOURCE_META[detected.source] || ui.SOURCE_META.local;
    const status = el('div.src-card__note', { text: 'Ready to import' });
    const button = el('button.btn.btn--primary', { type: 'button' }, [icon('plus'), 'Import & play']);

    button.addEventListener('click', async () => {
      button.disabled = true;
      await runImport(raw, { onStatus: (m) => { status.textContent = m; } });
      button.disabled = false;
    });

    return el('section.section', el('div.src-card', {
      style: { '--src-accent': 'var(--accent-grad)' },
    }, [
      el('div.src-card__head', [
        el('div.src-card__logo', icon(meta.icon)),
        el('div', [
          el('div.src-card__title', { text: `${importer.labelFor(detected)} link detected` }),
          status,
        ]),
      ]),
      el('div.src-card__body', { text: raw.length > 90 ? raw.slice(0, 90) + '…' : raw }),
      el('div.src-card__foot', [
        button,
        el('button.btn.btn--ghost', { type: 'button', onclick: () => { location.hash = '#/sources'; } }, 'More options'),
      ]),
    ]));
  }

  /* ============================================================
     LIBRARY
     ============================================================ */
  let libraryTab = 'playlists';

  function viewLibrary() {
    const view = el('div.view');
    const { playlists, liked, recents } = store.state;

    view.appendChild(el('section.section', [
      el('div.section__head', [
        el('div', [
          el('h1.section__title', { style: { fontSize: 'var(--fs-h1)' } }, 'Your Library'),
          el('div.section__sub', { text: `${pluralize(playlists.length, 'playlist')} · ${pluralize(liked.length, 'liked song')} · saved in this browser` }),
        ]),
        el('div', { style: { display: 'flex', gap: '8px' } }, [
          el('button.btn.btn--soft.btn--sm', { type: 'button', onclick: () => ui.openCreatePlaylist([]) }, [icon('plus'), 'New']),
          el('button.btn.btn--primary.btn--sm', { type: 'button', onclick: () => { location.hash = '#/sources'; } }, [icon('link'), 'Import']),
        ]),
      ]),
      el('div.chips', [
        ['playlists', 'Playlists'], ['liked', 'Liked songs'], ['recents', 'Recently played'],
      ].map(([id, label]) => el('button.chip' + (libraryTab === id ? '.is-active' : ''), {
        type: 'button', onclick: () => { libraryTab = id; render(store.state.route, true); },
      }, label))),
    ]));

    if (libraryTab === 'playlists') {
      const cards = [
        ui.mediaCard({
          title: 'Liked Songs',
          sub: pluralize(liked.length, 'song'),
          artwork: liked[0] && liked[0].artwork,
          seed: 'liked-songs',
          onOpen: () => { location.hash = '#/collection/liked'; },
          onPlay: liked.length ? () => engine.playCollection(liked, 0, { type: 'collection', id: 'liked', name: 'Liked Songs' }) : null,
        }),
        ...playlists.map((pl) => playlistCard(pl, {
          onOpen: () => { location.hash = `#/playlist/${pl.id}`; },
          onPlay: pl.tracks.length ? () => engine.playCollection(pl.tracks, 0, { type: 'playlist', id: pl.id, name: pl.name }) : null,
        })),
      ];
      view.appendChild(el('section.section', el('div.grid.grid--cards', cards)));

      if (!playlists.length) {
        view.appendChild(ui.emptyState({
          icon: 'link',
          title: 'No playlists yet',
          text: 'Paste a Spotify, YouTube or Audius link and Loru will rebuild that playlist here.',
          actions: [
            { label: 'Link a playlist', icon: 'link', variant: 'primary', onClick: () => { location.hash = '#/sources'; } },
            { label: 'Create empty playlist', icon: 'plus', onClick: () => ui.openCreatePlaylist([]) },
          ],
        }));
      }
    }

    if (libraryTab === 'liked') {
      view.appendChild(liked.length
        ? ui.trackList(liked, { context: { type: 'collection', id: 'liked', name: 'Liked Songs' } })
        : ui.emptyState({ icon: 'heart', title: 'No liked songs yet', text: 'Tap the heart on any track and it lands here.' }));
    }

    if (libraryTab === 'recents') {
      view.appendChild(recents.length
        ? ui.trackList(recents, { context: { type: 'collection', id: 'recents', name: 'Recently played' } })
        : ui.emptyState({ icon: 'queue', title: 'Nothing played yet', text: 'Your listening history shows up here.' }));
    }

    return view;
  }

  /* ============================================================
     COLLECTION HEADER (shared by playlist-style views)
     ============================================================ */
  function collectionView({ kind, name, description, artwork: art, owner, tracks, source, externalUrl, actions = [], onRemoveTrack, loading = false }) {
    const view = el('div.view');
    const total = (tracks || []).reduce((sum, t) => sum + (t.duration || 0), 0);

    const artNode = ui.artwork(art || (tracks && tracks[0] && tracks[0].artwork), name, 'pl-head__art');

    view.appendChild(el('header.pl-head', [
      artNode,
      el('div.pl-head__body', [
        el('div.pl-head__kind', { text: kind || 'Playlist' }),
        el('h1.pl-head__title', { text: name }),
        description ? el('p.pl-head__desc', { text: description }) : null,
        el('div.pl-head__stats', [
          source ? ui.sourceBadge(source) : null,
          owner ? el('span', { text: owner }) : null,
          owner ? el('span.dot') : null,
          el('span', { text: pluralize((tracks || []).length, 'track') }),
          total ? el('span.dot') : null,
          total ? el('span', { text: formatTotal(total) }) : null,
        ]),
      ]),
    ]));

    const playAll = () => engine.playCollection(tracks, 0, { type: 'collection', id: name, name });
    view.appendChild(el('div.pl-actions', [
      el('button.btn.btn--primary.btn--lg', {
        type: 'button', disabled: !(tracks && tracks.length), onclick: playAll,
      }, [icon('play'), 'Play']),
      el('button.btn.btn--soft', {
        type: 'button', disabled: !(tracks && tracks.length),
        onclick: () => { engine.setShuffle(true); engine.playCollection(tracks, Math.floor(Math.random() * tracks.length), { type: 'collection', id: name, name }); },
      }, [icon('shuffle'), 'Shuffle']),
      el('button.btn.btn--ghost', {
        type: 'button', disabled: !(tracks && tracks.length),
        onclick: () => engine.addManyToQueue(tracks),
      }, [icon('queue'), 'Queue all']),
      ...actions.map((a) => el('button.btn.' + (a.variant ? 'btn--' + a.variant : 'btn--ghost'), {
        type: 'button', onclick: a.onClick, disabled: a.disabled,
      }, [a.icon ? icon(a.icon) : null, a.label])),
      externalUrl ? el('a.btn.btn--ghost', { href: externalUrl, target: '_blank', rel: 'noopener' }, [icon('globe'), 'Original']) : null,
    ]));

    if (loading) view.appendChild(ui.skeletonRows(8));
    else if (!tracks || !tracks.length) {
      view.appendChild(ui.emptyState({
        title: 'This playlist is empty',
        text: 'Add tracks from search, or import them from another service.',
        actions: [{ label: 'Find music', icon: 'search', variant: 'primary', onClick: () => { location.hash = '#/search'; } }],
      }));
    } else {
      view.appendChild(ui.trackList(tracks, {
        context: { type: 'collection', id: name, name },
        onRemove: onRemoveTrack,
      }));
    }

    return view;
  }

  /* ---------------- saved playlist ---------------- */
  function viewPlaylist(params) {
    const pl = store.findPlaylist(params.id);
    if (!pl) {
      return el('div.view', ui.emptyState({
        icon: 'info', title: 'Playlist not found',
        text: 'It may have been deleted from this browser.',
        actions: [{ label: 'Back to library', variant: 'primary', onClick: () => { location.hash = '#/library'; } }],
      }));
    }

    // Fill in YouTube titles that were imported without metadata
    if (pl.tracks.some((t) => t.needsMeta)) {
      youtube.hydrateTracks(pl.tracks, debounce(() => {
        store.updatePlaylist(pl.id, { tracks: pl.tracks });
        if (store.state.route.name === 'playlist' && store.state.route.params.id === pl.id) render(store.state.route, true);
      }, 900));
    }

    const kindLabel = pl.source === 'local' ? 'Playlist'
      : pl.source === 'demo' ? 'Demo playlist'
        : `Imported from ${(ui.SOURCE_META[pl.source] || ui.SOURCE_META.local).label}`;

    return collectionView({
      kind: kindLabel,
      name: pl.name,
      description: pl.description,
      artwork: pl.artwork,
      owner: pl.owner,
      source: pl.source,
      externalUrl: pl.externalUrl,
      tracks: pl.tracks,
      onRemoveTrack: (track) => {
        store.removeTrackFromPlaylist(pl.id, store.trackKey(track));
        render(store.state.route, true);
        toast({ title: 'Removed from playlist', text: track.title, timeout: 2200 });
      },
      actions: [
        { label: 'Rename', icon: 'more', onClick: () => renamePlaylistModal(pl) },
        {
          label: 'Refresh', icon: 'repeat', disabled: !pl.externalUrl,
          onClick: () => refreshPlaylist(pl),
        },
        {
          label: 'Delete', icon: 'trash', onClick: () => ui.confirmModal({
            title: `Delete “${pl.name}”?`,
            desc: 'This only removes it from Loru — the original playlist is untouched.',
            confirmLabel: 'Delete playlist', danger: true,
            onConfirm: () => {
              store.deletePlaylist(pl.id);
              location.hash = '#/library';
              toast({ title: 'Playlist deleted', text: pl.name });
            },
          }),
        },
      ],
    });
  }

  function renamePlaylistModal(pl) {
    const nameInput = el('input.input', { type: 'text', value: pl.name, maxlength: '80' });
    const descInput = el('textarea.textarea', { text: pl.description || '', maxlength: '300' });
    const modal = ui.openModal({
      title: 'Rename playlist',
      body: [
        el('label.field', [el('span.field__label', 'Name'), nameInput]),
        el('label.field', [el('span.field__label', 'Description'), descInput]),
      ],
      foot: { children: [
        el('button.btn.btn--ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
        el('button.btn.btn--primary', { type: 'button', onclick: () => {
          store.updatePlaylist(pl.id, { name: nameInput.value.trim() || pl.name, description: descInput.value.trim() });
          modal.close();
          render(store.state.route, true);
          renderSidebarPlaylists();
        } }, 'Save'),
      ] },
    });
  }

  async function refreshPlaylist(pl) {
    if (!pl.externalUrl) return;
    const close = toast({ title: 'Refreshing…', text: pl.name, timeout: 0 });
    try {
      const res = await importer.importLink(pl.externalUrl);
      const tracks = res.collection.tracks || [];
      store.updatePlaylist(pl.id, { tracks, artwork: res.collection.artwork || pl.artwork });
      close();
      toast({ kind: 'success', title: 'Playlist refreshed', text: `${tracks.length} tracks` });
      render(store.state.route, true);
    } catch (err) {
      close();
      toast({ kind: 'error', title: 'Refresh failed', text: err.message });
    }
  }

  /* ---------------- virtual collections ---------------- */
  function viewCollection(params) {
    if (params.id === 'liked') {
      return collectionView({
        kind: 'Collection', name: 'Liked Songs',
        description: 'Everything you hearted, from every source.',
        tracks: store.state.liked,
        onRemoveTrack: (t) => { store.toggleLike(t); render(store.state.route, true); },
      });
    }
    if (params.id === 'recents') {
      return collectionView({
        kind: 'Collection', name: 'Recently played',
        description: 'The last 60 tracks you listened to.',
        tracks: store.state.recents,
        actions: [{
          label: 'Clear history', icon: 'trash', onClick: () => ui.confirmModal({
            title: 'Clear listening history?', danger: true, confirmLabel: 'Clear',
            onConfirm: () => { store.set({ recents: [] }); render(store.state.route, true); },
          }),
        }],
      });
    }
    return el('div.view', ui.emptyState({ icon: 'info', title: 'Unknown collection' }));
  }

  /* ---------------- genre / mood (live) ---------------- */
  function viewGenre(params) {
    const genre = decodeURIComponent(params.id || '');
    const view = el('div.view');
    view.appendChild(el('header.pl-head', [
      ui.artwork(null, genre, 'pl-head__art'),
      el('div.pl-head__body', [
        el('div.pl-head__kind', 'Genre'),
        el('h1.pl-head__title', { text: genre }),
        el('p.pl-head__desc', { text: `Popular ${genre} tracks, played in full.` }),
      ]),
    ]));
    view.appendChild(asyncBlock(
      () => data.mix(`${genre} music`),
      (tracks) => el('div', [
        el('div.pl-actions', [
          el('button.btn.btn--primary.btn--lg', { type: 'button', onclick: () => engine.playCollection(tracks, 0, { type: 'genre', id: genre, name: genre }) }, [icon('play'), 'Play']),
          el('button.btn.btn--soft', { type: 'button', onclick: () => { engine.setShuffle(true); engine.playCollection(tracks, 0, { type: 'genre', id: genre, name: genre }); } }, [icon('shuffle'), 'Shuffle']),
          el('button.btn.btn--ghost', { type: 'button', onclick: () => saveAsPlaylist(genre, tracks, 'audius') }, [icon('plus'), 'Save as playlist']),
        ]),
        ui.trackList(tracks, { context: { type: 'genre', id: genre, name: genre } }),
      ]),
      { skeleton: ui.skeletonRows(8) },
    ));
    return view;
  }

  function viewMood(params) {
    const mood = catalog.MOODS.find((m) => m.id === params.id);
    if (!mood) return el('div.view', ui.emptyState({ icon: 'info', title: 'Unknown mood' }));

    const view = el('div.view');
    view.appendChild(el('header.pl-head', [
      el('div.pl-head__art.art', { style: { background: `linear-gradient(140deg, hsl(${mood.hue} 76% 54%), hsl(${(mood.hue + 46) % 360} 70% 40%))` } }),
      el('div.pl-head__body', [
        el('div.pl-head__kind', 'Mood mix'),
        el('h1.pl-head__title', { text: mood.name }),
        el('p.pl-head__desc', { text: `A live mix built from “${mood.query}”. Refresh for a different set.` }),
      ]),
    ]));
    view.appendChild(asyncBlock(
      () => data.mix(mood.query),
      (tracks) => el('div', [
        el('div.pl-actions', [
          el('button.btn.btn--primary.btn--lg', { type: 'button', onclick: () => engine.playCollection(tracks, 0, { type: 'mood', id: mood.id, name: mood.name }) }, [icon('play'), 'Play mix']),
          el('button.btn.btn--soft', { type: 'button', onclick: () => { engine.setShuffle(true); engine.playCollection(tracks, 0, { type: 'mood', id: mood.id, name: mood.name }); } }, [icon('shuffle'), 'Shuffle']),
          el('button.btn.btn--ghost', { type: 'button', onclick: () => saveAsPlaylist(mood.name, tracks, 'audius') }, [icon('plus'), 'Save as playlist']),
        ]),
        ui.trackList(tracks, { context: { type: 'mood', id: mood.id, name: mood.name } }),
      ]),
      { skeleton: ui.skeletonRows(8) },
    ));
    return view;
  }

  function saveAsPlaylist(name, tracks, source) {
    const pl = store.createPlaylist({ name, tracks, source: source || 'local', description: 'Saved from Loru browse' });
    renderSidebarPlaylists();
    toast({ kind: 'success', title: 'Saved to your library', text: `${name} · ${pluralize(tracks.length, 'track')}`, action: { label: 'Open', onClick: () => { location.hash = `#/playlist/${pl.id}`; } } });
  }

  /* ---------------- live audius playlist / artist ---------------- */
  function viewAudiusPlaylist(params) {
    const host = el('div.view', ui.skeletonRows(8));
    audius.getPlaylist(params.id)
      .then((pl) => {
        host.replaceChildren(...collectionView({
          kind: pl.isAlbum ? 'Album on Audius' : 'Playlist on Audius',
          name: pl.name, description: pl.description, artwork: pl.artwork,
          owner: pl.owner ? `By ${pl.owner}` : '', source: 'audius',
          externalUrl: pl.externalUrl, tracks: pl.tracks,
          actions: [{ label: 'Save to library', icon: 'plus', variant: 'soft', onClick: () => {
            store.createPlaylist({ name: pl.name, description: pl.description, artwork: pl.artwork, source: 'audius', externalUrl: pl.externalUrl, owner: pl.owner, tracks: pl.tracks });
            renderSidebarPlaylists();
            toast({ kind: 'success', title: 'Saved to your library', text: pl.name });
          } }],
        }).childNodes);
      })
      .catch((err) => host.replaceChildren(offlineState(err, () => render(store.state.route, true))));
    return host;
  }

  function viewAudiusArtist(params) {
    const host = el('div.view', ui.skeletonRows(8));
    audius.getUserTracks(params.id, { limit: 50 })
      .then((tracks) => {
        const name = (tracks[0] && tracks[0].artist) || 'Artist';
        host.replaceChildren(...collectionView({
          kind: 'Artist on Audius', name,
          description: `${pluralize(tracks.length, 'track')} available to stream.`,
          artwork: tracks[0] && tracks[0].artwork, source: 'audius', tracks,
          externalUrl: tracks[0] && tracks[0].artistHandle ? `https://audius.co/${tracks[0].artistHandle}` : null,
          actions: [{ label: 'Save as playlist', icon: 'plus', variant: 'soft', onClick: () => saveAsPlaylist(name, tracks, 'audius') }],
        }).childNodes);
      })
      .catch((err) => host.replaceChildren(offlineState(err, () => render(store.state.route, true))));
    return host;
  }

  /* ============================================================
     SOURCES / LINK
     ============================================================ */
  function viewSources() {
    const view = el('div.view');
    const sp = store.state.connections.spotify;

    /* ---- paste box ---- */
    const input = el('input.input', {
      type: 'url', placeholder: 'Paste a Spotify, YouTube, Audius or direct audio link…',
      'aria-label': 'Playlist or track link',
      spellcheck: 'false', autocomplete: 'off',
    });
    const detectedChip = el('div.src-card__note', { text: 'Supports playlists, albums, single tracks and live radio streams.' });
    const importBtn = el('button.btn.btn--primary', { type: 'button' }, [icon('link'), 'Import']);

    input.addEventListener('input', () => {
      const d = importer.detect(input.value);
      if (d.source === 'empty') { detectedChip.textContent = 'Supports playlists, albums, single tracks and live radio streams.'; return; }
      if (d.source === 'unsupported') { detectedChip.textContent = `${d.service} can’t be streamed by third-party players.`; return; }
      if (d.source === 'unknown' || d.source === 'query') { detectedChip.textContent = 'Not a recognised link yet…'; return; }
      detectedChip.textContent = `Detected: ${importer.labelFor(d)} ✓`;
    });

    async function doImport() {
      importBtn.disabled = true;
      await runImport(input.value, { onStatus: (m) => { detectedChip.textContent = m; } });
      importBtn.disabled = false;
    }
    importBtn.addEventListener('click', doImport);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doImport(); });

    view.appendChild(el('section.section', { style: { marginTop: '12px' } }, el('div.panel', [
      el('h1.panel__title', { style: { fontSize: 'var(--fs-h2)' } }, 'Link a playlist'),
      el('p.panel__desc', 'Loru reads the track list from the service you paste, then streams each song from wherever it is legally playable. Nothing is downloaded or copied.'),
      el('div', { style: { marginTop: '18px', display: 'grid', gap: '10px' } }, [
        el('div.paste-row', [input, importBtn]),
        detectedChip,
        el('div.chips', catalog.LINK_EXAMPLES.map((ex) => el('button.chip', {
          type: 'button',
          onclick: () => { input.value = ex.value; input.dispatchEvent(new Event('input')); input.focus(); },
        }, [icon(ui.SOURCE_META[ex.source].icon), ex.label]))),
      ]),
    ])));

    /* ---- service cards ---- */
    const cards = el('div.grid.grid--wide');

    const tryExample = (index) => () => {
      input.value = catalog.LINK_EXAMPLES[index].value;
      input.dispatchEvent(new Event('input'));
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
      input.focus();
    };

    /* Spotify */
    cards.appendChild(srcCard({
      state: sp.connected ? 'connected' : null,
      color: '#1ed760',
      accent: 'linear-gradient(90deg,#1ed760,#12a150)',
      iconName: 'spotify',
      title: 'Spotify',
      note: sp.connected
        ? `Connected as ${sp.user ? sp.user.name : 'you'}${sp.premium ? ' · Premium' : ' · Free'}`
        : 'Read your playlists and liked songs',
      status: sp.connected ? 'Live' : 'Off',
      statusKind: sp.connected ? 'on' : null,
      body: sp.connected
        ? (sp.premium
          ? 'Premium detected — full tracks play through the official Spotify player.'
          : 'Free account: Spotify itself won’t stream full tracks outside its own app, so Loru finds each song on YouTube and plays it in full instead. Nothing is limited to 30 seconds.')
        : 'Spotify requires each listener to use their own free developer Client ID. It takes about a minute to set up and stays in your browser. A free account is enough.',
      foot: sp.connected ? [
        el('button.btn.btn--soft.btn--sm', { type: 'button', onclick: () => importSpotifyLibrary() }, [icon('library'), 'Import my playlists']),
        el('button.btn.btn--ghost.btn--sm', { type: 'button', onclick: () => { spotify.logout(); toast({ title: 'Disconnected from Spotify' }); render(store.state.route, true); } }, 'Disconnect'),
      ] : [
        el('button.btn.btn--primary.btn--sm', {
          type: 'button',
          onclick: () => (spotify.isConfigured() ? connectSpotify() : openSpotifySetup()),
        }, [icon('spotify'), spotify.isConfigured() ? 'Connect Spotify' : 'Set up Spotify']),
        el('button.btn.btn--ghost.btn--sm', { type: 'button', onclick: openSpotifySetup }, 'How it works'),
      ],
    }));

    /* YouTube */
    cards.appendChild(srcCard({
      color: '#ff4e45',
      accent: 'linear-gradient(90deg,#ff4e45,#c62828)',
      iconName: 'youtube',
      title: 'YouTube',
      note: 'Playlists, mixes and single videos',
      status: 'No setup', statusKind: 'on',
      body: 'Paste any public playlist or video link. Playback runs through YouTube’s official embedded player, so creators still get their view counts. Videos whose owners disable embedding are skipped automatically.',
      foot: [el('button.btn.btn--soft.btn--sm', { type: 'button', onclick: tryExample(1) }, [icon('link'), 'Try an example'])],
    }));

    /* Audius */
    cards.appendChild(srcCard({
      color: '#a855f7',
      accent: 'linear-gradient(90deg,#a855f7,#6366f1)',
      iconName: 'wave',
      title: 'Audius',
      note: 'Millions of free, artist-uploaded tracks',
      status: 'Built in', statusKind: 'on',
      body: 'This is what powers search, trending and the mood mixes — full-length streaming with no account and no API key. Audius is also the fallback when a Spotify track can’t be played directly.',
      foot: [el('button.btn.btn--soft.btn--sm', { type: 'button', onclick: () => { location.hash = '#/search'; } }, [icon('search'), 'Browse Audius'])],
    }));

    /* Direct URL */
    cards.appendChild(srcCard({
      color: 'var(--accent-2)',
      accent: 'var(--accent-grad)',
      iconName: 'globe',
      title: 'Direct links & radio',
      note: 'MP3, AAC, OGG, FLAC and live streams',
      status: 'No setup', statusKind: 'on',
      body: 'Any publicly reachable audio URL works — internet radio, a podcast episode, or a file on your own server. Live streams show as LIVE instead of a duration.',
      foot: [el('button.btn.btn--soft.btn--sm', { type: 'button', onclick: tryExample(3) }, [icon('link'), 'Try a radio stream'])],
    }));

    view.appendChild(ui.section({ title: 'Supported services' }, cards));

    /* ---- not supported note ---- */
    view.appendChild(el('section.section', el('div.callout', [
      icon('info'),
      el('div', [
        el('strong', 'Apple Music, SoundCloud, Deezer and Tidal '),
        'do not allow third-party web players to stream their catalogues. If you paste one of those links Loru will offer to find the same songs on Audius or YouTube instead.',
      ]),
    ])));

    /* ---- imported collections ---- */
    const imported = store.state.playlists.filter((p) => p.source !== 'local');
    if (imported.length) {
      view.appendChild(ui.section(
        { title: 'Imported so far', sub: `${pluralize(imported.length, 'collection')} linked into your library` },
        el('div.grid.grid--cards', imported.map((pl) => playlistCard(pl, {
          onOpen: () => { location.hash = `#/playlist/${pl.id}`; },
          onPlay: pl.tracks.length ? () => engine.playCollection(pl.tracks, 0, { type: 'playlist', id: pl.id, name: pl.name }) : null,
        }))),
      ));
    }

    return view;
  }

  /** One service card on the "Link sources" screen. */
  function srcCard({ state, color, accent, iconName, title, note, status, statusKind, body, foot }) {
    return el('div.src-card', {
      dataset: state ? { state } : null,
      style: { '--src-color': color, '--src-accent': accent },
    }, [
      el('span.src-card__status',
        el('span.status-pill' + (statusKind ? '.status-pill--' + statusKind : ''), [el('i'), status])),
      el('div.src-card__head', [
        el('div.src-card__logo', icon(iconName)),
        el('div', { style: { minWidth: '0' } }, [
          el('div.src-card__title', { text: title }),
          el('div.src-card__note', { text: note }),
        ]),
      ]),
      el('div.src-card__body', { text: body }),
      el('div.src-card__foot', foot),
    ]);
  }

  /* ---------------- import runner ---------------- */
  async function runImport(raw, { onStatus } = {}) {
    const say = (m) => onStatus && onStatus(m);
    const closeToast = toast({ title: 'Importing…', text: 'Reading that link', timeout: 0 });

    try {
      const res = await importer.importLink(raw, {
        onStatus: (m) => { say(m); },
        onProgress: () => {},
      });
      closeToast();

      const col = res.collection;
      const tracks = col.tracks || [];
      if (!tracks.length) throw new Error('No playable tracks found at that link.');

      if (res.kind === 'track') {
        engine.playCollection(tracks, 0, { type: 'link', id: col.id, name: col.name });
        say(`Playing “${tracks[0].title}”`);
        toast({ kind: 'success', title: 'Added and playing', text: tracks[0].title, action: { label: 'Save', onClick: () => ui.openAddToPlaylist(tracks) } });
        return res;
      }

      const pl = store.createPlaylist({
        name: col.name || 'Imported playlist',
        description: col.description || '',
        artwork: col.artwork || null,
        source: col.source || 'local',
        externalUrl: col.externalUrl || (raw.startsWith('http') ? raw : null),
        owner: col.owner || '',
        tracks,
      });
      renderSidebarPlaylists();
      say(`Imported ${tracks.length} tracks`);
      toast({
        kind: 'success',
        title: `Imported “${pl.name}”`,
        text: `${pluralize(tracks.length, 'track')} ready to play`,
        action: { label: 'Open', onClick: () => { location.hash = `#/playlist/${pl.id}`; } },
      });
      location.hash = `#/playlist/${pl.id}`;
      return res;
    } catch (err) {
      closeToast();
      say('Import failed');

      if (err.isQuery) {
        location.hash = `#/search?q=${encodeURIComponent(err.query)}`;
        return null;
      }

      const action = err.action
        ? {
          label: err.action.label,
          onClick: () => {
            if (err.action.hash) location.hash = err.action.hash;
            if (err.action.spotifyLogin) connectSpotify();
          },
        }
        : err.searchFallback
          ? { label: 'Search instead', onClick: () => { location.hash = `#/search?q=${encodeURIComponent(err.searchFallback)}`; } }
          : null;

      toast({ kind: 'error', title: 'Import failed', text: err.message, timeout: 7000, action });
      return null;
    }
  }

  /* ---------------- Spotify helpers ---------------- */
  function openSpotifySetup() {
    const idInput = el('input.input', {
      type: 'text', value: store.state.settings.spotifyClientId || '',
      placeholder: '32-character Client ID', spellcheck: 'false', autocomplete: 'off',
    });
    const redirect = spotify.redirectUri();

    const modal = ui.openModal({
      title: 'Connect Spotify',
      desc: 'Spotify requires every app to use its own Client ID. Yours stays in this browser.',
      wide: true,
      body: [
        el('ol', { style: { display: 'grid', gap: '12px', fontSize: 'var(--fs-sm)', color: 'var(--ink-2)', paddingLeft: '20px', listStyle: 'decimal' } }, [
          el('li', [
            'Open the ',
            el('a', { href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noopener', style: { textDecoration: 'underline' } }, 'Spotify Developer Dashboard'),
            ' and click “Create app”. Any name works.',
          ]),
          el('li', ['Under “Redirect URIs”, add exactly this address:']),
          el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
            el('code', { style: { flex: '1', background: 'var(--surface-2)', padding: '10px 12px', borderRadius: '10px', fontSize: '.8rem', wordBreak: 'break-all' }, text: redirect }),
            el('button.btn.btn--soft.btn--sm', { type: 'button', onclick: async () => {
              const ok = await L.copyToClipboard(redirect);
              toast({ kind: ok ? 'success' : 'error', title: ok ? 'Copied' : 'Copy failed', timeout: 1800 });
            } }, 'Copy'),
          ]),
          el('li', 'Tick the “Web API” and “Web Playback SDK” checkboxes, then save.'),
          el('li', 'Copy the Client ID from your new app and paste it below.'),
        ]),
        el('label.field', [
          el('span.field__label', 'Spotify Client ID'),
          idInput,
          el('span.field__hint', 'Stored only in this browser’s local storage. No secret is needed — Loru uses the PKCE flow.'),
        ]),
        el('div.callout', [
          icon('info'),
          el('div', [
            el('strong', 'A free Spotify account is enough. '),
            'Loru reads your playlists, then plays each song in full from YouTube. Premium only changes which player handles playback, not what you can listen to.',
          ]),
        ]),
      ],
      foot: { children: [
        el('button.btn.btn--ghost', { type: 'button', onclick: () => modal.close() }, 'Later'),
        el('button.btn.btn--primary', { type: 'button', onclick: () => {
          const id = idInput.value.trim();
          if (!/^[a-f0-9]{20,40}$/i.test(id)) {
            toast({ kind: 'error', title: 'That doesn’t look like a Client ID', text: 'It should be a long string of letters and numbers.' });
            return;
          }
          store.updateSettings({ spotifyClientId: id });
          modal.close();
          connectSpotify();
        } }, [icon('spotify'), 'Save & connect']),
      ] },
    });
  }

  async function connectSpotify() {
    try {
      await spotify.login();
    } catch (err) {
      toast({ kind: 'error', title: 'Could not start Spotify login', text: err.message, action: { label: 'Set up', onClick: openSpotifySetup } });
    }
  }

  async function importSpotifyLibrary() {
    const close = toast({ title: 'Reading your Spotify library…', timeout: 0 });
    try {
      const playlists = await spotify.myPlaylists({ limit: 50 });
      close();
      if (!playlists.length) { toast({ title: 'No playlists found on that account' }); return; }

      const chosen = new Set();
      const list = el('div.opt-list', playlists.map((pl) => {
        const check = el('span.opt__icon', icon('plus'));
        const row = el('button.opt', { type: 'button', onclick: () => {
          if (chosen.has(pl.id)) { chosen.delete(pl.id); check.replaceChildren(icon('plus')); row.style.borderColor = ''; }
          else { chosen.add(pl.id); check.replaceChildren(icon('check')); row.style.borderColor = 'var(--accent-1)'; }
          countLabel.textContent = chosen.size ? `${chosen.size} selected` : 'Nothing selected yet';
        } }, [
          check,
          el('span.opt__body', [
            el('span.opt__title', { text: pl.name }),
            el('span.opt__sub', { text: `${pluralize(pl.trackCount, 'track')} · ${pl.owner}` }),
          ]),
        ]);
        return row;
      }));
      const countLabel = el('div.modal__desc', 'Nothing selected yet');

      const modal = ui.openModal({
        title: 'Import from Spotify',
        desc: 'Pick the playlists you want mirrored into Loru.',
        wide: true,
        body: [countLabel, list],
        foot: { children: [
          el('button.btn.btn--ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
          el('button.btn.btn--primary', { type: 'button', onclick: async () => {
            modal.close();
            const picked = playlists.filter((p) => chosen.has(p.id));
            if (!picked.length) { toast({ title: 'Nothing selected' }); return; }
            const progress = toast({ title: `Importing ${picked.length} playlists…`, timeout: 0 });
            let done = 0;
            for (const pl of picked) {
              try {
                const tracks = await spotify.playlistTracks(pl.id);
                store.createPlaylist({
                  name: pl.name, description: pl.description, artwork: pl.artwork,
                  source: 'spotify', externalUrl: pl.externalUrl, owner: pl.owner, tracks,
                });
                done++;
              } catch (e) { /* skip that one */ }
            }
            progress();
            renderSidebarPlaylists();
            render(store.state.route, true);
            toast({ kind: 'success', title: `Imported ${done} of ${picked.length}`, text: 'Find them in Your Library', action: { label: 'Open library', onClick: () => { location.hash = '#/library'; } } });
          } }, [icon('plus'), 'Import selected']),
        ] },
      });
    } catch (err) {
      close();
      toast({ kind: 'error', title: 'Spotify import failed', text: err.message });
    }
  }

  /* ============================================================
     SETTINGS
     ============================================================ */
  function viewSettings() {
    const view = el('div.view');
    const s = store.state.settings;
    const sp = store.state.connections.spotify;

    view.appendChild(el('section.section', { style: { marginTop: '12px' } }, [
      el('h1.section__title', { style: { fontSize: 'var(--fs-h1)' } }, 'Settings'),
      el('div.section__sub', 'Everything is stored locally in this browser — there is no Loru account.'),
    ]));

    /* appearance */
    view.appendChild(ui.section({ title: 'Appearance' }, el('div.panel', [
      settingRow('Theme', 'Dark keeps the artwork forward; light suits bright rooms.',
        el('div.chips', [['dark', 'Dark'], ['light', 'Light']].map(([id, label]) =>
          el('button.chip' + (s.theme === id ? '.is-active' : ''), {
            type: 'button', onclick: () => { L.app.setTheme(id); render(store.state.route, true); },
          }, label)))),
      settingRow('Accent colour', 'Used across buttons, sliders and the visualizer.',
        el('div.swatches', ['violet', 'sunset', 'mint', 'ocean', 'ember'].map((name) => {
          const colors = { violet: ['#8b5cf6', '#22d3ee'], sunset: ['#fb7185', '#fbbf24'], mint: ['#34d399', '#22d3ee'], ocean: ['#3b82f6', '#22d3ee'], ember: ['#f97316', '#ef4444'] }[name];
          return el('button.swatch', {
            type: 'button', 'aria-label': name, 'aria-pressed': s.accent === name ? 'true' : 'false',
            style: { background: `linear-gradient(135deg, ${colors[0]}, ${colors[1]})` },
            onclick: () => { L.app.setAccent(name); render(store.state.route, true); },
          });
        }))),
      toggleRow('Audio visualizer', 'Draws a live spectrum in the full-screen player.', 'showVisualizer'),
    ])));

    /* playback */
    view.appendChild(ui.section({ title: 'Playback' }, el('div.panel', [
      toggleRow('Autoplay next track', 'Continue through the queue automatically.', 'autoplayNext'),
      settingRow('Default music source', 'Where charts, genres and mood mixes come from. YouTube has effectively every song; Audius is independent artists only.',
        el('div.chips', [['youtube', 'YouTube'], ['audius', 'Audius']].map(([id, label]) =>
          el('button.chip' + (s.defaultSource === id ? '.is-active' : ''), {
            type: 'button',
            onclick: () => { store.updateSettings({ defaultSource: id }); render(store.state.route, true); },
          }, label)))),
      toggleRow('Play Spotify tracks via YouTube', 'Without Premium, find the full song on YouTube instead of playing a 30-second preview.', 'preferYouTubeForSpotify'),
      toggleRow('Prefer ad-free sources', 'Look on Audius before YouTube. Audius never serves ads and keeps playing in the background, but it only carries independent artists — mainstream songs will often fall back to YouTube anyway.', 'adFreeFirst'),
      backgroundRow(),
      toggleRow('Demo content', 'Fills the app with a sample catalogue that works with no connection.', 'demoMode', (on) => {
        on ? data.enableDemo() : data.disableDemo();
      }),
    ])));

    /* youtube */
    view.appendChild(ui.section({ title: 'YouTube search' }, el('div.panel', [
      el('div.callout', [
        icon('info'),
        el('div', [
          el('strong', 'Search works without any setup. '),
          'Loru reads YouTube metadata from community-run Piped and Invidious mirrors. Those go offline fairly often — adding your own free API key below makes search reliable. Playback always uses YouTube’s official player either way.',
        ]),
      ]),
      settingRow('YouTube Data API key', 'Optional. Free from Google Cloud; roughly 100 searches per day on the free quota.',
        (() => {
          const inp = el('input.input', {
            type: 'text', value: s.youtubeApiKey || '', placeholder: 'AIza…',
            spellcheck: 'false', autocomplete: 'off', style: { minWidth: '240px' },
          });
          inp.addEventListener('change', () => {
            store.updateSettings({ youtubeApiKey: inp.value.trim() });
            toast({ kind: 'success', title: inp.value.trim() ? 'API key saved' : 'API key cleared', text: 'Search will use it from now on.', timeout: 2600 });
          });
          return inp;
        })()),
      settingRow('Custom mirror', 'Optional. A Piped or Invidious API base URL to try before the built-in list.',
        (() => {
          const inp = el('input.input', {
            type: 'url', value: s.youtubeMirror || '', placeholder: 'https://pipedapi.example.com',
            spellcheck: 'false', autocomplete: 'off', style: { minWidth: '240px' },
          });
          inp.addEventListener('change', () => {
            store.updateSettings({ youtubeMirror: inp.value.trim() });
            L.storage.remove('yt:mirror');
            toast({ kind: 'success', title: 'Mirror saved', timeout: 2200 });
          });
          return inp;
        })()),
      settingRow('How to get a key', 'Enable “YouTube Data API v3” in a Google Cloud project, then create an API key under Credentials.',
        el('a.btn.btn--soft.btn--sm', {
          href: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com',
          target: '_blank', rel: 'noopener',
        }, [icon('globe'), 'Google Cloud'])),
      diagnosticsRow(),
    ])));

    /* spotify */
    view.appendChild(ui.section({ title: 'Spotify' }, el('div.panel', [
      settingRow(
        sp.connected ? `Connected as ${sp.user ? sp.user.name : 'you'}` : 'Not connected',
        sp.connected
          ? (sp.premium ? 'Premium account — full tracks play natively.' : 'Free account — full tracks play via YouTube.')
          : 'Add a Client ID from the Spotify Developer Dashboard to read your playlists.',
        sp.connected
          ? el('button.btn.btn--soft.btn--sm', { type: 'button', onclick: () => { spotify.logout(); render(store.state.route, true); } }, 'Disconnect')
          : el('button.btn.btn--primary.btn--sm', { type: 'button', onclick: openSpotifySetup }, [icon('spotify'), 'Set up']),
      ),
      settingRow('Client ID', 'Public identifier only — never a secret.',
        (() => {
          const inp = el('input.input', { type: 'text', value: s.spotifyClientId || '', placeholder: 'Not set', spellcheck: 'false', style: { minWidth: '240px' } });
          inp.addEventListener('change', () => { store.updateSettings({ spotifyClientId: inp.value.trim() }); toast({ kind: 'success', title: 'Client ID saved', timeout: 2000 }); });
          return inp;
        })()),
      settingRow('Redirect URI', 'Must match the value registered in your Spotify app.',
        el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, [
          el('code', { style: { background: 'var(--surface-2)', padding: '8px 10px', borderRadius: '8px', fontSize: '.78rem', wordBreak: 'break-all' }, text: spotify.redirectUri() }),
          el('button.btn.btn--soft.btn--sm', { type: 'button', onclick: async () => {
            const ok = await L.copyToClipboard(spotify.redirectUri());
            toast({ kind: ok ? 'success' : 'error', title: ok ? 'Copied' : 'Copy failed', timeout: 1600 });
          } }, 'Copy'),
        ])),
    ])));

    /* data */
    view.appendChild(ui.section({ title: 'Your data' }, el('div.panel', [
      settingRow('Export library', 'Download your playlists, liked songs and settings as JSON.',
        el('button.btn.btn--soft.btn--sm', { type: 'button', onclick: exportLibrary }, 'Export')),
      settingRow('Import library', 'Restore from a previously exported file.',
        el('button.btn.btn--soft.btn--sm', { type: 'button', onclick: importLibrary }, 'Choose file')),
      settingRow('Reset everything', 'Clears playlists, history and settings from this browser.',
        el('button.btn.btn--danger.btn--sm', { type: 'button', onclick: () => ui.confirmModal({
          title: 'Reset Loru?',
          desc: 'Playlists, liked songs, history and your Spotify connection will be removed from this browser.',
          confirmLabel: 'Reset everything', danger: true,
          onConfirm: () => { L.storage.clearAll(); location.reload(); },
        }) }, [icon('trash'), 'Reset'])),
    ])));

    /* about */
    view.appendChild(ui.section({ title: 'About Loru Player' }, el('div.panel', [
      el('p.panel__desc', 'Loru Player is a browser-based music player. It never stores audio: each track is streamed from the service that hosts it, using that service’s official player or public API. Playlists you import are references, not copies.'),
      el('div.kbd-list', { style: { marginTop: '16px' } }, [
        ['Version', '1.1.0'],
        ['Streaming', 'YouTube · Audius · Spotify · direct URLs'],
        ['Lyrics', 'LRCLIB, fetched live'],
        ['Storage', 'Browser local storage only'],
        ['Accounts', 'None required'],
      ].map(([k, v]) => el('div.kbd-row', [el('span', { text: k }), el('span', { style: { color: 'var(--ink-3)' }, text: v })]))),
      el('div', { style: { marginTop: '16px' } },
        el('button.btn.btn--ghost.btn--sm', { type: 'button', onclick: () => L.app.showShortcuts() }, [icon('info'), 'Keyboard shortcuts'])),
    ])));

    return view;
  }

  /**
   * Runs a live check against every search source and lists the outcome.
   * Public mirrors rot over time, so this is how a user works out whether
   * search is broken because of them or because of their own key.
   */
  function diagnosticsRow() {
    const output = el('div', { style: { display: 'none', marginTop: '12px' } });

    const button = el('button.btn.btn--soft.btn--sm', { type: 'button' }, [icon('repeat'), 'Test sources']);

    button.addEventListener('click', async () => {
      button.disabled = true;
      button.replaceChildren(icon('repeat'), document.createTextNode('Testing…'));
      output.style.display = 'block';
      output.replaceChildren(el('div.section__sub', 'Contacting each source, this can take a few seconds…'));

      try {
        const results = await youtube.testSources();
        const working = results.filter((r) => r.ok).length;
        output.replaceChildren(
          el('div.kbd-row', { style: { borderBottom: '1px solid var(--border)', paddingBottom: '8px' } }, [
            el('strong', { text: working ? `${working} source${working === 1 ? '' : 's'} working` : 'No sources responding' }),
            el('span', {
              style: { color: working ? '#4ade80' : '#f87171', fontWeight: '700', fontSize: 'var(--fs-xs)' },
              text: working ? 'SEARCH SHOULD WORK' : 'SEARCH WILL FAIL',
            }),
          ]),
          ...results.map((r) => el('div.kbd-row', [
            el('span', { style: { wordBreak: 'break-all', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }, text: r.label }),
            el('span', {
              style: {
                flex: 'none',
                color: r.ok === null ? 'var(--ink-3)' : r.ok ? '#4ade80' : '#f87171',
                fontSize: 'var(--fs-xs)',
              },
              text: `${r.ok === null ? '—' : r.ok ? '✓' : '✕'} ${r.detail}`,
            }),
          ])),
          !working ? el('div.callout.callout--warn', { style: { marginTop: '12px' } }, [
            icon('info'),
            el('div', 'Every public mirror is down or blocked. Add a YouTube Data API key above — that route does not depend on them.'),
          ]) : null,
        );
      } catch (err) {
        output.replaceChildren(ui.errorState(err.message));
      }

      button.disabled = false;
      button.replaceChildren(icon('repeat'), document.createTextNode('Test again'));
    });

    return el('div', [
      settingRow('Check what works', 'Contacts every search source and reports which ones respond.', button),
      output,
    ]);
  }

  function settingRow(title, desc, control) {
    return el('div.setting-row', [
      el('div.setting-row__body', [
        el('div.setting-row__title', { text: title }),
        desc ? el('div.setting-row__desc', { text: desc }) : null,
      ]),
      el('div.setting-row__control', control),
    ]);
  }

  /**
   * Background playback is decided by the browser and by each service, not by
   * Loru, so this explains rather than promises.
   */
  function backgroundRow() {
    const supported = [
      ['Audius', true, 'Plays with the screen off'],
      ['Direct links & radio', true, 'Plays with the screen off'],
      ['Spotify previews', true, 'Plays with the screen off'],
      ['YouTube', false, 'Pauses when you leave the tab'],
    ];

    return el('div', [
      settingRow('Background playback', 'Which sources keep playing when you switch apps or lock the phone.',
        el('span.status-pill', [el('i'), 'Depends on source'])),
      el('div', { style: { paddingBottom: '14px' } }, [
        ...supported.map(([name, ok, note]) => el('div.kbd-row', [
          el('span', { text: name }),
          el('span', {
            style: { color: ok ? '#4ade80' : '#fbbf24', fontSize: 'var(--fs-xs)', flex: 'none' },
            text: `${ok ? '✓' : '!'} ${note}`,
          }),
        ])),
        el('div.callout.callout--warn', { style: { marginTop: '12px' } }, [
          icon('info'),
          el('div', [
            el('strong', 'YouTube stops in the background by design. '),
            'Its embedded player is required to pause when the page is hidden, and that restriction is what YouTube Premium lifts. Loru cannot override it without breaking YouTube’s terms. For uninterrupted background listening, turn on ',
            el('strong', '“Prefer ad-free sources”'),
            ' above so Audius is used when it has the track — or install Loru to your home screen, which keeps it alive longer on Android.',
          ]),
        ]),
      ]),
    ]);
  }

  function toggleRow(title, desc, key, after) {
    const on = !!store.state.settings[key];
    const sw = el('button.switch', { type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': title });
    sw.addEventListener('click', () => {
      const next = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', next ? 'true' : 'false');
      store.updateSettings({ [key]: next });
      if (after) after(next);
    });
    return settingRow(title, desc, sw);
  }

  function exportLibrary() {
    const payload = {
      app: 'Loru Player', version: 1, exportedAt: new Date().toISOString(),
      playlists: store.state.playlists, liked: store.state.liked,
      recents: store.state.recents, settings: store.state.settings,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `loru-library-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast({ kind: 'success', title: 'Library exported' });
  }

  function importLibrary() {
    const input = el('input', { type: 'file', accept: 'application/json', style: { display: 'none' } });
    document.body.appendChild(input);
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) { input.remove(); return; }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const payload = JSON.parse(String(reader.result));
          const patch = {};
          if (Array.isArray(payload.playlists)) patch.playlists = payload.playlists;
          if (Array.isArray(payload.liked)) patch.liked = payload.liked;
          if (Array.isArray(payload.recents)) patch.recents = payload.recents;
          if (payload.settings) patch.settings = { ...store.state.settings, ...payload.settings };
          store.set(patch);
          store.persistNow();
          toast({ kind: 'success', title: 'Library imported', text: `${pluralize((patch.playlists || []).length, 'playlist')} restored` });
          render(store.state.route, true);
          renderSidebarPlaylists();
        } catch (e) {
          toast({ kind: 'error', title: 'That file could not be read', text: 'Expected a Loru export in JSON format.' });
        }
        input.remove();
      };
      reader.readAsText(file);
    });
    input.click();
  }

  /* ============================================================
     Sidebar playlists
     ============================================================ */
  function renderSidebarPlaylists() {
    const host = $('#sidebarPlaylists');
    if (!host) return;
    const { playlists } = store.state;

    const items = [
      el('button.pl-item' + (store.state.route.name === 'collection' && store.state.route.params.id === 'liked' ? '.is-active' : ''), {
        type: 'button', onclick: () => { location.hash = '#/collection/liked'; },
      }, [
        el('span.pl-item__art', { style: { background: 'var(--accent-grad)', color: 'var(--accent-ink)' } }, icon('heart-fill')),
        el('span.pl-item__meta', [
          el('span.pl-item__name', 'Liked Songs'),
          el('span.pl-item__sub', { text: pluralize(store.state.liked.length, 'song') }),
        ]),
      ]),
    ];

    playlists.forEach((pl) => {
      const active = store.state.route.name === 'playlist' && store.state.route.params.id === pl.id;
      const art = el('span.pl-item__art');
      if (pl.artwork || (pl.tracks[0] && pl.tracks[0].artwork)) {
        art.appendChild(el('img', { src: pl.artwork || pl.tracks[0].artwork, alt: '', loading: 'lazy' }));
      } else {
        art.style.background = L.gradientFor(pl.name);
        art.appendChild(icon('library'));
      }
      items.push(el('button.pl-item' + (active ? '.is-active' : ''), {
        type: 'button',
        onclick: () => { location.hash = `#/playlist/${pl.id}`; },
        oncontextmenu: (e) => {
          e.preventDefault();
          ui.openMenu(e, [
            { label: 'Play', icon: 'play', onClick: () => engine.playCollection(pl.tracks, 0, { type: 'playlist', id: pl.id, name: pl.name }) },
            { label: 'Queue all', icon: 'queue', onClick: () => engine.addManyToQueue(pl.tracks) },
            '-',
            { label: 'Rename', icon: 'more', onClick: () => renamePlaylistModal(pl) },
            { label: 'Delete', icon: 'trash', danger: true, onClick: () => ui.confirmModal({
              title: `Delete “${pl.name}”?`, confirmLabel: 'Delete', danger: true,
              onConfirm: () => { store.deletePlaylist(pl.id); renderSidebarPlaylists(); if (store.state.route.params.id === pl.id) location.hash = '#/library'; },
            }) },
          ]);
        },
      }, [
        art,
        el('span.pl-item__meta', [
          el('span.pl-item__name', { text: pl.name }),
          el('span.pl-item__sub', { text: `${(ui.SOURCE_META[pl.source] || ui.SOURCE_META.local).label} · ${pluralize(pl.tracks.length, 'track')}` }),
        ]),
      ]));
    });

    if (!playlists.length) {
      items.push(el('div', { style: { padding: '14px 10px', fontSize: 'var(--fs-xs)', color: 'var(--ink-3)', lineHeight: '1.5' } },
        'No playlists yet. Paste a Spotify or YouTube link to bring yours in.'));
    }

    host.replaceChildren(...items);
  }

  /* ============================================================
     Router entry
     ============================================================ */
  const ROUTES = {
    home: viewHome,
    search: viewSearch,
    library: viewLibrary,
    playlist: viewPlaylist,
    collection: viewCollection,
    genre: viewGenre,
    mood: viewMood,
    sources: viewSources,
    settings: viewSettings,
    'audius-playlist': viewAudiusPlaylist,
    'audius-artist': viewAudiusArtist,
  };

  let lastRenderKey = '';

  function render(route, force = false) {
    const wrap = $('#viewWrap');
    if (!wrap) return;
    const key = route.name + ':' + JSON.stringify(route.params);
    if (!force && key === lastRenderKey) return;
    lastRenderKey = key;

    const builder = ROUTES[route.name] || viewHome;
    let node;
    try {
      node = builder(route.params || {});
    } catch (err) {
      console.error(err);
      node = el('div.view', ui.errorState(err.message || 'Unexpected error while rendering this page.'));
    }
    wrap.replaceChildren(node);
    wrap.scrollTop = 0;
    renderSidebarPlaylists();
  }

  /* Keep the sidebar in step with library changes made from anywhere. */
  store.on(['playlists', 'liked'], debounce(renderSidebarPlaylists, 80));

  L.views = {
    render, renderSidebarPlaylists, runImport,
    openSpotifySetup, connectSpotify, importSpotifyLibrary,
    data, invalidate: () => { lastRenderKey = ''; },
  };
})(window.Loru);
