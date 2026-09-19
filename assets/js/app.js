/* ============================================================
   Loru Player — app.js
   Router, chrome wiring, keyboard control, boot sequence
   ============================================================ */
(function (L) {
  'use strict';

  const { $, $$, el, icon, store, engine, views, player, ui, spotify, importer, catalog, toast, debounce } = L;

  /* ============================================================
     Routing
     ============================================================ */
  function parseHash(hash) {
    const raw = String(hash || '').replace(/^#\/?/, '');
    const [pathPart, queryPart] = raw.split('?');
    const segments = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
    const params = {};
    if (queryPart) {
      new URLSearchParams(queryPart).forEach((v, k) => { params[k] = v; });
    }

    if (!segments.length) return { name: 'home', params };

    const [a, b, c] = segments;

    if (a === 'audius' && b === 'playlist' && c) return { name: 'audius-playlist', params: { ...params, id: c } };
    if (a === 'audius' && b === 'artist' && c) return { name: 'audius-artist', params: { ...params, id: c } };
    if (['playlist', 'collection', 'genre', 'mood'].includes(a)) return { name: a, params: { ...params, id: b || '' } };
    if (['home', 'search', 'library', 'sources', 'settings'].includes(a)) return { name: a, params };

    return { name: 'home', params };
  }

  function onRouteChange() {
    const route = parseHash(location.hash);
    store.set({ route });
    views.render(route);
    syncNav(route);
    syncSearchInput(route);
    if (window.matchMedia('(max-width: 768px)').matches) setDrawer(false);
  }

  function syncNav(route) {
    const active = route.name === 'collection' || route.name === 'playlist' ? 'library'
      : route.name === 'genre' || route.name === 'mood' || route.name.startsWith('audius') ? 'search'
        : route.name;
    $$('[data-route]').forEach((node) => {
      node.classList.toggle('is-active', node.dataset.route === active);
      if (node.dataset.route === active) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    });
  }

  function syncSearchInput(route) {
    const input = $('#searchInput');
    if (!input) return;
    const q = route.name === 'search' ? (route.params.q || '') : '';
    if (document.activeElement !== input) input.value = q;
    $('#searchClear').hidden = !input.value;
  }

  function navigate(hash) {
    if (location.hash === hash) onRouteChange();
    else location.hash = hash;
  }

  /* ============================================================
     Theme / accent
     ============================================================ */
  function setTheme(theme) {
    const value = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = value;
    store.updateSettings({ theme: value });
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', value === 'light' ? '#f6f6fb' : '#07070c');
    const use = $('#themeIcon');
    if (use) use.innerHTML = value === 'light'
      ? '<circle cx="12" cy="12" r="4.4" fill="currentColor"/><path d="M12 3v2.2M12 18.8V21M4.5 12H2.3M21.7 12h-2.2M6.2 6.2 4.7 4.7M19.3 19.3l-1.5-1.5M6.2 17.8l-1.5 1.5M19.3 4.7l-1.5 1.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
      : '<path d="M12 4.5a7.5 7.5 0 1 0 7.5 7.5A5.6 5.6 0 0 1 12 4.5Z" fill="currentColor"/>';
  }

  function setAccent(name) {
    document.documentElement.dataset.accent = name;
    store.updateSettings({ accent: name });
  }

  /* ============================================================
     Sidebar / drawer
     ============================================================ */
  function setDrawer(open) {
    store.set({ drawerOpen: open });
    $('#app').dataset.drawer = open ? 'open' : 'closed';
    const scrim = $('#sidebarScrim');
    if (scrim) scrim.hidden = !open;
    $('#btnMenu').setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function setSidebarCollapsed(collapsed) {
    store.set({ sidebarCollapsed: collapsed });
    $('#app').dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
    const btn = $('#sidebarCollapse');
    if (btn) btn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  }

  /* ============================================================
     Search bar
     ============================================================ */
  /** Top-bar source switch: decides where browse and search pull from. */
  function initSourceSwitch() {
    const root = $('#sourceSwitch');
    if (!root) return;

    const paint = () => {
      const current = store.state.settings.defaultSource || 'youtube';
      $$('.source-switch__btn', root).forEach((btn) => {
        const on = btn.dataset.source === current;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    };

    const LABELS = {
      youtube: 'YouTube — every song, played in full',
      apple: 'Apple Music — 30-second previews, ad-free',
      audius: 'Audius — free and ad-free, independent artists',
    };

    root.addEventListener('click', (e) => {
      const btn = e.target.closest('.source-switch__btn');
      if (!btn) return;
      const source = btn.dataset.source;
      if (source === store.state.settings.defaultSource) return;
      store.updateSettings({ defaultSource: source });
      paint();
      views.invalidate();
      views.render(store.state.route, true);
      toast({ title: 'Now playing from', text: LABELS[source], timeout: 2600 });
    });

    store.on('settings', paint);
    paint();
  }

  function initSearch() {
    const form = $('#searchForm');
    const input = $('#searchInput');
    const clear = $('#searchClear');

    const go = debounce((value) => {
      const v = value.trim();
      if (!v) { if (store.state.route.name === 'search') navigate('#/search'); return; }
      navigate(`#/search?q=${encodeURIComponent(v)}`);
    }, 420);

    input.addEventListener('input', () => {
      clear.hidden = !input.value;
      // don't fire a search request for every keystroke of a long URL
      if (importer.looksLikeLink(input.value)) return;
      go(input.value);
    });

    input.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData) && (e.clipboardData || window.clipboardData).getData('text');
      if (text && importer.looksLikeLink(text)) {
        setTimeout(() => navigate(`#/search?q=${encodeURIComponent(text.trim())}`), 30);
      }
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      if (importer.looksLikeLink(v)) { views.runImport(v); input.blur(); return; }
      navigate(`#/search?q=${encodeURIComponent(v)}`);
      input.blur();
    });

    clear.addEventListener('click', () => {
      input.value = '';
      clear.hidden = true;
      input.focus();
      if (store.state.route.name === 'search') navigate('#/search');
    });
  }

  /* ============================================================
     Chrome wiring
     ============================================================ */
  function initChrome() {
    $('#btnMenu').addEventListener('click', () => setDrawer(!store.state.drawerOpen));
    $('#sidebarScrim').addEventListener('click', () => setDrawer(false));
    $('#sidebarCollapse').addEventListener('click', () => setSidebarCollapsed(!store.state.sidebarCollapsed));
    $('#btnTheme').addEventListener('click', () => setTheme(store.state.settings.theme === 'dark' ? 'light' : 'dark'));
    $('#btnBack').addEventListener('click', () => history.back());
    $('#btnForward').addEventListener('click', () => history.forward());
    $('#btnNewPlaylist').addEventListener('click', () => ui.openCreatePlaylist([]));
    $('#btnQuickLink').addEventListener('click', () => navigate('#/sources'));
    $('#btnShortcuts').addEventListener('click', showShortcuts);

    // internal links
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[data-nav]');
      if (!link) return;
      const href = link.getAttribute('href');
      if (!href || !href.startsWith('#')) return;
      e.preventDefault();
      navigate(href);
    });

    // topbar shadow on scroll
    const wrap = $('#viewWrap');
    wrap.addEventListener('scroll', () => {
      $('#topbar').classList.toggle('is-stuck', wrap.scrollTop > 8);
    }, { passive: true });

    // close the queue sheet when tapping the scrim area on mobile
    window.addEventListener('resize', debounce(() => {
      detectDevice();
      if (!window.matchMedia('(max-width: 768px)').matches) setDrawer(false);
      L.visualizer.resize();
    }, 200));

    window.addEventListener('orientationchange', () => setTimeout(detectDevice, 120));

    window.addEventListener('online', () => {
      toast({ kind: 'success', title: 'Back online', text: 'Streaming services are reachable again.' });
      views.invalidate();
      views.render(store.state.route, true);
    });
    window.addEventListener('offline', () => {
      toast({ kind: 'error', title: 'You’re offline', text: 'Playback will stop until the connection returns.' });
    });

    // warn before leaving mid-playback
    window.addEventListener('beforeunload', () => { store.persistNow(); });
  }

  /* ============================================================
     Keyboard shortcuts
     ============================================================ */
  const SHORTCUTS = [
    ['Space', 'Play / pause'],
    ['→ / ←', 'Seek 5s (Shift: 30s)'],
    ['↑ / ↓', 'Volume'],
    ['N / P', 'Next / previous track'],
    ['S', 'Shuffle'],
    ['R', 'Repeat mode'],
    ['M', 'Mute'],
    ['L', 'Like current track'],
    ['Q', 'Toggle queue'],
    ['F', 'Full-screen player'],
    ['/', 'Focus search'],
    ['G then H', 'Go home'],
    ['G then L', 'Go to library'],
    ['G then K', 'Go to link sources'],
    ['Esc', 'Close overlay'],
  ];

  let gPressed = false;

  function initKeyboard() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
      const inSlider = e.target.classList && e.target.classList.contains('slider');

      if (e.key === '/' && !typing) {
        e.preventDefault();
        $('#searchInput').focus();
        $('#searchInput').select();
        return;
      }

      if (e.key === 'Escape') {
        if (!$('#modalRoot').hidden) return;               // modal handles its own Esc
        if (store.state.npOpen) { player.closeNowPlaying(); return; }
        if (store.state.queueOpen) { player.toggleQueue(false); return; }
        if (store.state.drawerOpen) { setDrawer(false); return; }
        if (typing) { e.target.blur(); }
        return;
      }

      if (typing) return;

      if (gPressed) {
        gPressed = false;
        const map = { h: '#/home', l: '#/library', k: '#/sources', s: '#/search', c: '#/settings' };
        const target = map[e.key.toLowerCase()];
        if (target) { e.preventDefault(); navigate(target); return; }
      }

      switch (e.key) {
        case ' ':
          e.preventDefault();
          engine.toggle();
          break;
        case 'ArrowRight':
          if (inSlider) return;
          e.preventDefault();
          engine.nudge(e.shiftKey ? 30 : 5);
          break;
        case 'ArrowLeft':
          if (inSlider) return;
          e.preventDefault();
          engine.nudge(e.shiftKey ? -30 : -5);
          break;
        case 'ArrowUp':
          if (inSlider) return;
          e.preventDefault();
          engine.setVolume(store.state.volume + 0.05);
          break;
        case 'ArrowDown':
          if (inSlider) return;
          e.preventDefault();
          engine.setVolume(store.state.volume - 0.05);
          break;
        default: break;
      }

      switch (e.key.toLowerCase()) {
        case 'n': engine.next(false); break;
        case 'p': engine.prev(); break;
        case 's': engine.setShuffle(); break;
        case 'r': engine.cycleRepeat(); break;
        case 'm': engine.toggleMute(); break;
        case 'q': player.toggleQueue(); break;
        case 'f':
          store.state.npOpen ? player.closeNowPlaying() : player.openNowPlaying();
          break;
        case 'l': {
          const t = store.currentTrack();
          if (t) {
            const now = store.toggleLike(t);
            toast({ kind: 'success', title: now ? 'Added to Liked Songs' : 'Removed from Liked Songs', text: t.title, timeout: 1800 });
          }
          break;
        }
        case 'g': gPressed = true; setTimeout(() => { gPressed = false; }, 1200); break;
        default: break;
      }
    });
  }

  function showShortcuts() {
    ui.openModal({
      title: 'Keyboard shortcuts',
      desc: 'Works anywhere except inside a text field.',
      wide: true,
      body: [el('div.kbd-list', SHORTCUTS.map(([keys, label]) =>
        el('div.kbd-row', [el('span', { text: label }), el('kbd.kbd', { text: keys })])))],
    });
  }

  /* ============================================================
     First-run welcome
     ============================================================ */
  function maybeWelcome() {
    if (L.storage.get('seenWelcome', false)) return;
    L.storage.set('seenWelcome', true);

    const modal = ui.openModal({
      title: 'Welcome to Loru Player',
      desc: 'An online player — no files, no installs, no account.',
      body: [
        (() => {
          // Prefers a user-supplied logo.png, falling back to the bundled lockup
          const img = el('img', {
            src: 'assets/img/logo.png', alt: 'Loru Player',
            width: '260', height: '144',
            style: { width: '230px', maxWidth: '70%', margin: '0 auto 4px', display: 'block' },
          });
          img.onerror = () => { img.onerror = null; img.src = 'assets/img/logo.svg'; };
          return img;
        })(),
        el('div.opt-list', [
          optRow('wave', 'Start listening right away', 'Search or browse millions of free Audius tracks. Nothing to set up.', () => { modal.close(); navigate('#/search'); }),
          optRow('link', 'Bring your own playlists', 'Paste a YouTube playlist link, or connect Spotify to mirror yours.', () => { modal.close(); navigate('#/sources'); }),
          optRow('sparkle', 'Just show me around', 'Loads a demo catalogue so you can explore every screen offline.', () => {
            modal.close();
            views.data.enableDemo();
            navigate('#/home');
          }),
        ]),
        el('div.callout', [
          icon('info'),
          el('div', 'Loru plays each track through the service that hosts it, so artists still get their streams and views.'),
        ]),
      ],
    });
  }

  function optRow(iconName, title, sub, onClick) {
    return el('button.opt', { type: 'button', onclick: onClick }, [
      el('span.opt__icon', icon(iconName)),
      el('span.opt__body', [
        el('span.opt__title', { text: title }),
        el('span.opt__sub', { text: sub }),
      ]),
      icon('chevron-right'),
    ]);
  }

  /* ============================================================
     Boot
     ============================================================ */
  async function boot() {
    /* theme + chrome state from persisted settings */
    detectDevice();
    setTheme(store.state.settings.theme);
    setAccent(store.state.settings.accent);
    setSidebarCollapsed(store.state.sidebarCollapsed);
    $('#app').dataset.queue = 'closed';
    $('#app').dataset.drawer = 'closed';

    if (store.state.settings.demoMode) views.data.seed();

    initChrome();
    initSourceSwitch();
    initSearch();
    initKeyboard();
    engine.init();
    player.init();

    /* Spotify redirect leg, if we came back from the consent screen */
    try {
      const completed = await spotify.handleRedirect();
      if (completed) {
        const sp = store.state.connections.spotify;
        toast({
          kind: 'success',
          title: 'Spotify connected',
          text: sp.premium ? 'Premium detected — full tracks available.' : 'Free account — songs will play in full from YouTube.',
        });
      } else if (spotify.isConnected()) {
        spotify.loadProfile().catch(() => {});
      }
    } catch (err) {
      toast({ kind: 'error', title: 'Spotify connection failed', text: err.message, timeout: 7000 });
    }

    /* first route */
    if (!location.hash) location.replace('#/home');
    window.addEventListener('hashchange', onRouteChange);
    onRouteChange();

    /* ?demo=1 shortcut for previews */
    if (new URLSearchParams(location.search).get('demo') === '1') {
      L.storage.set('seenWelcome', true);
      if (!store.state.settings.demoMode) {
        store.updateSettings({ demoMode: true });
        views.data.seed();
      }
      views.render(store.state.route, true);
    } else {
      maybeWelcome();
    }

    document.body.classList.add('is-ready');
    registerServiceWorker();
  }

  /* ============================================================
     Device detection
     ------------------------------------------------------------
     Width alone is a poor signal: a touch laptop and a tablet can
     report the same width but want different hit targets, and an
     installed PWA needs different chrome than a browser tab. These
     flags land on <html> so CSS and JS can both key off them.
     ============================================================ */
  function detectDevice() {
    const root = document.documentElement;
    const w = window.innerWidth;
    const h = window.innerHeight;

    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const noHover = window.matchMedia('(hover: none)').matches;
    const touch = coarse || noHover || navigator.maxTouchPoints > 0;

    let kind;
    if (w <= 768) kind = 'phone';
    else if (w <= 1024 || (touch && w <= 1366)) kind = 'tablet';
    else kind = 'desktop';

    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;

    root.dataset.device = kind;
    root.dataset.pointer = touch ? 'touch' : 'mouse';
    root.dataset.orientation = w >= h ? 'landscape' : 'portrait';
    if (standalone) root.dataset.standalone = 'true';
    else delete root.dataset.standalone;

    // Short landscape phones need the compact now-playing layout
    root.dataset.shortScreen = (h <= 560 && w > h) ? 'true' : 'false';

    store.set({ device: kind, touch, standalone });
    return kind;
  }

  /**
   * Registers the service worker and — importantly — recovers from a stale
   * one. An earlier version cached code aggressively, which could leave a
   * browser running old JavaScript against old CSS indefinitely. This forces
   * an update check on every load and reloads once when a new worker takes
   * over, so nobody gets stuck on an old build again.
   */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;

    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
        reg.update().catch(() => {});

        // A new worker replacing an existing one means the page is running
        // code that may not match it. Reload exactly once to resynchronise.
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (sessionStorage.getItem('loru:reloaded') === '1') return;
          sessionStorage.setItem('loru:reloaded', '1');
          location.reload();
        });

        reg.addEventListener('updatefound', () => {
          const incoming = reg.installing;
          if (!incoming) return;
          incoming.addEventListener('statechange', () => {
            if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
              toast({
                title: 'Update ready',
                text: 'A newer version of Loru is available.',
                timeout: 0,
                action: { label: 'Reload', onClick: () => location.reload() },
              });
            }
          });
        });
      } catch (e) { /* not fatal */ }
    });
  }

  /** Nuclear option exposed in Settings: drop all caches and workers. */
  async function hardRefresh() {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch (e) { /* continue to reload regardless */ }
    sessionStorage.removeItem('loru:reloaded');
    location.reload();
  }

  L.app = {
    boot, navigate, setTheme, setAccent, setDrawer, setSidebarCollapsed,
    showShortcuts, parseHash, hardRefresh, detectDevice, SHORTCUTS,
    VERSION: '1.2.0',
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.Loru);
