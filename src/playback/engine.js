/* ============================================================
   Loru Player — playback/engine.js
   One queue, five playback backends:
     audio      → Audius streams, direct URLs, Apple/Spotify previews
     youtube    → YouTube IFrame Player
     spotify    → Spotify Web Playback SDK (Premium)
     soundcloud → SoundCloud widget iframe
     demo       → offline WebAudio pad, used by ?demo=1

   Only `audio` (and `demo`) can play with the page hidden or the phone locked;
   the iframe-based backends are contractually required to pause. Everything
   under "background playback" below exists to make sure that when a track *can*
   keep playing, nothing on our side is what stops it.
   ============================================================ */
(function (L) {
  'use strict';

  const { store, toast, clamp, importer, youtube, spotify } = L;

  /* ---------------- shared audio graph ---------------- */
  let audioEl = null;
  let audioCtx = null;
  let mediaSource = null;
  let analyser = null;
  let corsOk = false;               // true when the current element is CORS-clean
  const noCorsHosts = new Set(L.storage.get('noCorsHosts', []) || []);

  let backend = 'none';             // none | audio | youtube | spotify | soundcloud | demo
  let ytPlayer = null;
  let ytReadyPromise = null;
  let ticker = null;
  let pendingTrackToken = 0;

  /* ---------------- background playback ---------------- */
  const UA = navigator.userAgent || '';
  const IS_IOS = /iP(ad|hone|od)/.test(UA) || (/Macintosh/.test(UA) && (navigator.maxTouchPoints || 0) > 1);
  const IS_ANDROID = /Android/i.test(UA);
  const IS_SAFARI = /Safari/i.test(UA) && !/Chrome|Chromium|CriOS|FxiOS|Edg/i.test(UA);
  // Platforms that suspend an AudioContext as soon as the page is backgrounded.
  const SUSPENDS_WHEN_HIDDEN = IS_IOS || IS_ANDROID || IS_SAFARI;

  let wakeLock = null;
  let keepAlive = null;
  let recoverTries = 0;
  let warnedNoBackground = false;

  function ensureAudio(withCors) {
    if (audioEl && (!!audioEl.crossOrigin) === !!withCors) return audioEl;

    if (audioEl) {
      try { audioEl.pause(); } catch (e) {}
      audioEl.removeAttribute('src');
      audioEl.load && audioEl.load();
      audioEl.remove();
      // a new element needs a new MediaElementSource
      mediaSource = null;
      analyser = null;
    }

    audioEl = document.createElement('audio');
    audioEl.preload = 'auto';
    /* iOS only keeps a media element alive once the page is backgrounded if it
       is a genuine inline, unmuted element attached to the document. */
    audioEl.playsInline = true;
    audioEl.setAttribute('playsinline', '');
    audioEl.setAttribute('webkit-playsinline', '');
    audioEl.muted = false;
    if (withCors) audioEl.crossOrigin = 'anonymous';
    audioEl.volume = store.state.muted ? 0 : store.state.volume;
    bindAudioEvents(audioEl);
    document.body.appendChild(audioEl);
    return audioEl;
  }

  function hostOf(url) {
    try { return new URL(url, location.href).host; } catch (e) { return ''; }
  }

  function bindAudioEvents(a) {
    a.addEventListener('loadedmetadata', () => {
      if (backend !== 'audio') return;
      const d = Number.isFinite(a.duration) ? a.duration : 0;
      if (d) store.set({ duration: d });
    });
    a.addEventListener('playing', () => { if (backend === 'audio') store.set({ playing: true, loading: false }); });
    a.addEventListener('pause', () => { if (backend === 'audio' && !a.ended) store.set({ playing: false }); });
    a.addEventListener('waiting', () => { if (backend === 'audio') store.set({ loading: true }); });
    a.addEventListener('canplay', () => { if (backend === 'audio') store.set({ loading: false }); });
    a.addEventListener('ended', () => { if (backend === 'audio') handleEnded(); });
    a.addEventListener('error', () => { if (backend === 'audio') handleAudioError(); });

    /* A hidden page has its timers throttled to a second or worse, but a
       playing element keeps firing timeupdate at full rate. Driving position
       from the element instead of the ticker is what keeps the progress bar,
       the lock-screen scrubber and Discord presence honest in the background. */
    a.addEventListener('timeupdate', () => {
      if (backend !== 'audio') return;
      const dur = Number.isFinite(a.duration) && a.duration ? a.duration : store.state.duration;
      store.set({ position: a.currentTime || 0, duration: dur });
      syncPositionState();
    });
    a.addEventListener('durationchange', () => {
      if (backend !== 'audio' || !Number.isFinite(a.duration) || !a.duration) return;
      store.set({ duration: a.duration });
    });
    a.addEventListener('play', () => {
      if (backend !== 'audio') return;
      recoverTries = 0;
      // Publish metadata before the OS draws its notification, not after.
      updateMediaSession();
      startKeepAlive();
    });
  }

  /** Retry without CORS (keeps audio working when the CDN sends no ACAO header). */
  function handleAudioError() {
    const track = store.currentTrack();
    const src = audioEl && (audioEl.currentSrc || audioEl.src);

    if (audioEl && audioEl.crossOrigin && src) {
      const host = hostOf(src);
      if (host) {
        noCorsHosts.add(host);
        L.storage.set('noCorsHosts', Array.from(noCorsHosts));
      }
      const at = audioEl.currentTime || 0;
      const plain = ensureAudio(false);
      corsOk = false;
      plain.src = src;
      plain.currentTime = at;
      plain.play().catch(() => {});
      return;
    }

    store.set({ loading: false, playing: false });
    toast({
      kind: 'error',
      title: 'Playback failed',
      text: track ? `“${track.title}” could not be streamed. Skipping.` : 'That stream could not be loaded.',
    });
    if (store.state.settings.autoplayNext) setTimeout(() => next(true), 700);
  }

  /**
   * Feeding the element through a MediaElementSource is what powers the real
   * spectrum, but it also means every sample has to travel through the
   * AudioContext — and phones suspend that context the instant the page is
   * backgrounded, which silences playback while currentTime happily keeps
   * advancing. That is the classic "it says it's playing but I hear nothing"
   * bug. On those platforms we leave the element wired straight to the hardware
   * and let the visualizer use its synthetic waveform instead.
   */
  function graphIsSafe() {
    if (!store.state.settings.backgroundAudio) return true;   // visuals over background
    return !SUSPENDS_WHEN_HIDDEN;
  }

  function ensureAnalyser() {
    if (!corsOk || !audioEl || !graphIsSafe()) return null;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (!mediaSource) {
        mediaSource = audioCtx.createMediaElementSource(audioEl);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.78;
        mediaSource.connect(analyser);
        analyser.connect(audioCtx.destination);
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return analyser;
    } catch (e) {
      analyser = null;
      return null;
    }
  }

  /** Safe to call as often as you like; a no-op unless the context is suspended. */
  function resumeAudioCtx() {
    if (!audioCtx || audioCtx.state !== 'suspended') return;
    try { const p = audioCtx.resume(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
  }

  /**
   * The OS can suspend our context or pause our element without any matching
   * event reaching the page. This watchdog spots the disagreement between what
   * the UI believes and what the element is actually doing, and repairs it.
   */
  function startKeepAlive() {
    stopKeepAlive();
    keepAlive = setInterval(() => {
      if (!store.state.playing) return;
      resumeAudioCtx();
      if (backend !== 'audio' || !audioEl || !audioEl.src) return;
      if (audioEl.paused && !audioEl.ended && recoverTries < 3) {
        recoverTries++;
        const p = audioEl.play();
        if (p && p.catch) p.catch(() => {});
      }
    }, 1000);
  }

  function stopKeepAlive() {
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
  }

  /**
   * Opt-in screen lock. Some Android browsers tear down playback when the
   * screen turns off, and holding a screen lock is the only way around it —
   * at an obvious battery cost, hence off by default.
   */
  async function requestWakeLock() {
    if (!store.state.settings.keepAwake || wakeLock) return;
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { wakeLock = null; }
  }

  function releaseWakeLock() {
    if (!wakeLock) return;
    try { wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }

  /** Only a real media element survives the page being hidden. */
  function canPlayInBackground() {
    return backend === 'audio' || backend === 'demo';
  }

  /**
   * The iframe backends are required to pause when the page is hidden, and
   * nothing on our side can change that. Saying so once, at the moment it starts
   * mattering, beats letting someone conclude background playback is broken —
   * and the action gives them the one setting that can actually help.
   */
  function noteBackgroundLimit() {
    if (warnedNoBackground || canPlayInBackground()) return;
    if (!store.state.settings.backgroundAudio) return;      // they opted out
    warnedNoBackground = true;
    const offerAudius = !store.state.settings.adFreeFirst;
    toast({
      title: 'This track stops in the background',
      text: offerAudius
        ? 'Embedded players must pause when the tab is hidden. Audius streams keep playing.'
        : 'Embedded players must pause when the tab is hidden, and Audius had no match for this one.',
      action: offerAudius ? {
        label: 'Use Audius first',
        onClick: () => {
          store.updateSettings({ adFreeFirst: true });
          const t = store.currentTrack();
          if (t) load(t, { autoplay: store.state.playing, startAt: store.state.position });
        },
      } : null,
      timeout: 9000,
    });
  }

  /** Feeds the OS scrubber. Driven by the element, so it stays live when hidden. */
  function syncPositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const duration = store.state.duration;
    if (!duration || !Number.isFinite(duration)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        position: clamp(store.state.position || 0, 0, duration),
        playbackRate: (audioEl && audioEl.playbackRate) || 1,
      });
    } catch (e) {}
  }

  /* ---------------- demo synth backend ---------------- */
  const synth = {
    nodes: null,
    startedAt: 0,
    offset: 0,
    playing: false,
    ctx() {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    },
    start(track, from = 0) {
      this.stop();
      const ctx = this.ctx();
      const base = track.tone || 220;
      const master = ctx.createGain();
      master.gain.value = 0;
      const an = ctx.createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.8;
      master.connect(an);
      an.connect(ctx.destination);
      analyser = an;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1400;
      filter.Q.value = 0.8;
      filter.connect(master);

      const oscs = [
        { f: base, type: 'sine', g: 0.5 },
        { f: base * 1.5, type: 'sine', g: 0.22 },
        { f: base * 2.01, type: 'triangle', g: 0.14 },
        { f: base / 2, type: 'sine', g: 0.3 },
      ].map((cfg) => {
        const o = ctx.createOscillator();
        o.type = cfg.type;
        o.frequency.value = cfg.f;
        const g = ctx.createGain();
        g.gain.value = cfg.g;
        o.connect(g); g.connect(filter);
        o.start();
        return o;
      });

      // slow shimmer so the visualizer has something to move to
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.18;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 320;
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      lfo.start();

      const vol = store.state.muted ? 0 : store.state.volume * 0.16;
      master.gain.linearRampToValueAtTime(vol, ctx.currentTime + 0.6);

      this.nodes = { master, oscs, lfo, an };
      this.startedAt = ctx.currentTime;
      this.offset = from;
      this.playing = true;
    },
    stop() {
      if (!this.nodes) return;
      const { master, oscs, lfo } = this.nodes;
      try {
        const ctx = this.ctx();
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.12);
        setTimeout(() => {
          oscs.forEach((o) => { try { o.stop(); o.disconnect(); } catch (e) {} });
          try { lfo.stop(); lfo.disconnect(); } catch (e) {}
          try { master.disconnect(); } catch (e) {}
        }, 180);
      } catch (e) {}
      this.nodes = null;
      this.playing = false;
    },
    pause() {
      if (!this.playing) return;
      this.offset = this.position();
      this.stop();
    },
    position() {
      if (!this.playing || !audioCtx) return this.offset;
      return this.offset + (audioCtx.currentTime - this.startedAt);
    },
    setVolume(v) {
      if (!this.nodes) return;
      try { this.nodes.master.gain.value = v * 0.16; } catch (e) {}
    },
  };

  /* ---------------- YouTube backend ---------------- */
  function ytHostEl() { return document.getElementById('ytHost'); }

  function ensureYouTube() {
    if (ytPlayer) return Promise.resolve(ytPlayer);
    if (ytReadyPromise) return ytReadyPromise;

    ytReadyPromise = youtube.ensureApi().then((YT) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('YouTube player timed out.')), 15000);
      ytPlayer = new YT.Player('ytPlayer', {
        height: '180', width: '320',
        playerVars: { autoplay: 0, controls: 1, rel: 0, playsinline: 1, modestbranding: 1, origin: location.origin },
        events: {
          onReady() {
            clearTimeout(timer);
            try { ytPlayer.setVolume(Math.round((store.state.muted ? 0 : store.state.volume) * 100)); } catch (e) {}
            resolve(ytPlayer);
          },
          onStateChange(e) {
            if (backend !== 'youtube') return;
            const YTS = window.YT.PlayerState;
            if (e.data === YTS.PLAYING) {
              store.set({ playing: true, loading: false, awaitingGesture: false });
              try { store.set({ duration: ytPlayer.getDuration() || 0 }); } catch (err) {}
            } else if (e.data === YTS.PAUSED) store.set({ playing: false, loading: false });
            else if (e.data === YTS.BUFFERING) store.set({ loading: true });
            else if (e.data === YTS.ENDED) handleEnded();
          },
          onError(e) {
            if (backend !== 'youtube') return;
            const codes = {
              2: 'That video id is invalid.',
              5: 'The video cannot be played in this player.',
              100: 'That video was removed or made private.',
              101: 'The uploader does not allow embedded playback.',
              150: 'The uploader does not allow embedded playback.',
            };
            store.set({ loading: false, playing: false });
            const track = store.currentTrack();
            toast({
              kind: 'error',
              title: 'Skipping video',
              text: codes[e.data] || 'This video cannot be played here.',
              action: track && track.permalink ? { label: 'Open on YouTube', onClick: () => window.open(track.permalink, '_blank', 'noopener') } : null,
            });
            setTimeout(() => next(true), 600);
          },
        },
      });
    })).catch((err) => { ytReadyPromise = null; throw err; });

    return ytReadyPromise;
  }

  function showYouTubeSurface(show) {
    const host = ytHostEl();
    if (!host) return;
    const stage = document.querySelector('.np__stage');
    if (show && store.state.npOpen && stage) {
      if (host.parentElement !== stage) stage.appendChild(host);
      host.classList.add('is-visible');
      host.setAttribute('aria-hidden', 'false');
      document.querySelector('.np__art') && document.querySelector('.np__art').setAttribute('hidden', '');
    } else {
      host.classList.remove('is-visible');
      host.setAttribute('aria-hidden', 'true');
      if (host.parentElement !== document.body) document.body.appendChild(host);
      const art = document.querySelector('.np__art');
      if (art) art.removeAttribute('hidden');
    }
  }

  /* ---------------- transport ---------------- */
  function stopAllBackends(except) {
    if (except !== 'audio' && audioEl) { try { audioEl.pause(); } catch (e) {} }
    if (except !== 'youtube' && ytPlayer) { try { ytPlayer.pauseVideo(); } catch (e) {} }
    if (except !== 'spotify') { try { spotify.sdk.pause(); } catch (e) {} }
    if (except !== 'demo') synth.pause();
    if (except !== 'soundcloud' && L.soundcloud) { try { L.soundcloud.pause(); } catch (e) {} }
    if (except !== 'youtube') showYouTubeSurface(false);
  }

  function startTicker() {
    stopTicker();
    ticker = setInterval(() => {
      if (!store.state.playing) return;
      let pos = store.state.position;
      let dur = store.state.duration;

      if (backend === 'audio' && audioEl) {
        pos = audioEl.currentTime || 0;
        if (Number.isFinite(audioEl.duration) && audioEl.duration) dur = audioEl.duration;
      } else if (backend === 'youtube' && ytPlayer && ytPlayer.getCurrentTime) {
        try { pos = ytPlayer.getCurrentTime() || 0; dur = ytPlayer.getDuration() || dur; } catch (e) {}
      } else if (backend === 'demo') {
        pos = synth.position();
        if (pos >= dur && dur > 0) { handleEnded(); return; }
      } else if (backend === 'spotify' && spotify.sdk.player) {
        spotify.sdk.player.getCurrentState().then((s) => {
          if (!s) return;
          store.set({ position: s.position / 1000, duration: s.duration / 1000, playing: !s.paused });
        }).catch(() => {});
        return;
      }
      store.set({ position: pos, duration: dur });
    }, 250);
  }

  function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

  /* ---------------- loading a track ---------------- */
  async function load(track, { autoplay = true, startAt = 0 } = {}) {
    if (!track) return;
    const token = ++pendingTrackToken;
    store.set({ loading: true, position: 0, duration: track.duration || 0 });

    let playable = track;
    try {
      const resolved = await importer.resolvePlayable(track);
      playable = resolved.track;
      if (resolved.note) toast({ title: 'Heads up', text: resolved.note, timeout: 5200 });
    } catch (err) {
      store.set({ loading: false, playing: false });
      toast({
        kind: 'error',
        title: 'Can’t play that track',
        text: err.message,
        action: err.permalink ? { label: 'Open original', onClick: () => window.open(err.permalink, '_blank', 'noopener') } : null,
      });
      if (store.state.settings.autoplayNext) setTimeout(() => next(true), 900);
      return;
    }

    if (token !== pendingTrackToken) return;   // a newer request superseded us

    // keep the resolved playback info on the queue entry
    if (playable !== track) {
      const q = store.state.queue.slice();
      if (q[store.state.index]) {
        q[store.state.index] = { ...q[store.state.index], ...playable };
        store.set({ queue: q });
      }
    }

    store.pushRecent(track);
    updateMediaSession();

    /* A track can play through YouTube either natively or as a matched stand-in
       for a Spotify/Apple track (which keeps its own source and identity).
       `playbackVia`, when set, names the backend we deliberately resolved to —
       so a YouTube result that was matched onto Audius must not quietly fall
       back to its own video id and end up on the embed anyway. */
    const viaYouTube = playable.playbackVia
      ? playable.playbackVia === 'youtube'
      : playable.source === 'youtube';
    const ytVideoId = viaYouTube ? (playable.videoId || playable.ytVideoId) : null;
    const isYouTube = !!ytVideoId;
    const isSpotifyNative = playable.source === 'spotify' && !playable.playbackVia && store.state.connections.spotify.premium;
    const isDemo = playable.source === 'demo';

    try {
      if (isYouTube) {
        backend = 'youtube';
        store.set({ backend });
        stopAllBackends('youtube');
        const p = await ensureYouTube();
        p.loadVideoById({ videoId: ytVideoId, startSeconds: startAt });
        try { p.playVideo(); } catch (e) {}
        if (!autoplay) setTimeout(() => { try { p.pauseVideo(); } catch (e) {} }, 350);
        startTicker();
        if (autoplay) { watchForBlockedAutoplay(token); noteBackgroundLimit(); }
        return;
      }

      if (isSpotifyNative) {
        backend = 'spotify';
        store.set({ backend });
        stopAllBackends('spotify');
        await spotify.sdk.ensurePlayer({
          onState: (s) => {
            if (backend !== 'spotify' || !s) return;
            store.set({ playing: !s.paused, position: s.position / 1000, duration: s.duration / 1000, loading: false });
            if (s.paused && s.position === 0 && s.track_window && s.track_window.current_track) {
              // Spotify signals end-of-track this way
              if (store.state.duration && Math.abs(store.state.duration - (s.duration / 1000)) < 1 && s.position === 0) { /* noop */ }
            }
          },
          onError: (msg) => {
            toast({ kind: 'error', title: 'Spotify playback error', text: msg });
            store.set({ loading: false, playing: false });
          },
        });
        await spotify.sdk.playUri(playable.uri, Math.round(startAt * 1000));
        store.set({ loading: false, playing: true });
        startTicker();
        return;
      }

      if (playable.source === 'soundcloud' && playable.scUrl) {
        backend = 'soundcloud';
        store.set({ backend });
        stopAllBackends('soundcloud');

        await L.soundcloud.load(playable.scUrl, {
          onPlay: () => store.set({ playing: true, loading: false, awaitingGesture: false }),
          onPause: () => store.set({ playing: false }),
          onFinish: () => handleEnded(),
          onProgress: (seconds) => store.set({ position: seconds }),
          onError: (err) => {
            store.set({ loading: false, playing: false });
            toast({ kind: 'error', title: 'Skipping track', text: err.message });
            setTimeout(() => next(true), 700);
          },
        }, { autoplay });

        L.soundcloud.setVolume(store.state.muted ? 0 : store.state.volume);

        // The widget only knows the real title and length once it resolves
        L.soundcloud.currentSound().then((sound) => {
          if (!sound || token !== pendingTrackToken) return;
          const q = store.state.queue.slice();
          const idx = store.state.index;
          if (q[idx]) {
            q[idx] = {
              ...q[idx],
              title: sound.title || q[idx].title,
              artist: sound.artist || q[idx].artist,
              artwork: sound.artwork || q[idx].artwork,
              duration: sound.duration || q[idx].duration,
            };
            store.set({ queue: q, duration: sound.duration || store.state.duration });
          }
        });

        store.set({ loading: false });
        startTicker();
        if (autoplay) noteBackgroundLimit();
        return;
      }

      if (isDemo) {
        backend = 'demo';
        store.set({ backend });
        stopAllBackends('demo');
        store.set({ duration: playable.duration || 200, loading: false });
        if (autoplay) { synth.start(playable, startAt); store.set({ playing: true }); }
        else { synth.offset = startAt; store.set({ playing: false }); }
        startTicker();
        return;
      }

      /* default: HTML5 audio */
      const src = playable.streamUrl || playable.previewUrl;
      if (!src) throw new Error('No stream available for this track.');

      backend = 'audio';
      store.set({ backend });
      stopAllBackends('audio');
      const host = hostOf(src);
      const wantCors = store.state.settings.showVisualizer && graphIsSafe() && !noCorsHosts.has(host);
      const a = ensureAudio(wantCors);
      corsOk = wantCors;
      a.src = src;
      a.volume = store.state.muted ? 0 : store.state.volume;
      if (startAt) { try { a.currentTime = startAt; } catch (e) {} }

      if (autoplay) {
        try {
          await a.play();
          if (corsOk) ensureAnalyser();
        } catch (err) {
          store.set({ playing: false, loading: false });
          if (err && err.name === 'NotAllowedError') {
            toast({ title: 'Tap play to start', text: 'Your browser blocked autoplay until you interact with the page.' });
          }
        }
      } else {
        store.set({ loading: false, playing: false });
      }
      startTicker();
    } catch (err) {
      store.set({ loading: false, playing: false });
      toast({ kind: 'error', title: 'Playback problem', text: err.message || String(err) });
    }
  }

  /**
   * Mobile browsers only allow media to start from a real user gesture, and
   * the gesture is spent by the time an awaited promise chain resolves. If the
   * video has not actually started shortly after loading, surface a tap target
   * instead of silently sitting at 0:00 with a pause icon showing.
   */
  function watchForBlockedAutoplay(token) {
    setTimeout(() => {
      if (token !== pendingTrackToken || backend !== 'youtube') return;
      let state = -1;
      let time = 0;
      try { state = ytPlayer.getPlayerState(); time = ytPlayer.getCurrentTime() || 0; } catch (e) {}
      const YTS = window.YT && window.YT.PlayerState;
      const reallyPlaying = YTS && state === YTS.PLAYING && time > 0.15;
      if (!reallyPlaying) {
        store.set({ awaitingGesture: true, playing: false, loading: false });
      }
    }, 2200);
  }

  /** Called straight from a click/tap handler, so the gesture is still valid. */
  function resumeFromGesture() {
    store.set({ awaitingGesture: false });
    if (backend === 'youtube' && ytPlayer) {
      try {
        ytPlayer.unMute();
        ytPlayer.setVolume(Math.round((store.state.muted ? 0 : store.state.volume) * 100));
        ytPlayer.playVideo();
      } catch (e) {}
      startTicker();
      return;
    }
    play();
  }

  /**
   * Loads the YouTube API ahead of the first play. Without this the very first
   * tap spends its gesture waiting on a network round-trip for the player
   * script, and playback is refused.
   */
  function prewarmYouTube() {
    if (ytReadyPromise || ytPlayer) return;
    ensureYouTube().catch(() => { /* offline or blocked; normal load will report */ });
  }

  /* ---------------- public transport ---------------- */
  function play() {
    const track = store.currentTrack();
    if (!track) return;
    if (backend === 'none') { load(track, { autoplay: true }); return; }

    if (backend === 'audio' && audioEl) {
      resumeAudioCtx();
      audioEl.play().then(() => { if (corsOk) ensureAnalyser(); }).catch(() => {});
    } else if (backend === 'youtube' && ytPlayer) {
      try { ytPlayer.playVideo(); } catch (e) {}
    } else if (backend === 'spotify') {
      spotify.sdk.resume();
      store.set({ playing: true });
    } else if (backend === 'demo') {
      synth.start(track, synth.offset || store.state.position || 0);
      store.set({ playing: true });
    } else if (backend === 'soundcloud') {
      L.soundcloud.play();
    }
    startTicker();
    startKeepAlive();
    requestWakeLock();
  }

  function pause() {
    if (backend === 'audio' && audioEl) { try { audioEl.pause(); } catch (e) {} }
    else if (backend === 'youtube' && ytPlayer) { try { ytPlayer.pauseVideo(); } catch (e) {} }
    else if (backend === 'spotify') spotify.sdk.pause();
    else if (backend === 'demo') synth.pause();
    else if (backend === 'soundcloud') L.soundcloud.pause();
    store.set({ playing: false });
    stopKeepAlive();
    releaseWakeLock();
  }

  function toggle() {
    if (!store.currentTrack()) {
      toast({ title: 'Nothing queued', text: 'Pick a track, or paste a playlist link to get started.' });
      return;
    }
    store.state.playing ? pause() : play();
  }

  function seekTo(ratio) {
    const dur = store.state.duration;
    if (!dur) return;
    const target = clamp(ratio, 0, 1) * dur;
    if (backend === 'audio' && audioEl) { try { audioEl.currentTime = target; } catch (e) {} }
    else if (backend === 'youtube' && ytPlayer) { try { ytPlayer.seekTo(target, true); } catch (e) {} }
    else if (backend === 'spotify') spotify.sdk.seek(Math.round(target * 1000));
    else if (backend === 'soundcloud') L.soundcloud.seek(target);
    else if (backend === 'demo') {
      const wasPlaying = store.state.playing;
      synth.pause();
      synth.offset = target;
      if (wasPlaying) synth.start(store.currentTrack(), target);
    }
    store.set({ position: target });
    syncPositionState();
  }

  function nudge(seconds) {
    seekTo((store.state.position + seconds) / (store.state.duration || 1));
  }

  function setVolume(v) {
    const vol = clamp(v, 0, 1);
    store.set({ volume: vol, muted: vol === 0 ? store.state.muted : false });
    applyVolume();
  }

  function applyVolume() {
    const v = store.state.muted ? 0 : store.state.volume;
    if (audioEl) audioEl.volume = v;
    if (ytPlayer && ytPlayer.setVolume) { try { ytPlayer.setVolume(Math.round(v * 100)); } catch (e) {} }
    spotify.sdk.setVolume && spotify.sdk.setVolume(v);
    synth.setVolume(v);
    if (L.soundcloud) L.soundcloud.setVolume(v);
  }

  function toggleMute() {
    store.set({ muted: !store.state.muted });
    applyVolume();
  }

  /* ---------------- queue ---------------- */
  function shuffled(list, keepFirst) {
    const arr = list.slice();
    if (keepFirst && arr.length > 1) {
      const head = arr.splice(arr.indexOf(keepFirst), 1)[0];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return [head, ...arr];
    }
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function playCollection(tracks, startIndex = 0, context = null) {
    const list = (tracks || []).filter(Boolean);
    if (!list.length) {
      toast({ title: 'Nothing to play', text: 'This collection has no playable tracks yet.' });
      return;
    }
    const first = list[clamp(startIndex, 0, list.length - 1)];
    const origin = list.slice();
    const queue = store.state.shuffle ? shuffled(origin, first) : origin;
    const index = queue.indexOf(first);
    store.set({ queue, queueOrigin: origin, index, context });
    load(queue[index], { autoplay: true });
  }

  function playTrack(track, context = null) {
    playCollection([track], 0, context);
  }

  function addToQueue(track, { next: playNext = false, silent = false } = {}) {
    if (!track) return;
    const q = store.state.queue.slice();
    const origin = store.state.queueOrigin.slice();
    if (!q.length) {
      store.set({ queue: [track], queueOrigin: [track], index: 0 });
      load(track, { autoplay: true });
      return;
    }
    const at = playNext ? store.state.index + 1 : q.length;
    q.splice(at, 0, track);
    origin.push(track);
    store.set({ queue: q, queueOrigin: origin });
    if (!silent) toast({ kind: 'success', title: playNext ? 'Playing next' : 'Added to queue', text: track.title });
  }

  function addManyToQueue(tracks) {
    const list = (tracks || []).filter(Boolean);
    if (!list.length) return;
    if (!store.state.queue.length) { playCollection(list, 0, store.state.context); return; }
    store.set({
      queue: [...store.state.queue, ...list],
      queueOrigin: [...store.state.queueOrigin, ...list],
    });
    toast({ kind: 'success', title: `Added ${list.length} tracks`, text: 'Queued up next.' });
  }

  function removeFromQueue(index) {
    const q = store.state.queue.slice();
    if (index < 0 || index >= q.length) return;
    const [removed] = q.splice(index, 1);
    let idx = store.state.index;
    if (index < idx) idx -= 1;
    else if (index === idx) {
      // dropping the current track: move to the one that slid into place
      store.set({ queue: q, queueOrigin: store.state.queueOrigin.filter((t) => t !== removed), index: Math.min(idx, q.length - 1) });
      if (q.length) load(q[Math.min(idx, q.length - 1)], { autoplay: store.state.playing });
      else stop();
      return;
    }
    store.set({ queue: q, queueOrigin: store.state.queueOrigin.filter((t) => t !== removed), index: idx });
  }

  function moveInQueue(from, to) {
    const q = store.state.queue.slice();
    if (from === to || from < 0 || to < 0 || from >= q.length || to >= q.length) return;
    const current = q[store.state.index];
    const [item] = q.splice(from, 1);
    q.splice(to, 0, item);
    store.set({ queue: q, index: q.indexOf(current) });
  }

  function clearQueue() {
    const current = store.currentTrack();
    if (!current) { store.set({ queue: [], queueOrigin: [], index: -1 }); return; }
    store.set({ queue: [current], queueOrigin: [current], index: 0 });
    toast({ title: 'Queue cleared', text: 'Kept the track that’s playing.' });
  }

  function stop() {
    stopAllBackends(null);
    stopTicker();
    stopKeepAlive();
    releaseWakeLock();
    backend = 'none';
    store.set({ backend, playing: false, position: 0, duration: 0, index: -1, queue: [], queueOrigin: [] });
  }

  function setShuffle(on) {
    const enable = on === undefined ? !store.state.shuffle : !!on;
    const current = store.currentTrack();
    if (enable) {
      const origin = store.state.queueOrigin.length ? store.state.queueOrigin : store.state.queue;
      const queue = shuffled(origin, current);
      store.set({ shuffle: true, queue, index: current ? queue.indexOf(current) : 0 });
    } else {
      const origin = store.state.queueOrigin.length ? store.state.queueOrigin.slice() : store.state.queue.slice();
      store.set({ shuffle: false, queue: origin, index: current ? Math.max(0, origin.indexOf(current)) : 0 });
    }
    return enable;
  }

  function cycleRepeat() {
    const order = ['off', 'all', 'one'];
    const next = order[(order.indexOf(store.state.repeat) + 1) % order.length];
    store.set({ repeat: next });
    return next;
  }

  function next(auto = false) {
    const { queue, index, repeat } = store.state;
    if (!queue.length) return;

    if (auto && repeat === 'one') { seekTo(0); play(); return; }

    if (index + 1 < queue.length) {
      store.set({ index: index + 1 });
      load(queue[index + 1], { autoplay: true });
      return;
    }
    if (repeat === 'all' || !auto) {
      store.set({ index: 0 });
      load(queue[0], { autoplay: repeat === 'all' || !auto });
      return;
    }
    // end of queue
    pause();
    store.set({ position: 0 });
    toast({ title: 'End of queue', text: 'Turn on repeat or add more tracks.' });
  }

  function prev() {
    const { queue, index, position } = store.state;
    if (!queue.length) return;
    if (position > 4) { seekTo(0); return; }
    const target = index - 1 >= 0 ? index - 1 : (store.state.repeat === 'all' ? queue.length - 1 : 0);
    store.set({ index: target });
    load(queue[target], { autoplay: true });
  }

  function handleEnded() {
    if (store.state.repeat === 'one') {
      const t = store.currentTrack();
      if (backend === 'demo') { synth.offset = 0; synth.start(t, 0); store.set({ position: 0, playing: true }); return; }
      seekTo(0); play(); return;
    }
    if (!store.state.settings.autoplayNext) { pause(); return; }
    next(true);
  }

  /* ---------------- init ---------------- */
  function init() {
    applyVolume();
    // Resume a persisted queue without auto-starting audio
    const track = store.currentTrack();
    if (track) {
      store.set({ duration: track.duration || 0, position: 0, playing: false });
    }

    // media session integration (lock screen / OS controls / headset buttons)
    if ('mediaSession' in navigator) {
      const ms = navigator.mediaSession;
      store.on(['index', 'queue', 'backend'], updateMediaSession);

      // Unsupported actions throw rather than no-op, so each one is guarded.
      const handler = (name, fn) => { try { ms.setActionHandler(name, fn); } catch (e) {} };
      handler('play', () => { resumeAudioCtx(); play(); });
      handler('pause', pause);
      handler('previoustrack', prev);
      handler('nexttrack', () => next(false));
      handler('seekbackward', (d) => nudge(-((d && d.seekOffset) || 10)));
      handler('seekforward', (d) => nudge((d && d.seekOffset) || 10));
      handler('seekto', (d) => {
        const dur = store.state.duration;
        if (!d || !dur || typeof d.seekTime !== 'number') return;
        if (d.fastSeek && backend === 'audio' && audioEl && audioEl.fastSeek) {
          try {
            audioEl.fastSeek(d.seekTime);
            store.set({ position: d.seekTime });
            syncPositionState();
            return;
          } catch (e) { /* fall through to a normal seek */ }
        }
        seekTo(d.seekTime / dur);
      });
      handler('stop', () => { pause(); seekTo(0); });

      updateMediaSession();
    }
    store.on('playing', (p) => {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = p ? 'playing' : 'paused';
      if (p) { startKeepAlive(); requestWakeLock(); } else { stopKeepAlive(); releaseWakeLock(); }
    });

    /* Both background switches change how the element is wired to the speakers,
       so apply them the moment they are toggled instead of at the next track. */
    store.on('settings', () => {
      store.state.settings.keepAwake ? requestWakeLock() : releaseWakeLock();
      if (backend !== 'audio' || !audioEl) return;
      const src = audioEl.currentSrc || audioEl.src;
      if (!src) return;
      const want = store.state.settings.showVisualizer && graphIsSafe() && !noCorsHosts.has(hostOf(src));
      if (want === corsOk) return;
      const t = store.currentTrack();
      if (t) load(t, { autoplay: store.state.playing, startAt: store.state.position });
    });

    /* Some browsers will only let a suspended context restart from a real user
       gesture, so treat every interaction as a chance to recover. */
    ['pointerdown', 'touchend', 'keydown'].forEach((evt) => {
      document.addEventListener(evt, resumeAudioCtx, { capture: true, passive: true });
    });

    /* Coming back from the background: interval callbacks were throttled while
       hidden and the context may have been suspended, so re-sync everything
       from the element, which is the only thing that stayed accurate. */
    window.addEventListener('pageshow', () => {
      resumeAudioCtx();
      if (store.state.playing) { startTicker(); startKeepAlive(); }
    });

    /* HTML5 audio keeps going when the tab is hidden as long as we never let it
       get trapped behind a suspended AudioContext. YouTube's embed, by
       contrast, is required to pause; when the user comes back, offer to resume
       rather than leaving them looking at a stalled player. */
    document.addEventListener('visibilitychange', () => {
      resumeAudioCtx();
      if (document.visibilityState !== 'visible') return;

      if (store.state.playing) { startTicker(); startKeepAlive(); }
      requestWakeLock();            // the OS drops screen locks whenever we hide
      if (backend === 'audio' && audioEl) {
        store.set({ position: audioEl.currentTime || 0 });
        syncPositionState();
      }

      if (backend !== 'youtube' || !ytPlayer) return;
      if (!store.state.playing) return;
      try {
        const YTS = window.YT && window.YT.PlayerState;
        if (YTS && ytPlayer.getPlayerState() === YTS.PAUSED) {
          store.set({ playing: false });
          toast({
            title: 'Paused by YouTube',
            text: 'YouTube stops playback when the tab is hidden.',
            action: { label: 'Resume', onClick: () => { try { ytPlayer.playVideo(); } catch (e) {} } },
            timeout: 6000,
          });
        }
      } catch (e) {}
    });
  }

  /**
   * Android picks the closest size from the list and will fall back to a blank
   * notification if nothing matches, so offer the artwork at every size it asks
   * for and keep the app icon as a last resort.
   */
  function artworkFor(t) {
    const list = [];
    if (t.artwork) {
      const type = /\.png(\?|#|$)/i.test(t.artwork) ? 'image/png' : 'image/jpeg';
      ['96x96', '128x128', '192x192', '256x256', '384x384', '512x512']
        .forEach((sizes) => list.push({ src: t.artwork, sizes, type }));
    }
    try {
      list.push({ src: new URL('assets/img/icon-192.png', location.href).href, sizes: '192x192', type: 'image/png' });
      list.push({ src: new URL('assets/img/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' });
    } catch (e) {}
    return list;
  }

  function updateMediaSession() {
    const t = store.currentTrack();
    if (!t || !('mediaSession' in navigator) || !window.MediaMetadata) return;
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: t.title || '',
        artist: t.artist || '',
        album: t.album || 'Loru Player',
        artwork: artworkFor(t),
      });
      navigator.mediaSession.playbackState = store.state.playing ? 'playing' : 'paused';
    } catch (e) {}
    syncPositionState();
  }

  L.engine = {
    init, load, play, pause, toggle, stop,
    seekTo, nudge, setVolume, toggleMute, applyVolume,
    playCollection, playTrack, addToQueue, addManyToQueue,
    removeFromQueue, moveInQueue, clearQueue,
    setShuffle, cycleRepeat, next, prev,
    showYouTubeSurface, resumeFromGesture, prewarmYouTube, resumeAudioCtx,
    get backend() { return backend; },
    get analyser() { return analyser; },
    get audioEl() { return audioEl; },
    get audioCtx() { return audioCtx; },
    /** Whether the current backend can keep playing with the screen off. */
    get backgroundCapable() { return canPlayInBackground(); },
  };
})(window.Loru);
