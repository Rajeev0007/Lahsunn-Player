/* ============================================================
   Loru Player — ui/views/index.js  (assets/js/ui/views.js)
   Router: resolves a route to a screen registered by the view
   modules, renders it, and appends the site footer.
   ============================================================ */
(function (L) {
  'use strict';

  const { el, icon, $, $$, store, engine, ui, audius, youtube, spotify, importer, catalog, toast, formatTime, formatTotal, formatCount, pluralize, relativeTime, setArt, debounce } = L;
  const data = L.data;

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
  /* Screens register themselves on L.viewpages — see ui/views/*.js */
  const ROUTES = {};

  let lastRenderKey = '';

  function render(route, force = false) {
    const wrap = $('#viewWrap');
    if (!wrap) return;
    const key = route.name + ':' + JSON.stringify(route.params);
    if (!force && key === lastRenderKey) return;
    lastRenderKey = key;

    const builder = ROUTES[route.name] || (L.viewpages && L.viewpages[route.name]) || L.viewpages.home;
    let node;
    try {
      node = builder(route.params || {});
    } catch (err) {
      console.error(err);
      node = el('div.view', ui.errorState(err.message || 'Unexpected error while rendering this page.'));
    }
    wrap.replaceChildren(node, appFooter());
    wrap.scrollTop = 0;
    renderSidebarPlaylists();
  }

  /* Keep the sidebar in step with library changes made from anywhere. */
  store.on(['playlists', 'liked'], debounce(renderSidebarPlaylists, 80));

  L.views = {
    render, renderSidebarPlaylists,
    data,
    runImport: (...a) => L.viewkit.runImport(...a),
    openSpotifySetup: (...a) => L.viewkit.openSpotifySetup(...a),
    connectSpotify: (...a) => L.viewkit.connectSpotify(...a),
    invalidate: () => { lastRenderKey = ''; },
  };

  /** Site credit, appended below every screen. */
  function appFooter() {
    return el('footer.app-footer', [
      el('span.app-footer__brand', [
        el('img', { src: 'assets/img/logo.svg', alt: '', width: '18', height: '18', decoding: 'async' }),
        'Loru Player',
      ]),
      el('span.app-footer__sep', '·'),
      el('a.app-footer__credit', {
        href: 'https://github.com/Rajeev0007', target: '_blank', rel: 'noopener',
      }, ['Made by ', el('strong', 'Rajeev'), ' ', el('span.app-footer__tag', '</>')]),
      el('span.app-footer__sep', '·'),
      el('span', { text: 'v' + ((L.app && L.app.VERSION) || '1.2.0') }),
    ]);
  }

  L.viewkit = Object.assign(L.viewkit || {}, { appFooter });
})(window.Loru);
