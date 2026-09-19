/* ============================================================
   Loru Player — ui/components.js
   Shared renderers: cards, track rows, modals, menus, states
   ============================================================ */
(function (L) {
  'use strict';

  const { el, icon, $, store, engine, formatTime, formatCount, gradientFor, setArt, toast, clamp } = L;

  const SOURCE_META = {
    spotify: { label: 'Spotify', icon: 'spotify' },
    youtube: { label: 'YouTube', icon: 'youtube' },
    audius: { label: 'Audius', icon: 'wave' },
    url: { label: 'Stream', icon: 'globe' },
    demo: { label: 'Demo', icon: 'sparkle' },
    local: { label: 'Loru', icon: 'sparkle' },
  };

  function sourceBadge(source, { compact = false } = {}) {
    const meta = SOURCE_META[source] || SOURCE_META.local;
    return el('span.source-badge', { dataset: { source } }, [
      icon(meta.icon),
      compact ? null : meta.label,
    ]);
  }

  /* ---------------- artwork ---------------- */
  function artwork(src, seed, cls = '') {
    const node = el('div.art' + (cls ? '.' + cls.split(' ').join('.') : ''), [
      el('img', { alt: '', loading: 'lazy', decoding: 'async' }),
      el('span.art__placeholder', icon('wave')),
    ]);
    setArt(node, src, seed);
    return node;
  }

  /* ---------------- media card ---------------- */
  function mediaCard({ title, sub, artwork: art, badge, onOpen, onPlay, seed }) {
    const card = el('button.card', { type: 'button', onclick: (e) => { if (!e.target.closest('.card__play')) onOpen && onOpen(); } }, [
      el('div.card__art', [
        artwork(art, seed || title),
        onPlay ? el('button.play-btn.card__play', {
          type: 'button',
          'aria-label': `Play ${title}`,
          onclick: (e) => { e.stopPropagation(); onPlay(); },
        }, icon('play')) : null,
        badge ? el('span.card__badge', sourceBadge(badge, { compact: true })) : null,
      ]),
      el('div.card__body', [
        el('div.card__title', { text: title || 'Untitled' }),
        sub ? el('div.card__sub', { text: sub }) : null,
      ]),
    ]);
    return card;
  }

  /* ---------------- quick tile ---------------- */
  function quickTile({ title, sub, artwork: art, onOpen, onPlay, seed }) {
    return el('button.tile', { type: 'button', onclick: (e) => { if (!e.target.closest('.tile__play')) onOpen && onOpen(); } }, [
      artwork(art, seed || title, 'art--sm'),
      el('div.tile__body', [
        el('div.tile__title', { text: title }),
        sub ? el('div.tile__sub', { text: sub }) : null,
      ]),
      onPlay ? el('button.play-btn.tile__play', {
        type: 'button', 'aria-label': `Play ${title}`,
        onclick: (e) => { e.stopPropagation(); onPlay(); },
      }, icon('play')) : null,
    ]);
  }

  /* ---------------- mood tile ---------------- */
  function moodTile(mood, onOpen) {
    const hue = mood.hue || 260;
    return el('button.mood', {
      type: 'button',
      onclick: onOpen,
      style: { background: `linear-gradient(140deg, hsl(${hue} 76% 54%), hsl(${(hue + 46) % 360} 70% 40%))` },
    }, [
      el('span', { text: mood.name }),
      el('span.mood__deco', icon(mood.icon || 'wave')),
    ]);
  }

  /* ---------------- track row ---------------- */
  /**
   * @param track  normalized track
   * @param opts   { index, tracks, context, showAlbum, onPlay, onRemove }
   */
  function trackRow(track, opts = {}) {
    const { index = 0, tracks, context, showAlbum = true, onRemove } = opts;
    const current = store.currentTrack();
    const isCurrent = current && store.trackKey(current) === store.trackKey(track);
    const liked = store.isLiked(track);

    function playThis() {
      if (opts.onPlay) { opts.onPlay(track, index); return; }
      if (tracks && tracks.length) engine.playCollection(tracks, index, context);
      else engine.playTrack(track, context);
    }

    const likeBtn = el('button.icon-btn.icon-btn--sm.icon-btn--like' + (liked ? '.is-active' : ''), {
      type: 'button',
      'aria-label': liked ? 'Remove from Liked Songs' : 'Save to Liked Songs',
      'aria-pressed': liked ? 'true' : 'false',
      onclick: (e) => {
        e.stopPropagation();
        const now = store.toggleLike(track);
        likeBtn.classList.toggle('is-active', now);
        likeBtn.setAttribute('aria-pressed', now ? 'true' : 'false');
        likeBtn.replaceChildren(icon(now ? 'heart-fill' : 'heart'));
        toast({ kind: 'success', title: now ? 'Added to Liked Songs' : 'Removed from Liked Songs', text: track.title, timeout: 2400 });
      },
    }, icon(liked ? 'heart-fill' : 'heart'));

    const row = el('div.track' + (isCurrent ? '.is-current' : ''), {
      tabindex: '0',
      role: 'button',
      dataset: { key: store.trackKey(track) },
      'aria-label': `Play ${track.title} by ${track.artist}`,
      ondblclick: playThis,
      onclick: (e) => { if (!e.target.closest('button')) playThis(); },
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playThis(); }
      },
      oncontextmenu: (e) => { e.preventDefault(); openTrackMenu(e, track, { tracks, index, onRemove }); },
    }, [
      el('div.track__index', [
        el('span.track__index-num', { text: String(index + 1) }),
        el('span.track__index-play', icon(isCurrent && store.state.playing ? 'pause' : 'play')),
      ]),
      el('div.track__main', [
        artwork(track.artwork, track.title, 'art--xs'),
        el('div.track__text', [
          el('div.track__title', { text: track.title || 'Untitled' }),
          el('div.track__artist', { text: track.artist || 'Unknown artist' }),
        ]),
      ]),
      el('div.track__album', { text: showAlbum ? (track.album || track.genre || '') : '' }),
      el('div.track__meta', {
        title: track.plays ? `${formatCount(track.plays)} plays` : '',
      }, [
        sourceBadge(track.source, { compact: true }),
        track.plays ? el('span.track__plays', { text: formatCount(track.plays) }) : null,
      ]),
      el('div.track__actions', [
        likeBtn,
        el('span.track__time', { text: track.duration ? formatTime(track.duration) : (track.isStream ? 'LIVE' : '–:–') }),
        el('button.icon-btn.icon-btn--sm', {
          type: 'button', 'aria-label': 'More options',
          onclick: (e) => { e.stopPropagation(); openTrackMenu(e, track, { tracks, index, onRemove }); },
        }, icon('more')),
      ]),
    ]);

    return row;
  }

  function tracklistHead() {
    return el('div.tracklist__head', [
      el('span', '#'),
      el('span', 'Title'),
      el('span', 'Album / genre'),
      el('span', 'Source'),
      el('span', 'Length'),
    ]);
  }

  function trackList(tracks, opts = {}) {
    const list = el('div.tracklist');
    if (opts.head !== false) list.appendChild(tracklistHead());
    (tracks || []).forEach((t, i) => list.appendChild(trackRow(t, { ...opts, index: i, tracks })));
    return list;
  }

  /* ---------------- queue row ---------------- */
  function queueRow(track, index) {
    const isCurrent = index === store.state.index;
    const row = el('div.qrow' + (isCurrent ? '.is-current' : ''), {
      draggable: 'true',
      dataset: { index: String(index) },
      onclick: (e) => {
        if (e.target.closest('button')) return;
        store.set({ index });
        engine.load(store.state.queue[index], { autoplay: true });
      },
      oncontextmenu: (e) => { e.preventDefault(); openTrackMenu(e, track, { queueIndex: index }); },
    }, [
      el('span.qrow__grip', icon('grip')),
      artwork(track.artwork, track.title, 'art--xs'),
      el('div.qrow__body', [
        el('div.qrow__title', { text: track.title }),
        el('div.qrow__artist', { text: track.artist }),
      ]),
      el('button.icon-btn.icon-btn--sm.qrow__x', {
        type: 'button', 'aria-label': 'Remove from queue',
        onclick: (e) => { e.stopPropagation(); engine.removeFromQueue(index); },
      }, icon('close')),
    ]);
    return row;
  }

  /* ---------------- skeletons & states ---------------- */
  function skeletonCards(n = 6) {
    return el('div.grid.grid--cards', Array.from({ length: n }, () =>
      el('div.sk-card', [
        el('div.skeleton.sk-card__art'),
        el('div.skeleton.sk-line'),
        el('div.skeleton.sk-line.sk-line--sm'),
      ])));
  }

  function skeletonRows(n = 6) {
    return el('div', Array.from({ length: n }, () =>
      el('div.sk-row', [
        el('div.skeleton', { style: { width: '40px', height: '40px', borderRadius: '7px', flex: 'none' } }),
        el('div', { style: { flex: '1', display: 'grid', gap: '7px' } }, [
          el('div.skeleton.sk-line', { style: { width: (55 + Math.random() * 30).toFixed(0) + '%' } }),
          el('div.skeleton.sk-line.sk-line--sm'),
        ]),
      ])));
  }

  function emptyState({ icon: iconName = 'wave', title, text, actions, compact = false }) {
    return el('div.empty' + (compact ? '.empty--compact' : ''), [
      el('div.empty__art', icon(iconName)),
      el('div.empty__title', { text: title }),
      text ? el('div.empty__text', { text }) : null,
      actions && actions.length
        ? el('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center', marginTop: '6px' } },
          actions.map((a) => el('button.btn.' + (a.variant ? 'btn--' + a.variant : 'btn--soft'), {
            type: 'button', onclick: a.onClick,
          }, [a.icon ? icon(a.icon) : null, a.label])))
        : null,
    ]);
  }

  function errorState(message, onRetry) {
    return emptyState({
      icon: 'info',
      title: 'Couldn’t load that',
      text: message,
      actions: onRetry ? [{ label: 'Try again', icon: 'repeat', variant: 'soft', onClick: onRetry }] : [],
    });
  }

  function sectionHead({ title, sub, link }) {
    return el('div.section__head', [
      el('div', [
        el('h2.section__title', { text: title }),
        sub ? el('div.section__sub', { text: sub }) : null,
      ]),
      link ? el('button.section__link', { type: 'button', onclick: link.onClick }, [link.label, icon('chevron-right')]) : null,
    ]);
  }

  function section(head, body) {
    return el('section.section', [sectionHead(head), body]);
  }

  /* ---------------- modal ---------------- */
  let modalCloser = null;

  function openModal({ title, desc, body, foot, wide = false, onClose }) {
    closeModal();
    const root = $('#modalRoot');
    if (!root) return { close() {} };

    const dialog = el('div.modal' + (wide ? '.modal--wide' : ''), {
      role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog',
    }, [
      el('div.modal__head', [
        el('div', [
          el('div.modal__title', { text: title }),
          desc ? el('div.modal__desc', { text: desc }) : null,
        ]),
        el('button.icon-btn.modal__x', { type: 'button', 'aria-label': 'Close', onclick: () => close() }, icon('close')),
      ]),
      el('div.modal__body', body),
      foot ? el('div.modal__foot' + (foot.split ? '.modal__foot--split' : ''), foot.children || foot) : null,
    ]);

    root.replaceChildren(dialog);
    root.hidden = false;
    root.onclick = (e) => { if (e.target === root) close(); };

    const prevFocus = document.activeElement;
    // Prefer a text field over a button so typing works straight away
    const target = dialog.querySelector('input:not([type="file"]), textarea, select')
      || dialog.querySelector('.modal__foot button, button:not(.modal__x)')
      || dialog;
    setTimeout(() => { target.focus && target.focus(); }, 60);

    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Tab') {
        const items = Array.from(dialog.querySelectorAll('a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])'))
          .filter((n) => !n.disabled && n.offsetParent !== null);
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey, true);

    function close() {
      document.removeEventListener('keydown', onKey, true);
      root.hidden = true;
      root.replaceChildren();
      root.onclick = null;
      modalCloser = null;
      onClose && onClose();
      if (prevFocus && prevFocus.focus) prevFocus.focus();
    }

    modalCloser = close;
    return { close, dialog };
  }

  function closeModal() { if (modalCloser) modalCloser(); }

  /* ---------------- context menu ---------------- */
  function openMenu(event, items) {
    const root = $('#ctxRoot');
    if (!root) return;
    root.hidden = false;
    root.replaceChildren();

    const menu = el('div.ctx', { role: 'menu' }, items.map((item) => {
      if (item === '-') return el('div.ctx__sep');
      if (item.label && item.heading) return el('div.ctx__label', { text: item.label });
      return el('button.ctx__item' + (item.danger ? '.ctx__item--danger' : ''), {
        type: 'button', role: 'menuitem',
        onclick: () => { close(); item.onClick && item.onClick(); },
      }, [item.icon ? icon(item.icon) : null, item.label]);
    }));

    root.appendChild(menu);

    const pad = 10;
    const rect = menu.getBoundingClientRect();
    const x = clamp((event.clientX ?? 0), pad, window.innerWidth - rect.width - pad);
    const y = clamp((event.clientY ?? 0), pad, window.innerHeight - rect.height - pad);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    function close() {
      root.hidden = true;
      root.replaceChildren();
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    root.onclick = (e) => { if (e.target === root) close(); };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close, { once: true });
    setTimeout(() => menu.querySelector('.ctx__item') && menu.querySelector('.ctx__item').focus(), 40);
  }

  /** Standard track context menu. */
  function openTrackMenu(event, track, { tracks, index, onRemove, queueIndex } = {}) {
    const liked = store.isLiked(track);
    const items = [
      { label: 'Play now', icon: 'play', onClick: () => (tracks ? engine.playCollection(tracks, index, store.state.context) : engine.playTrack(track)) },
      { label: 'Play next', icon: 'next', onClick: () => engine.addToQueue(track, { next: true }) },
      { label: 'Add to queue', icon: 'queue', onClick: () => engine.addToQueue(track) },
      '-',
      { label: liked ? 'Remove from Liked Songs' : 'Save to Liked Songs', icon: liked ? 'heart-fill' : 'heart', onClick: () => {
        const now = store.toggleLike(track);
        toast({ kind: 'success', title: now ? 'Added to Liked Songs' : 'Removed from Liked Songs', text: track.title, timeout: 2200 });
      } },
      { label: 'Add to playlist…', icon: 'plus', onClick: () => openAddToPlaylist([track]) },
    ];

    if (queueIndex !== undefined) {
      items.push('-', { label: 'Remove from queue', icon: 'trash', danger: true, onClick: () => engine.removeFromQueue(queueIndex) });
    }
    if (onRemove) {
      items.push('-', { label: 'Remove from this playlist', icon: 'trash', danger: true, onClick: () => onRemove(track) });
    }
    if (track.permalink) {
      items.push('-', { label: 'Open original', icon: 'globe', onClick: () => window.open(track.permalink, '_blank', 'noopener') });
      items.push({ label: 'Copy link', icon: 'link', onClick: async () => {
        const ok = await L.copyToClipboard(track.permalink);
        toast({ kind: ok ? 'success' : 'error', title: ok ? 'Link copied' : 'Could not copy link', timeout: 2000 });
      } });
    }

    openMenu(event, items);
  }

  /** "Add to playlist" picker. */
  function openAddToPlaylist(tracks) {
    const list = store.state.playlists;

    const body = [
      el('button.opt', { type: 'button', onclick: () => {
        modal.close();
        openCreatePlaylist(tracks);
      } }, [
        el('span.opt__icon', icon('plus')),
        el('span.opt__body', [
          el('span.opt__title', 'New playlist'),
          el('span.opt__sub', { text: `Start a playlist with ${L.pluralize(tracks.length, 'track')}` }),
        ]),
      ]),
    ];

    if (list.length) {
      body.push(el('div.opt-list', list.map((pl) => el('button.opt', {
        type: 'button',
        onclick: () => {
          const added = store.addTracksToPlaylist(pl.id, tracks);
          modal.close();
          toast({
            kind: 'success',
            title: added ? `Added to ${pl.name}` : 'Already in that playlist',
            text: added ? L.pluralize(added, 'track') + ' added' : null,
          });
        },
      }, [
        el('span.opt__icon', pl.artwork ? el('img', { src: pl.artwork, alt: '', style: { width: '100%', height: '100%', borderRadius: '10px' } }) : icon('library')),
        el('span.opt__body', [
          el('span.opt__title', { text: pl.name }),
          el('span.opt__sub', { text: `${L.pluralize(pl.tracks.length, 'track')} · ${(SOURCE_META[pl.source] || SOURCE_META.local).label}` }),
        ]),
      ]))));
    }

    const modal = openModal({
      title: 'Add to playlist',
      desc: tracks.length === 1 ? tracks[0].title : `${tracks.length} tracks`,
      body,
    });
    return modal;
  }

  function openCreatePlaylist(tracks = []) {
    const nameInput = el('input.input', { type: 'text', placeholder: 'My playlist', maxlength: '80' });
    const descInput = el('textarea.textarea', { placeholder: 'Optional description', maxlength: '300' });

    function create() {
      const name = nameInput.value.trim() || 'My playlist';
      const pl = store.createPlaylist({ name, description: descInput.value.trim(), tracks, source: 'local' });
      modal.close();
      toast({ kind: 'success', title: 'Playlist created', text: name });
      location.hash = `#/playlist/${pl.id}`;
    }

    const modal = openModal({
      title: 'Create playlist',
      desc: tracks.length ? `Starting with ${L.pluralize(tracks.length, 'track')}` : 'Playlists are saved in this browser',
      body: [
        el('label.field', [el('span.field__label', 'Name'), nameInput]),
        el('label.field', [el('span.field__label', 'Description'), descInput]),
      ],
      foot: { children: [
        el('button.btn.btn--ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
        el('button.btn.btn--primary', { type: 'button', onclick: create }, [icon('plus'), 'Create']),
      ] },
    });

    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
    return modal;
  }

  /* ---------------- confirm ---------------- */
  function confirmModal({ title, desc, confirmLabel = 'Confirm', danger = false, onConfirm }) {
    const modal = openModal({
      title, desc,
      body: [],
      foot: { children: [
        el('button.btn.btn--ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
        el('button.btn.' + (danger ? 'btn--danger' : 'btn--primary'), {
          type: 'button', onclick: () => { modal.close(); onConfirm && onConfirm(); },
        }, confirmLabel),
      ] },
    });
    return modal;
  }

  L.ui = Object.assign(L.ui || {}, {
    SOURCE_META, sourceBadge, artwork,
    mediaCard, quickTile, moodTile,
    trackRow, trackList, tracklistHead, queueRow,
    skeletonCards, skeletonRows, emptyState, errorState,
    section, sectionHead,
    openModal, closeModal, openMenu, openTrackMenu,
    openAddToPlaylist, openCreatePlaylist, confirmModal,
  });
})(window.Loru);
