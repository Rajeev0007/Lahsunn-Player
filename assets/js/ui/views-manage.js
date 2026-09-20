/* ============================================================
   Loru Player — ui/views-manage.js
   The two "management" screens: Link Sources and Settings,
   plus the import runner and Spotify connection helpers.

   Registers itself on L.viewpages so ui/views.js can route to it
   without importing anything.
   ============================================================ */
(function (L) {
  'use strict';

  const {
    el, icon, $, store, engine, ui, spotify, youtube, importer, catalog, toast, pluralize,
  } = L;

  const data = L.data;
  const render = (route, force) => L.views.render(route, force);
  const renderSidebarPlaylists = () => L.views.renderSidebarPlaylists();
  const srcMeta = (x) => ui.SOURCE_META[x] || ui.SOURCE_META.local;
  void srcMeta;
  const asyncBlock = (...a) => L.viewkit.asyncBlock(...a);
  const playlistCard = (...a) => L.viewkit.playlistCard(...a);

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
        }, [icon((ui.SOURCE_META[ex.source] || ui.SOURCE_META.local).icon), ex.label]))),
      ]),
    ])));

    /* ---- service cards ---- */
    const cards = el('div.grid.grid--wide');

    /* Looked up by source, not array index — the examples list changes and
       index-based access silently broke these buttons. */
    const tryExample = (source) => () => {
      const ex = catalog.LINK_EXAMPLES.find((e) => e.source === source);
      if (!ex) return;
      input.value = ex.value;
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
        : 'Connect to mirror your playlists and liked songs. A free account is enough: Loru only asks for read permission and plays the songs in full via YouTube. You supply your own free Client ID, which stays in this browser.',
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
      foot: [el('button.btn.btn--soft.btn--sm', { type: 'button', onclick: tryExample('youtube') }, [icon('link'), 'Try an example'])],
    }));

    /* SoundCloud */
    cards.appendChild(srcCard({
      color: '#ff7700',
      accent: 'linear-gradient(90deg,#ff7700,#ff3300)',
      iconName: 'soundcloud',
      title: 'SoundCloud',
      note: 'Paste a track or playlist link',
      status: 'No setup', statusKind: 'on',
      body: 'Plays through SoundCloud’s official widget, so no key or account is needed and the artist still gets the play. Searching is not possible — SoundCloud closed public API signups — so paste links directly. Tracks whose uploader disabled embedding will be skipped.',
      foot: [el('button.btn.btn--soft.btn--sm', {
        type: 'button',
        onclick: () => { input.value = 'https://soundcloud.com/'; input.focus(); },
      }, [icon('link'), 'Paste a link'])],
    }));

    /* Apple Music */
    cards.appendChild(srcCard({
      color: '#fc3c44',
      accent: 'linear-gradient(90deg,#fc3c44,#a1005e)',
      iconName: 'apple',
      title: 'Apple Music',
      note: '30-second previews, no account',
      status: 'Previews', statusKind: 'warn',
      body: 'Apple’s catalogue is searchable with no key, giving the most accurate titles and the best artwork — and every result plays instantly as an ad-free 30-second preview. Full tracks need a paid Apple Developer token plus your own subscription, so Loru instead offers one tap to play the complete song from YouTube.',
      foot: [el('button.btn.btn--soft.btn--sm', { type: 'button', onclick: () => { location.hash = '#/search'; } }, [icon('search'), 'Search Apple'])],
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
      foot: [el('button.btn.btn--soft.btn--sm', { type: 'button', onclick: tryExample('url') }, [icon('link'), 'Try a radio stream'])],
    }));

    view.appendChild(ui.section({ title: 'Supported services' }, cards));

    /* ---- not supported note ---- */
    view.appendChild(el('section.section', el('div.callout', [
      icon('info'),
      el('div', [
        el('strong', 'Deezer, Tidal and Amazon Music '),
        'cannot be supported: their APIs block browser requests outright, and full playback is restricted to their own apps. Paste one of those links and Loru will offer to find the same song on YouTube instead. Apple Music works for search and previews, but its full catalogue needs a paid developer token plus your own subscription.',
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
          ? (sp.premium ? 'Premium account detected — full tracks still play via YouTube unless you switch on Spotify’s player below.' : 'Free account — full tracks play via YouTube.')
          : 'Add a Client ID from the Spotify Developer Dashboard to read your playlists.',
        sp.connected
          ? el('button.btn.btn--soft.btn--sm', { type: 'button', onclick: () => { spotify.logout(); render(store.state.route, true); } }, 'Disconnect')
          : el('button.btn.btn--primary.btn--sm', { type: 'button', onclick: openSpotifySetup }, [icon('spotify'), 'Set up']),
      ),
      toggleRow('Use Spotify’s own player', 'Premium accounts only. Off by default — Loru plays your Spotify tracks in full through YouTube, which works on a free account and needs no extra permissions.', 'spotifyUsePremiumPlayer'),
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

    /* discord */
    view.appendChild(ui.section({ title: 'Discord presence' }, el('div.panel', [
      el('div.callout', [
        icon('info'),
        el('div', [
          el('strong', 'Needs a small helper on your computer. '),
          'Browsers cannot talk to Discord — Rich Presence uses a local socket that web pages have no access to. Run ',
          el('code', { style: { background: 'var(--surface-2)', padding: '1px 5px', borderRadius: '5px' }, text: 'node tools/discord-presence.mjs' }),
          ' and Loru will post the current track to it. Nothing leaves your machine.',
        ]),
      ]),
      toggleRow('Show what I’m listening to', 'Publishes the current track to Discord while the helper is running.', 'discordPresence', () => {
        if (store.state.settings.discordPresence) L.discord.start();
      }),
      settingRow('Helper port', 'Must match the port the helper prints on start.',
        (() => {
          const inp = el('input.input', { type: 'number', value: String(store.state.settings.discordPort || 6472), min: '1024', max: '65535', style: { width: '120px' } });
          inp.addEventListener('change', () => {
            store.updateSettings({ discordPort: Number(inp.value) || 6472 });
            toast({ kind: 'success', title: 'Port saved', timeout: 1800 });
          });
          return inp;
        })()),
      discordTestRow(),
    ])));

    /* data */
    view.appendChild(ui.section({ title: 'Your data' }, el('div.panel', [
      settingRow('Export library', 'Download your playlists, liked songs and settings as JSON.',
        el('button.btn.btn--soft.btn--sm', { type: 'button', onclick: exportLibrary }, 'Export')),
      settingRow('Import library', 'Restore from a previously exported file.',
        el('button.btn.btn--soft.btn--sm', { type: 'button', onclick: importLibrary }, 'Choose file')),
      settingRow('Force refresh', 'Clears the offline cache and reloads. Use this if the app looks broken or seems out of date.',
        el('button.btn.btn--soft.btn--sm', { type: 'button', onclick: () => L.app.hardRefresh() }, [icon('repeat'), 'Clear cache & reload'])),
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

  /** Live check against the local helper, so failures are diagnosable. */
  function discordTestRow() {
    const output = el('div.section__sub', { style: { marginTop: '10px' }, text: '' });
    const btn = el('button.btn.btn--soft.btn--sm', { type: 'button' }, [icon('repeat'), 'Test helper']);

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      output.textContent = 'Contacting helper…';
      try {
        const info = await L.discord.test();
        output.innerHTML = '';
        output.append(
          info.discord
            ? `Helper running and connected to Discord${info.user ? ' as ' + info.user : ''}.`
            : 'Helper running, but Discord is not connected — is the desktop app open?',
        );
        await L.discord.push({ force: true });
      } catch (err) {
        output.textContent = `Could not reach the helper on port ${store.state.settings.discordPort || 6472}. Start it with: node tools/discord-presence.mjs`;
      }
      btn.disabled = false;
    });

    return el('div', [
      settingRow('Check the connection', 'Verifies the helper is running and talking to Discord.', btn),
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


  L.viewpages = Object.assign(L.viewpages || {}, {
    sources: viewSources,
    settings: viewSettings,
  });

  /* Shared with other view modules */
  L.viewkit = Object.assign(L.viewkit || {}, {
    runImport, openSpotifySetup, connectSpotify, importSpotifyLibrary,
    settingRow, toggleRow,
  });
})(window.Loru);
