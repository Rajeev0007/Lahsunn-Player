/* ============================================================
   Loru Player — ui/views/library.js
   Your library, saved playlists, liked songs, history, and the
   genre / mood / Audius collection pages.
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
  const youtubeSearchError = (...a) => L.viewkit.youtubeSearchError(...a);
  const playTopResult = (...a) => L.viewkit.playTopResult(...a);
  const render = (route, force) => L.views.render(route, force);
  const renderSidebarPlaylists = () => L.views.renderSidebarPlaylists();

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


  L.viewkit = Object.assign(L.viewkit || {}, { collectionView, saveAsPlaylist });

  L.viewpages = Object.assign(L.viewpages || {}, {
    library: viewLibrary,
    playlist: viewPlaylist,
    collection: viewCollection,
    genre: viewGenre,
    mood: viewMood,
    'audius-playlist': viewAudiusPlaylist,
    'audius-artist': viewAudiusArtist,
  });
})(window.Loru);
