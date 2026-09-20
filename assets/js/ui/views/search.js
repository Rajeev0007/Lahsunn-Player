/* ============================================================
   Loru Player — ui/views/search.js
   Search across YouTube, Apple, Audius and Spotify, plus the
   pasted-link preview card.
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


  L.viewpages = Object.assign(L.viewpages || {}, { search: viewSearch });
})(window.Loru);
