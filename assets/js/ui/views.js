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
  /* Where music comes from lives in data.js */
  const data = L.data;

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

    /* ---- trending, blended across services ---- */
    const trendHead = el('div.section__head', [
      el('div', [
        el('h2.section__title', { text: data.demo ? 'Demo picks' : 'Trending now' }),
        el('div.section__sub', { id: 'chartsSub', text: data.demo ? 'Offline sample catalogue' : 'Loading the charts…' }),
      ]),
    ]);
    view.appendChild(el('section.section', [
      trendHead,
      asyncBlock(
        () => data.trendingEverywhere(),
        (result) => {
          const sub = trendHead.querySelector('#chartsSub');
          if (sub && !data.demo && result.sources) {
            const names = result.sources.map((x) => (ui.SOURCE_META[x] || ui.SOURCE_META.local).label);
            sub.textContent = `Live from ${names.join(' · ')}`;
          }
          return trackRail(result.tracks, { type: 'collection', id: 'trending', name: 'Trending now' });
        },
      ),
    ]));

    /* ---- recommendations built from listening history ---- */
    view.appendChild(ui.section(
      { title: 'Made for you', sub: 'Built from the artists you actually play' },
      asyncBlock(
        () => data.recommendations(),
        (rec) => el('div', [
          rec.seeds && rec.seeds.length
            ? el('div.section__sub', { style: { margin: '-10px 0 12px' }, text: `Because you played ${rec.seeds.slice(0, 3).join(', ')}` })
            : null,
          trackRail(rec.tracks, { type: 'collection', id: 'recommended', name: 'Made for you' }),
        ]),
        {
          onEmpty: () => ui.emptyState({
            compact: true, icon: 'sparkle',
            title: 'Play a few songs first',
            text: 'Recommendations appear once Loru knows which artists you like.',
          }),
        },
      ),
    ));

    /* ---- spotify, only when connected ---- */
    if (data.spotifyReady) {
      view.appendChild(ui.section(
        { title: 'New on Spotify', sub: 'Fresh releases and your most played' },
        asyncBlock(
          () => data.spotifyPicks(),
          (tracks) => trackRail(tracks, { type: 'collection', id: 'spotify-picks', name: 'New on Spotify' }),
          { onEmpty: () => ui.emptyState({ compact: true, title: 'Nothing from Spotify right now' }) },
        ),
      ));
    }

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
        ['all', 'Everything'], ['youtube', 'YouTube'], ['apple', 'Apple'], ['audius', 'Audius'],
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

    /* Apple: best-quality metadata and instant ad-free previews. */
    if (!data.demo && (searchFilter === 'all' || searchFilter === 'apple')) {
      view.appendChild(ui.section(
        { title: 'Apple Music catalogue', sub: '30-second previews play instantly · tap ⋯ for the full song' },
        asyncBlock(
          () => L.itunes.search(q, { limit: 18 }),
          (tracks) => ui.trackList(tracks, { context: { type: 'search', id: 'ap:' + q, name: `Apple: ${q}` } }),
          {
            skeleton: ui.skeletonRows(5),
            onEmpty: () => ui.emptyState({ compact: true, title: 'Nothing on Apple Music for that' }),
            onError: (err, retry) => ui.emptyState({
              compact: true, icon: 'apple', title: 'Apple search unavailable', text: err.message,
              actions: [{ label: 'Try again', icon: 'repeat', variant: 'soft', onClick: retry }],
            }),
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
      await L.viewkit.runImport(raw, { onStatus: (m) => { status.textContent = m; } });
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
  /* Screens contributed by other view modules (see views-manage.js) */
  const ROUTES = {
    home: viewHome,
    search: viewSearch,
    library: viewLibrary,
    playlist: viewPlaylist,
    collection: viewCollection,
    genre: viewGenre,
    mood: viewMood,
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

    const builder = ROUTES[route.name] || (L.viewpages && L.viewpages[route.name]) || viewHome;
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

  L.viewkit = Object.assign(L.viewkit || {}, {
    asyncBlock, offlineState, playlistCard, trackRail, collectionView, saveAsPlaylist,
  });

  L.views = {
    render, renderSidebarPlaylists,
    data,
    runImport: (...a) => L.viewkit.runImport(...a),
    openSpotifySetup: (...a) => L.viewkit.openSpotifySetup(...a),
    connectSpotify: (...a) => L.viewkit.connectSpotify(...a),
    invalidate: () => { lastRenderKey = ''; },
  };
})(window.Loru);
