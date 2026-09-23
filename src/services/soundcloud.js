/* ============================================================
   Loru Player — services/soundcloud.js
   Playback through SoundCloud's official Widget API.

   SoundCloud closed public API registration years ago, so searching
   their catalogue is not possible. Playback is, though: the embedded
   widget plays any public track from its URL with no key at all, and
   because it is SoundCloud's own player the artist still gets the play
   counted. Tracks the uploader has marked as non-embeddable will
   report an error, and are skipped.
   ============================================================ */
(function (L) {
  'use strict';

  const WIDGET_API = 'https://w.soundcloud.com/player/api.js';
  const PLAYER_BASE = 'https://w.soundcloud.com/player/';

  let apiPromise = null;
  let widget = null;
  let iframe = null;
  let handlers = {};
  let ready = false;

  /* ---------------- URL parsing ---------------- */
  function parse(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    let url;
    try { url = new URL(raw.startsWith('http') ? raw : 'https://' + raw); }
    catch (e) { return null; }
    if (!/(^|\.)soundcloud\.com$/.test(url.hostname) && !/(^|\.)snd\.sc$/.test(url.hostname)) return null;

    const parts = url.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;

    // /user/sets/playlist-name  → playlist
    if (parts[1] === 'sets' && parts[2]) {
      return { kind: 'playlist', url: `https://soundcloud.com/${parts[0]}/sets/${parts[2]}`, title: deslug(parts[2]), user: deslug(parts[0]) };
    }
    // /user/track-name → single track
    if (parts.length >= 2) {
      return { kind: 'track', url: `https://soundcloud.com/${parts[0]}/${parts[1]}`, title: deslug(parts[1]), user: deslug(parts[0]) };
    }
    // /user → profile, not directly playable
    return { kind: 'user', url: url.href, title: deslug(parts[0]), user: deslug(parts[0]) };
  }

  function deslug(s) {
    return decodeURIComponent(String(s || ''))
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** A playable Loru track from a SoundCloud link. */
  function toTrack(parsed) {
    return {
      id: parsed.url,
      source: 'soundcloud',
      scUrl: parsed.url,
      title: parsed.title || 'SoundCloud track',
      artist: parsed.user || 'SoundCloud',
      artwork: null,
      duration: 0,
      permalink: parsed.url,
    };
  }

  /* ---------------- Widget API ---------------- */
  function ensureApi() {
    if (window.SC && window.SC.Widget) return Promise.resolve(window.SC);
    if (apiPromise) return apiPromise;

    apiPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SoundCloud player could not be loaded.')), 12000);
      const s = document.createElement('script');
      s.src = WIDGET_API;
      s.async = true;
      s.onload = () => {
        clearTimeout(timer);
        window.SC && window.SC.Widget
          ? resolve(window.SC)
          : reject(new Error('SoundCloud player script loaded but is unusable.'));
      };
      s.onerror = () => { clearTimeout(timer); reject(new Error('SoundCloud player script was blocked.')); };
      document.head.appendChild(s);
    }).catch((err) => { apiPromise = null; throw err; });

    return apiPromise;
  }

  function host() {
    let el = document.getElementById('scHost');
    if (!el) {
      el = document.createElement('div');
      el.id = 'scHost';
      el.className = 'sc-host';
      el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(el);
    }
    return el;
  }

  function widgetSrc(trackUrl) {
    const params = new URLSearchParams({
      url: trackUrl,
      auto_play: 'false',
      hide_related: 'true',
      show_comments: 'false',
      show_user: 'true',
      show_reposts: 'false',
      show_teaser: 'false',
      visual: 'false',
    });
    return `${PLAYER_BASE}?${params}`;
  }

  /**
   * Load a track and (optionally) start it.
   * @param {string} trackUrl public soundcloud.com permalink
   * @param {object} cbs { onReady, onPlay, onPause, onFinish, onProgress, onError }
   */
  async function load(trackUrl, cbs = {}, { autoplay = true } = {}) {
    handlers = cbs;
    const SC = await ensureApi();

    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.id = 'scFrame';
      iframe.allow = 'autoplay';
      iframe.setAttribute('scrolling', 'no');
      iframe.setAttribute('frameborder', 'no');
      iframe.width = '100%';
      iframe.height = '120';
      iframe.src = widgetSrc(trackUrl);
      host().appendChild(iframe);

      widget = SC.Widget(iframe);
      bind(SC);
      await new Promise((resolve) => {
        const done = () => { ready = true; resolve(); };
        widget.bind(SC.Widget.Events.READY, done);
        setTimeout(done, 8000);   // never hang the queue on a silent widget
      });
    } else {
      ready = false;
      await new Promise((resolve) => {
        widget.load(trackUrl, {
          auto_play: autoplay,
          callback: () => { ready = true; resolve(); },
        });
        setTimeout(resolve, 8000);
      });
    }

    if (autoplay) { try { widget.play(); } catch (e) {} }
    return widget;
  }

  function bind(SC) {
    const E = SC.Widget.Events;
    widget.bind(E.PLAY, () => handlers.onPlay && handlers.onPlay());
    widget.bind(E.PAUSE, () => handlers.onPause && handlers.onPause());
    widget.bind(E.FINISH, () => handlers.onFinish && handlers.onFinish());
    widget.bind(E.ERROR, () => handlers.onError && handlers.onError(new Error('SoundCloud could not play that track (the uploader may not allow embedding).')));
    widget.bind(E.PLAY_PROGRESS, (data) => {
      if (handlers.onProgress) handlers.onProgress((data && data.currentPosition || 0) / 1000);
    });
  }

  /** Reads title/artist/artwork/duration once the widget knows them. */
  function currentSound() {
    return new Promise((resolve) => {
      if (!widget) { resolve(null); return; }
      try {
        widget.getCurrentSound((sound) => {
          if (!sound) { resolve(null); return; }
          resolve({
            title: sound.title || null,
            artist: (sound.user && sound.user.username) || null,
            artwork: (sound.artwork_url || (sound.user && sound.user.avatar_url) || '').replace('-large', '-t500x500') || null,
            duration: Math.round((sound.duration || 0) / 1000),
            permalink: sound.permalink_url || null,
          });
        });
      } catch (e) { resolve(null); }
      setTimeout(() => resolve(null), 4000);
    });
  }

  const play = () => { try { widget && widget.play(); } catch (e) {} };
  const pause = () => { try { widget && widget.pause(); } catch (e) {} };
  const seek = (seconds) => { try { widget && widget.seekTo(Math.max(0, seconds) * 1000); } catch (e) {} };
  const setVolume = (v) => { try { widget && widget.setVolume(Math.round(v * 100)); } catch (e) {} };

  L.soundcloud = {
    parse, toTrack, load, play, pause, seek, setVolume, currentSound,
    get ready() { return ready; },
    get widget() { return widget; },
  };
})(window.Loru);
