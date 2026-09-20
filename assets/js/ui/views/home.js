/* ============================================================
   Loru Player — ui/views/home.js
   Home: hero, quick access, trending, recommendations, moods, genres.
   ============================================================ */
(function (L) {
  'use strict';

  const { el, icon, $, $$, store, engine, ui, audius, youtube, spotify, importer, catalog, toast, formatTime, formatTotal, formatCount, pluralize, relativeTime, setArt, debounce } = L;
  const data = L.data;

  /* Shared helpers, wrapped so load order between these files never matters. */
  const asyncBlock = (...a) => L.viewkit.asyncBlock(...a);
  const offlineState = (...a) => L.viewkit.offlineState(...a);
  const trackRail = (...a) => L.viewkit.trackRail(...a);
  const playlistCard = (...a) => L.viewkit.playlistCard(...a);
  const collectionView = (...a) => L.viewkit.collectionView(...a);
  const saveAsPlaylist = (...a) => L.viewkit.saveAsPlaylist(...a);
  const youtubeSearchError = (...a) => L.viewkit.youtubeSearchError(...a);
  const playTopResult = (...a) => L.viewkit.playTopResult(...a);
  const render = (route, force) => L.views.render(route, force);
  const renderSidebarPlaylists = () => L.views.renderSidebarPlaylists();

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


  L.viewpages = Object.assign(L.viewpages || {}, { home: viewHome });
})(window.Loru);
