/* ============================================================
   Loru Player — ui/player.js
   Player bar, full-screen now playing, queue panel
   ============================================================ */
(function (L) {
  'use strict';

  const { $, $$, el, icon, store, engine, ui, visualizer, formatTime, setArt, bindSlider, toast, gradientFor } = L;

  let seek, npSeek, vol;
  let queueTab = 'queue';

  /* ---- lyrics state ---- */
  let npMode = L.storage.get('npMode', 'lyrics');
  let lyricsToken = 0;          // guards against out-of-order fetches
  let lyricsData = null;        // { kind, lines, source }
  let lyricsLineEls = [];
  let lyricsActive = -1;
  let userScrolledAt = 0;       // pauses auto-scroll after manual scrolling

  /* ============================================================
     Wiring
     ============================================================ */
  function init() {
    /* ---- transport ---- */
    $('#btnPlay').addEventListener('click', () => engine.toggle());
    $('#npPlay').addEventListener('click', () => engine.toggle());
    $('#btnNext').addEventListener('click', () => engine.next(false));
    $('#npNext').addEventListener('click', () => engine.next(false));
    $('#btnPrev').addEventListener('click', () => engine.prev());
    $('#npPrev').addEventListener('click', () => engine.prev());

    const doShuffle = () => {
      const on = engine.setShuffle();
      toast({ title: on ? 'Shuffle on' : 'Shuffle off', timeout: 1500 });
      syncControls();
    };
    $('#btnShuffle').addEventListener('click', doShuffle);
    $('#npShuffle').addEventListener('click', doShuffle);

    const doRepeat = () => {
      const mode = engine.cycleRepeat();
      toast({ title: mode === 'off' ? 'Repeat off' : mode === 'all' ? 'Repeat queue' : 'Repeat one track', timeout: 1500 });
      syncControls();
    };
    $('#btnRepeat').addEventListener('click', doRepeat);
    $('#npRepeat').addEventListener('click', doRepeat);

    $('#btnMute').addEventListener('click', () => { engine.toggleMute(); syncVolume(); });

    /* ---- sliders ---- */
    seek = bindSlider($('#seekSlider'), { onCommit: (r) => engine.seekTo(r), onChange: (r) => previewSeek(r) });
    npSeek = bindSlider($('#npSeekSlider'), { onCommit: (r) => engine.seekTo(r), onChange: (r) => previewSeek(r) });
    vol = bindSlider($('#volSlider'), { onChange: (r) => { engine.setVolume(r); syncVolume(); } });
    vol.set(store.state.muted ? 0 : store.state.volume);

    /* ---- likes ---- */
    $('#pbLike').addEventListener('click', toggleLikeCurrent);
    $('#npLike').addEventListener('click', toggleLikeCurrent);

    /* ---- queue panel ---- */
    $('#btnQueue').addEventListener('click', () => toggleQueue());
    $('#npQueueBtn').addEventListener('click', () => { closeNowPlaying(); toggleQueue(true); });
    $('#btnCloseQueue').addEventListener('click', () => toggleQueue(false));
    $$('.tabs__btn[data-qtab]').forEach((btn) => btn.addEventListener('click', () => {
      queueTab = btn.dataset.qtab;
      $$('.tabs__btn[data-qtab]').forEach((b) => b.classList.toggle('is-active', b === btn));
      renderQueuePanel();
    }));

    /* ---- now playing sheet ---- */
    $('#btnExpand').addEventListener('click', () => openNowPlaying());
    $('#npClose').addEventListener('click', () => closeNowPlaying());
    const pbTrack = $('#pbTrack');
    pbTrack.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (store.currentTrack()) openNowPlaying();
      else location.hash = '#/search';
    });
    pbTrack.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (store.currentTrack()) openNowPlaying(); }
    });

    /* swipe down to dismiss the sheet */
    bindSheetSwipe();

    /* mobile mini-player gets its own play/next buttons */
    injectMobileControls();

    visualizer.attach($('#npViz'));
    initLyrics();

    /* ---- store subscriptions ---- */
    store.on(['index', 'queue'], () => { syncTrack(); renderQueuePanel(); });
    store.on('playing', () => { syncPlaying(); });
    store.on('loading', () => { syncPlaying(); });
    store.on(['position', 'duration'], syncProgress);
    store.on('position', syncLyricsPosition);
    store.on('backend', applyNpMode);
    store.on('awaitingGesture', syncGestureGate);

    $('#gestureBtn').addEventListener('click', () => engine.resumeFromGesture());

    // The first tap anywhere preloads the YouTube player, so the tap that
    // actually starts a song isn't spent waiting for a network round-trip.
    const prewarm = () => engine.prewarmYouTube();
    window.addEventListener('pointerdown', prewarm, { once: true, passive: true });
    window.addEventListener('keydown', prewarm, { once: true });
    store.on(['shuffle', 'repeat'], syncControls);
    store.on(['volume', 'muted'], syncVolume);
    store.on('liked', syncLike);
    store.on('context', syncContext);

    syncTrack();
    syncControls();
    syncVolume();
    syncProgress();
    renderQueuePanel();
  }

  function toggleLikeCurrent() {
    const t = store.currentTrack();
    if (!t) return;
    const now = store.toggleLike(t);
    toast({ kind: 'success', title: now ? 'Added to Liked Songs' : 'Removed from Liked Songs', text: t.title, timeout: 2000 });
    if (L.views) L.views.renderSidebarPlaylists();
  }

  /** The mobile bar needs its own compact transport (CSS hides it elsewhere). */
  function injectMobileControls() {
    const right = $('.playerbar__right');
    if (!right || $('#pbMobilePlay')) return;

    const playIcon = icon('play');
    playIcon.id = 'pbMobilePlayIcon';

    right.insertBefore(el('div.playerbar__mobile-controls', [
      el('button.play-btn', {
        id: 'pbMobilePlay', type: 'button', 'aria-label': 'Play',
        onclick: (e) => { e.stopPropagation(); engine.toggle(); },
      }, playIcon),
      el('button.icon-btn', {
        type: 'button', 'aria-label': 'Next track',
        onclick: (e) => { e.stopPropagation(); engine.next(false); },
      }, icon('next')),
    ]), right.firstChild);
  }

  /* ============================================================
     Sync helpers
     ============================================================ */
  function syncTrack() {
    const t = store.currentTrack();
    const bar = $('#playerbar');
    bar.dataset.hasTrack = t ? 'true' : 'false';

    const title = t ? t.title : 'Nothing playing';
    const artist = t ? t.artist : 'Pick a track to get started';

    $('#pbTitle').textContent = title;
    $('#pbArtist').textContent = artist;
    $('#npTitle').textContent = title;
    $('#npArtist').textContent = artist;

    setArt($('#pbArt'), t && t.artwork, t && (t.title + t.artist));
    setArt($('.np__art'), t && t.artwork, t && (t.title + t.artist));

    const badge = $('#pbSource');
    const npBadge = $('#npSource');
    [badge, npBadge].forEach((node) => {
      if (!node) return;
      if (!t) { node.hidden = true; return; }
      node.hidden = false;
      const meta = ui.SOURCE_META[t.source] || ui.SOURCE_META.local;
      node.dataset.source = t.source;
      const viaLabel = {
        preview: 'Preview',
        audius: 'Audius match',
        youtube: 'via YouTube',
      }[t.playbackVia];
      node.replaceChildren(icon(meta.icon), document.createTextNode(viaLabel || meta.label));
    });

    const origin = $('#npOrigin');
    if (origin) {
      if (t && t.permalink) { origin.hidden = false; origin.href = t.permalink; }
      else origin.hidden = true;
    }

    // tint the full-screen backdrop from a hue derived from the track
    const npBg = $('#npBg');
    if (npBg) {
      if (t) {
        const hue = L.hueFor(t.title + t.artist);
        npBg.style.background =
          `linear-gradient(180deg, hsl(${hue} 58% 32%) 0%, hsl(${(hue + 40) % 360} 46% 16%) 34%, var(--bg) 72%)`;
      } else {
        npBg.style.background = '';
      }
    }

    syncLike();
    syncContext();
    refreshTrackHighlights();
    applyNpMode();
    if (store.state.npOpen) loadLyrics(t);
    else { lyricsData = null; lyricsToken += 1; }
  }

  function syncContext() {
    const ctx = store.state.context;
    const label = $('#npContextLabel');
    const name = $('#npContextName');
    if (!label || !name) return;
    if (ctx && ctx.name) { label.textContent = 'Playing from'; name.textContent = ctx.name; }
    else { label.textContent = 'Playing from'; name.textContent = 'Loru'; }
  }

  function syncPlaying() {
    const playing = store.state.playing;
    const loading = store.state.loading;

    [['#playIcon', '#btnPlay'], ['#npPlayIcon', '#npPlay'], ['#pbMobilePlayIcon', '#pbMobilePlay']].forEach(([iconSel, btnSel]) => {
      const btn = $(btnSel);
      if (!btn) return;
      const use = btn.querySelector('use');
      if (use) use.setAttribute('href', playing ? '#i-pause' : '#i-play');
      btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      btn.classList.toggle('is-loading', loading && btnSel === '#btnPlay');
    });

    const spinner = $('#playSpinner');
    if (spinner) spinner.hidden = !loading;

    $('#pbArt').classList.toggle('is-playing', playing);
    $('#npSheet').dataset.playing = playing ? 'true' : 'false';

    const stage = $('#npStage');
    const artMode = !stage || stage.dataset.mode === 'art';
    if (store.state.npOpen && playing && artMode) visualizer.start();
    if (!playing || !store.state.npOpen || !artMode) visualizer.stop();

    refreshTrackHighlights();
  }

  /** Keeps already-rendered track rows in sync with what's playing. */
  function refreshTrackHighlights() {
    const current = store.currentTrack();
    const key = current ? store.trackKey(current) : null;
    const playing = store.state.playing;

    $$('.track').forEach((row) => {
      const isCurrent = !!key && row.dataset.key === key;
      row.classList.toggle('is-current', isCurrent);
      const use = row.querySelector('.track__index-play use');
      if (use) use.setAttribute('href', isCurrent && playing ? '#i-pause' : '#i-play');
    });
  }

  function previewSeek(ratio) {
    const dur = store.state.duration;
    const text = formatTime(ratio * dur);
    $('#seekCurrent').textContent = text;
    $('#npCurrent').textContent = text;
  }

  function syncProgress() {
    const { position, duration } = store.state;
    const ratio = duration ? position / duration : 0;
    seek && seek.set(ratio);
    npSeek && npSeek.set(ratio);

    const cur = formatTime(position);
    const dur = duration ? formatTime(duration) : (store.currentTrack() && store.currentTrack().isStream ? 'LIVE' : '0:00');
    if (!(seek && seek.dragging)) $('#seekCurrent').textContent = cur;
    if (!(npSeek && npSeek.dragging)) $('#npCurrent').textContent = cur;
    $('#seekDuration').textContent = dur;
    $('#npDuration').textContent = dur;

    const fill = $('#mobileProgressFill');
    if (fill) fill.style.width = (ratio * 100).toFixed(2) + '%';

    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && duration) {
      try { navigator.mediaSession.setPositionState({ duration, position: Math.min(position, duration), playbackRate: 1 }); } catch (e) {}
    }
  }

  function syncControls() {
    $('#btnShuffle').classList.toggle('is-active', store.state.shuffle);
    $('#npShuffle').classList.toggle('is-active', store.state.shuffle);

    const mode = store.state.repeat;
    [['#repeatIcon', '#btnRepeat'], ['#npRepeatIcon', '#npRepeat']].forEach(([iconSel, btnSel]) => {
      const btn = $(btnSel);
      if (!btn) return;
      const use = btn.querySelector('use');
      if (use) use.setAttribute('href', mode === 'one' ? '#i-repeat-one' : '#i-repeat');
      btn.classList.toggle('is-active', mode !== 'off');
    });
  }

  function syncVolume() {
    const v = store.state.muted ? 0 : store.state.volume;
    vol && vol.set(v);
    const use = $('#volIcon') && $('#volIcon').querySelector('use');
    if (use) use.setAttribute('href', v === 0 ? '#i-mute' : '#i-volume');
    const btn = $('#btnMute');
    if (btn) btn.setAttribute('aria-label', v === 0 ? 'Unmute' : 'Mute');
  }

  function syncLike() {
    const t = store.currentTrack();
    const liked = t ? store.isLiked(t) : false;
    [$('#pbLike'), $('#npLike')].forEach((btn) => {
      if (!btn) return;
      btn.classList.toggle('is-active', liked);
      btn.setAttribute('aria-pressed', liked ? 'true' : 'false');
      const use = btn.querySelector('use');
      if (use) use.setAttribute('href', liked ? '#i-heart-fill' : '#i-heart');
    });
  }

  /* ============================================================
     Queue panel
     ============================================================ */
  function toggleQueue(force) {
    const open = force === undefined ? !store.state.queueOpen : !!force;
    store.set({ queueOpen: open });
    $('#app').dataset.queue = open ? 'open' : 'closed';
    $('#btnQueue').classList.toggle('is-active', open);
    if (open) renderQueuePanel();
  }

  function renderQueuePanel() {
    const host = $('#queueBody');
    if (!host) return;

    if (queueTab === 'nowplaying') {
      host.replaceChildren(renderNowPlayingPanel());
      return;
    }

    const { queue, index } = store.state;
    if (!queue.length) {
      host.replaceChildren(ui.emptyState({
        icon: 'queue', title: 'Queue is empty',
        text: 'Play something, or add tracks with the ⋯ menu.',
      }));
      return;
    }

    const frag = document.createDocumentFragment();

    if (index >= 0) {
      frag.appendChild(el('div.queue-group-label', 'Now playing'));
      frag.appendChild(ui.queueRow(queue[index], index));
    }

    const upcoming = queue.slice(index + 1);
    if (upcoming.length) {
      frag.appendChild(el('div.queue-group-label', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
        el('span', { text: `Next up · ${upcoming.length}` }),
        el('button.icon-btn.icon-btn--sm', { type: 'button', 'aria-label': 'Clear queue', title: 'Clear queue', onclick: () => engine.clearQueue() }, icon('trash')),
      ]));
      const list = el('div', { id: 'queueSortable' });
      upcoming.forEach((t, i) => list.appendChild(ui.queueRow(t, index + 1 + i)));
      enableDragSort(list);
      frag.appendChild(list);
    }

    const history = queue.slice(0, Math.max(0, index));
    if (history.length) {
      frag.appendChild(el('div.queue-group-label', { text: `Played · ${history.length}` }));
      history.forEach((t, i) => {
        const row = ui.queueRow(t, i);
        row.style.opacity = '.55';
        frag.appendChild(row);
      });
    }

    host.replaceChildren(frag);
  }

  function renderNowPlayingPanel() {
    const t = store.currentTrack();
    if (!t) return ui.emptyState({ icon: 'wave', title: 'Nothing playing' });

    const rows = [
      ['Source', (ui.SOURCE_META[t.source] || ui.SOURCE_META.local).label],
      t.album ? ['Album', t.album] : null,
      t.genre ? ['Genre', t.genre] : null,
      t.duration ? ['Length', formatTime(t.duration)] : null,
      t.plays ? ['Plays', L.formatCount(t.plays)] : null,
      t.playbackVia === 'preview' ? ['Playing', '30-second preview'] : null,
      t.playbackVia === 'audius' ? ['Playing', 'Matched Audius stream'] : null,
      t.playbackVia === 'youtube' ? ['Playing', 'Matched YouTube video'] : null,
    ].filter(Boolean);

    return el('div.npq', [
      ui.artwork(t.artwork, t.title + t.artist, 'npq__art'),
      el('div', [
        el('div.npq__title', { text: t.title }),
        el('div.npq__artist', { text: t.artist }),
      ]),
      el('div', rows.map(([k, v]) => el('div.npq__row', [el('span', { text: k }), el('span', { text: String(v) })]))),
      el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
        el('button.btn.btn--soft.btn--sm', { type: 'button', onclick: () => ui.openAddToPlaylist([t]) }, [icon('plus'), 'Add to playlist']),
        t.permalink ? el('a.btn.btn--ghost.btn--sm', { href: t.permalink, target: '_blank', rel: 'noopener' }, [icon('globe'), 'Original']) : null,
      ]),
    ]);
  }

  /* ---------------- drag to reorder ---------------- */
  function enableDragSort(list) {
    let dragIndex = null;

    list.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.qrow');
      if (!row) return;
      dragIndex = Number(row.dataset.index);
      row.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(dragIndex)); } catch (err) {}
    });

    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      const row = e.target.closest('.qrow');
      list.querySelectorAll('.is-dragover').forEach((n) => n.classList.remove('is-dragover'));
      if (row) row.classList.add('is-dragover');
    });

    list.addEventListener('dragleave', (e) => {
      const row = e.target.closest('.qrow');
      if (row) row.classList.remove('is-dragover');
    });

    list.addEventListener('drop', (e) => {
      e.preventDefault();
      const row = e.target.closest('.qrow');
      list.querySelectorAll('.is-dragover, .is-dragging').forEach((n) => n.classList.remove('is-dragover', 'is-dragging'));
      if (!row || dragIndex === null) return;
      const target = Number(row.dataset.index);
      if (target !== dragIndex) engine.moveInQueue(dragIndex, target);
      dragIndex = null;
    });

    list.addEventListener('dragend', () => {
      list.querySelectorAll('.is-dragover, .is-dragging').forEach((n) => n.classList.remove('is-dragover', 'is-dragging'));
      dragIndex = null;
    });
  }

  /* ============================================================
     Now-playing sheet
     ============================================================ */
  function openNowPlaying() {
    const sheet = $('#npSheet');
    sheet.dataset.open = 'true';
    sheet.setAttribute('aria-hidden', 'false');
    store.set({ npOpen: true });
    document.body.style.overflow = 'hidden';
    applyNpMode();
    loadLyrics(store.currentTrack());
    setTimeout(() => $('#npClose') && $('#npClose').focus(), 400);
  }

  function closeNowPlaying() {
    const sheet = $('#npSheet');
    sheet.dataset.open = 'false';
    sheet.setAttribute('aria-hidden', 'true');
    store.set({ npOpen: false });
    document.body.style.overflow = '';
    visualizer.stop();
    engine.showYouTubeSurface(false);
  }

  function bindSheetSwipe() {
    const sheet = $('#npSheet');
    const inner = $('.np__inner');
    if (!sheet || !inner) return;
    let startY = null;
    let delta = 0;

    inner.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      const scrollable = e.target.closest('.np__stage, .np__seek, .slider');
      if (scrollable && scrollable.classList.contains('slider')) return;
      startY = e.touches[0].clientY;
      delta = 0;
    }, { passive: true });

    inner.addEventListener('touchmove', (e) => {
      if (startY === null) return;
      delta = e.touches[0].clientY - startY;
      if (delta > 0) sheet.style.transform = `translateY(${delta * 0.6}px)`;
    }, { passive: true });

    inner.addEventListener('touchend', () => {
      if (startY === null) return;
      sheet.style.transform = '';
      if (delta > 110) closeNowPlaying();
      startY = null;
      delta = 0;
    });
  }

  /* ============================================================
     Lyrics
     ============================================================ */
  function initLyrics() {
    $$('.tabs__btn[data-npmode]').forEach((btn) => {
      btn.addEventListener('click', () => setNpMode(btn.dataset.npmode));
    });

    const scroll = $('#npLyricsScroll');
    if (scroll) {
      // Manual scrolling wins for a few seconds before auto-follow resumes
      ['wheel', 'touchmove', 'pointerdown'].forEach((evt) => {
        scroll.addEventListener(evt, () => { userScrolledAt = Date.now(); }, { passive: true });
      });
    }

    applyNpMode();
  }

  function setNpMode(mode) {
    npMode = mode;
    L.storage.set('npMode', mode);
    applyNpMode();
    if (mode === 'lyrics') loadLyrics(store.currentTrack());
  }

  function applyNpMode() {
    const stage = $('#npStage');
    if (!stage) return;

    const hasVideo = store.state.backend === 'youtube';
    const videoTab = $('#npModeVideo');
    if (videoTab) videoTab.hidden = !hasVideo;

    // Fall back out of video mode when the current track isn't a video
    const effective = (npMode === 'video' && !hasVideo) ? 'lyrics' : npMode;
    stage.dataset.mode = effective;

    $$('.tabs__btn[data-npmode]').forEach((b) => b.classList.toggle('is-active', b.dataset.npmode === effective));

    engine.showYouTubeSurface(hasVideo && effective === 'video');

    if (effective === 'art' && store.state.playing && store.state.npOpen) visualizer.start();
    else if (effective !== 'art') visualizer.stop();
  }

  function syncGestureGate() {
    const waiting = store.state.awaitingGesture;
    const gate = $('#gestureGate');
    if (gate) gate.hidden = !waiting;
    const bar = $('#playerbar');
    if (bar) bar.dataset.gesture = waiting ? 'true' : 'false';
    if (waiting && !store.state.npOpen) {
      toast({
        title: 'Tap play to start',
        text: 'Mobile browsers block audio until you interact with the page.',
        timeout: 5000,
      });
    }
  }

  function lyricsHost() { return $('#npLyricsScroll'); }

  function renderLyricsState(nodes) {
    const host = lyricsHost();
    if (!host) return;
    host.replaceChildren(...(Array.isArray(nodes) ? nodes : [nodes]));
    lyricsLineEls = [];
    lyricsActive = -1;
  }

  async function loadLyrics(track) {
    const host = lyricsHost();
    if (!host) return;
    const token = ++lyricsToken;
    lyricsData = null;

    if (!track) {
      renderLyricsState(el('div.lyrics__state', [icon('wave'), el('div', 'Play something to see its lyrics.')]));
      return;
    }

    if (npMode !== 'lyrics') return;   // don't fetch for a hidden pane

    renderLyricsState(el('div.lyrics__skeleton', [
      el('span', { style: { width: '70%' } }), el('span', { style: { width: '54%' } }),
      el('span', { style: { width: '64%' } }), el('span', { style: { width: '44%' } }),
      el('span', { style: { width: '60%' } }),
    ]));

    let result;
    try {
      result = await L.lyrics.get(track);
    } catch (err) {
      if (token !== lyricsToken) return;
      renderLyricsState(el('div.lyrics__state', [
        icon('info'),
        el('div', { text: err.message }),
        el('button.btn.btn--soft.btn--sm', { type: 'button', onclick: () => loadLyrics(store.currentTrack()) }, 'Retry'),
      ]));
      return;
    }

    if (token !== lyricsToken) return;

    if (!result) {
      renderLyricsState(el('div.lyrics__state', [
        icon('search'),
        el('div', { text: `No lyrics found for “${track.title}”.` }),
        el('div', { style: { fontSize: 'var(--fs-xs)', opacity: '.8' } },
          'Loru matches on artist and title, so a remix or live version often has none.'),
      ]));
      return;
    }

    if (result.kind === 'instrumental') {
      renderLyricsState(el('div.lyrics__state', [icon('wave'), el('div', 'This track is instrumental.')]));
      return;
    }

    lyricsData = result;
    const synced = result.kind === 'synced';
    const pane = $('#npLyrics');
    if (pane) pane.classList.toggle('lyrics--plain', !synced);

    const host2 = lyricsHost();
    const lines = result.lines.map((line, i) => {
      if (!line.text) return el('div.lyrics__line.lyrics__line--blank');
      const node = el('div.lyrics__line', { text: line.text });
      if (synced) {
        node.title = 'Jump to this line';
        node.addEventListener('click', () => {
          const dur = store.state.duration || 0;
          if (dur) engine.seekTo(line.time / dur);
        });
      }
      return node;
    });

    host2.replaceChildren(...lines);
    lyricsLineEls = lines;
    lyricsActive = -1;

    if (result.source) {
      const credit = el('div.lyrics__credit', { text: `Lyrics via ${result.source}` });
      const wrap = $('#npLyrics');
      const existing = wrap.querySelector('.lyrics__credit');
      if (existing) existing.remove();
      wrap.appendChild(credit);
    }

    syncLyricsPosition();
  }

  function syncLyricsPosition() {
    if (!lyricsData || lyricsData.kind !== 'synced' || !store.state.npOpen) return;
    if ($('#npStage') && $('#npStage').dataset.mode !== 'lyrics') return;

    const index = L.lyrics.activeIndex(lyricsData.lines, store.state.position + 0.25);
    if (index === lyricsActive) return;
    lyricsActive = index;

    lyricsLineEls.forEach((node, i) => {
      if (!node || node.classList.contains('lyrics__line--blank')) return;
      node.classList.toggle('is-active', i === index);
      node.classList.toggle('is-past', i < index);
    });

    const current = lyricsLineEls[index];
    if (!current) return;
    // Respect a recent manual scroll rather than yanking the view back
    if (Date.now() - userScrolledAt < 4000) return;

    const host = lyricsHost();
    const target = current.offsetTop - (host.clientHeight / 2) + (current.offsetHeight / 2);
    host.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }

  L.player = {
    init, toggleQueue, openNowPlaying, closeNowPlaying,
    renderQueuePanel, syncTrack, syncPlaying,
    setNpMode, loadLyrics,
  };
})(window.Loru);
