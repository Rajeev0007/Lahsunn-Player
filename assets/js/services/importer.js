/* ============================================================
   Loru Player — services/importer.js
   Turns any pasted link into a playable collection.
   ============================================================ */
(function (L) {
  'use strict';

  const { audius, youtube, spotify, store } = L;

  const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|weba|webm)(\?|#|$)/i;
  const STREAMY = /(stream|listen|radio|icecast|shoutcast|:8000|\/;)/i;

  const UNSUPPORTED = [
    { host: /(^|\.)music\.apple\.com$/, name: 'Apple Music' },
    { host: /(^|\.)deezer\.com$/, name: 'Deezer' },
    { host: /(^|\.)tidal\.com$/, name: 'Tidal' },
    { host: /(^|\.)music\.amazon\./, name: 'Amazon Music' },
    { host: /(^|\.)bandcamp\.com$/, name: 'Bandcamp' },
    { host: /(^|\.)mixcloud\.com$/, name: 'Mixcloud' },
  ];

  /** Used by the search bar to decide "is the user pasting a link?" */
  function looksLikeLink(text) {
    const s = String(text || '').trim();
    if (!s || /\s/.test(s)) return false;
    return /^(https?:\/\/|spotify:)/i.test(s) || /^[\w.-]+\.[a-z]{2,}\//i.test(s);
  }

  /**
   * Classify a pasted string.
   * @returns {{source:string, entityKind?:string, id?:string, url?:string, list?:string}}
   */
  function detect(input) {
    const raw = String(input || '').trim();
    if (!raw) return { source: 'empty' };

    const sp = spotify.parse(raw);
    if (sp) return { source: 'spotify', entityKind: sp.kind, id: sp.id };

    const yt = youtube.parse(raw);
    if (yt) return { source: 'youtube', entityKind: yt.kind, id: yt.id, list: yt.list || null };

    const sc = L.soundcloud && L.soundcloud.parse(raw);
    if (sc) return { source: 'soundcloud', entityKind: sc.kind, url: sc.url, title: sc.title, user: sc.user };

    let url = null;
    try { url = new URL(raw.startsWith('http') ? raw : 'https://' + raw); } catch (e) { /* not a URL */ }

    if (url) {
      if (/(^|\.)audius\.co$/.test(url.hostname)) return { source: 'audius', url: url.href };

      const blocked = UNSUPPORTED.find((u) => u.host.test(url.hostname));
      if (blocked) return { source: 'unsupported', service: blocked.name, url: url.href };

      if (AUDIO_EXT.test(url.pathname) || STREAMY.test(url.href)) return { source: 'url', url: url.href };

      return { source: 'unknown', url: url.href };
    }

    return { source: 'query', query: raw };
  }

  const SOURCE_LABELS = {
    spotify: 'Spotify', youtube: 'YouTube', audius: 'Audius',
    soundcloud: 'SoundCloud', itunes: 'Apple', url: 'Direct stream',
  };

  function labelFor(d) {
    if (!d) return 'Link';
    const base = SOURCE_LABELS[d.source] || 'Link';
    return d.entityKind ? `${base} ${d.entityKind}` : base;
  }

  function titleFromUrl(href) {
    try {
      const u = new URL(href);
      const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
      return last.replace(AUDIO_EXT, '').replace(/[-_+]/g, ' ').trim() || u.hostname;
    } catch (e) { return 'Audio stream'; }
  }

  function needsSpotifyAuth() {
    if (!spotify.isConfigured()) {
      const err = new Error('Add your free Spotify Client ID in Settings to link Spotify playlists.');
      err.action = { label: 'Open Settings', hash: '#/settings' };
      return err;
    }
    if (!spotify.isConnected()) {
      const err = new Error('Sign in to Spotify to read that link.');
      err.action = { label: 'Connect Spotify', spotifyLogin: true };
      return err;
    }
    return null;
  }

  /* ---------------- Router ---------------- */
  async function importDetected(d, { onProgress, onStatus } = {}) {
    const say = (msg) => onStatus && onStatus(msg);

    /* ---- Spotify ---- */
    if (d.source === 'spotify') {
      const authErr = needsSpotifyAuth();
      if (authErr) throw authErr;

      if (d.entityKind === 'playlist') {
        say('Reading Spotify playlist…');
        const pl = await spotify.getPlaylist(d.id);
        return { kind: 'playlist', collection: pl };
      }
      if (d.entityKind === 'album') {
        say('Reading Spotify album…');
        return { kind: 'playlist', collection: await spotify.getAlbum(d.id) };
      }
      if (d.entityKind === 'artist') {
        say('Reading top tracks…');
        const tracks = await spotify.artistTop(d.id);
        return {
          kind: 'playlist',
          collection: {
            id: 'sp-artist-' + d.id, source: 'spotify', name: 'Top tracks on Spotify',
            description: 'Most played tracks for this artist',
            artwork: tracks[0] ? tracks[0].artwork : null,
            externalUrl: `https://open.spotify.com/artist/${d.id}`,
            tracks,
          },
        };
      }
      say('Reading Spotify track…');
      const track = await spotify.getTrack(d.id);
      return { kind: 'track', collection: { id: 'sp-' + d.id, source: 'spotify', name: track.title, tracks: [track] } };
    }

    /* ---- YouTube ---- */
    if (d.source === 'youtube') {
      const listId = d.entityKind === 'playlist' ? d.id : d.list;
      if (listId) {
        say('Opening YouTube playlist…');
        const pl = await youtube.resolvePlaylist(listId, { onProgress });
        return { kind: 'playlist', collection: pl };
      }
      say('Reading YouTube video…');
      const track = await youtube.resolveVideo(d.id);
      return { kind: 'track', collection: { id: 'yt-' + d.id, source: 'youtube', name: track.title, tracks: [track] } };
    }

    /* ---- SoundCloud (official widget, no key) ---- */
    if (d.source === 'soundcloud') {
      if (d.entityKind === 'user') {
        const err = new Error('That is a SoundCloud profile. Paste a link to a specific track or playlist.');
        err.recoverable = true;
        throw err;
      }
      if (d.entityKind === 'playlist') {
        /* The widget plays a set as one unit and does not expose its track
           list without an API key, so it enters the queue as a single item
           that advances internally. */
        say('Loading SoundCloud playlist…');
        const track = L.soundcloud.toTrack({ url: d.url, title: d.title, user: d.user });
        track.isSet = true;
        return { kind: 'track', collection: { id: 'sc-' + d.url, source: 'soundcloud', name: d.title, tracks: [track] } };
      }
      say('Loading SoundCloud track…');
      const track = L.soundcloud.toTrack({ url: d.url, title: d.title, user: d.user });
      return { kind: 'track', collection: { id: 'sc-' + d.url, source: 'soundcloud', name: track.title, tracks: [track] } };
    }

    /* ---- Audius ---- */
    if (d.source === 'audius') {
      say('Resolving Audius link…');
      const res = await audius.resolve(d.url);
      if (res.kind === 'playlist') return { kind: 'playlist', collection: res.data };
      if (res.kind === 'artist') {
        return {
          kind: 'playlist',
          collection: {
            id: 'au-artist-' + res.data.id, source: 'audius', name: res.data.name,
            description: 'Tracks on Audius', artwork: res.data.artwork,
            externalUrl: res.data.externalUrl, tracks: res.data.tracks,
          },
        };
      }
      return { kind: 'track', collection: { id: 'au-' + res.data.id, source: 'audius', name: res.data.title, tracks: [res.data] } };
    }

    /* ---- Direct audio / radio ---- */
    if (d.source === 'url') {
      const title = titleFromUrl(d.url);
      let hostname = 'Direct link';
      try { hostname = new URL(d.url).hostname.replace(/^www\./, ''); } catch (e) {}
      const track = {
        id: d.url, source: 'url', title, artist: hostname,
        artwork: null, duration: 0, streamUrl: d.url, permalink: d.url,
        isStream: !AUDIO_EXT.test(d.url),
      };
      return { kind: 'track', collection: { id: 'url-' + title, source: 'url', name: title, tracks: [track] } };
    }

    /* ---- Not importable ---- */
    if (d.source === 'unsupported') {
      const err = new Error(`${d.service} blocks third-party playback. Loru can search that title on Audius instead.`);
      err.recoverable = true;
      err.searchFallback = titleFromUrl(d.url);
      throw err;
    }
    if (d.source === 'unknown') {
      const err = new Error('That link is not a recognised playlist, track or audio stream.');
      err.recoverable = true;
      throw err;
    }
    if (d.source === 'query') {
      const err = new Error('That looks like a search, not a link.');
      err.isQuery = true;
      err.query = d.query;
      throw err;
    }
    throw new Error('Paste a link first.');
  }

  const importLink = (input, opts) => importDetected(detect(input), opts);

  /**
   * Make a track playable.
   *
   * Spotify blocks full-length playback outside its own app unless the
   * listener has Premium, so for everyone else the order is:
   *   full YouTube match → Audius match → 30-second preview.
   * The YouTube step ends in a key-less official-player lookup, so it
   * succeeds even with no API key and every public mirror offline.
   *
   * @returns {Promise<{track:object, note?:string}>}
   */
  async function resolvePlayable(track) {
    if (!track) throw new Error('No track to play.');

    /* Apple chart entries carry no preview URL, and previews are only 30
       seconds anyway, so fall through to a full YouTube version. */
    if (track.source === 'itunes' && (!track.streamUrl || track.needsMatch)) {
      const yt = await youtube.findMatch(track.title, track.artist).catch(() => null);
      if (yt) {
        return {
          track: {
            ...track, playbackVia: 'youtube', matchedFrom: 'itunes',
            ytVideoId: yt.videoId, duration: yt.duration || track.duration,
          },
          note: `Playing the full track from YouTube: “${yt.title}”.`,
        };
      }
      const err = new Error(`No playable source found for “${track.title}”.`);
      err.permalink = track.permalink;
      throw err;
    }

    if (track.source !== 'spotify') return { track };
    if (store.state.connections.spotify.premium) return { track };

    /* A full-length YouTube match beats a 30-second preview, so try it first.
       `videoId` is kept in a separate field so the track keeps its Spotify
       identity (and therefore its liked state) while playing from YouTube. */
    const tryYouTube = async () => {
      if (!store.state.settings.preferYouTubeForSpotify) return null;
      const yt = await youtube.findMatch(track.title, track.artist).catch(() => null);
      if (!yt) return null;
      return {
        track: {
          ...track, playbackVia: 'youtube', matchedFrom: 'spotify',
          ytVideoId: yt.videoId, duration: yt.duration || track.duration,
        },
        note: `Playing the full track from YouTube: “${yt.title}”.`,
      };
    };

    const tryAudius = async () => {
      const match = await audius.findMatch(track.title, track.artist).catch(() => null);
      if (!match) return null;
      return {
        track: {
          ...track, playbackVia: 'audius', matchedFrom: 'spotify',
          streamUrl: match.streamUrl, audiusId: match.id,
          duration: match.duration || track.duration,
        },
        note: `Streaming an ad-free match from Audius: “${match.title}”.`,
      };
    };

    /* Audius never serves ads, but its catalogue is independent artists
       only. YouTube has everything and may play an ad first. The listener
       chooses which trade-off they want. */
    const order = store.state.settings.adFreeFirst
      ? [tryAudius, tryYouTube]
      : [tryYouTube, tryAudius];

    for (const attempt of order) {
      const resolved = await attempt();
      if (resolved) return resolved;
    }

    /* Last resort before giving up: a 30-second preview is still better
       than silence, but only if every full-length route failed. */
    if (track.previewUrl) {
      return {
        track: { ...track, playbackVia: 'preview', streamUrl: track.previewUrl, duration: 30 },
        note: 'Could not find a full version, so this is Spotify’s 30-second preview.',
      };
    }

    const err = new Error(`Couldn’t find anywhere to stream “${track.title}”. YouTube may be unreachable right now.`);
    err.permalink = track.permalink;
    throw err;
  }

  L.importer = {
    looksLikeLink, detect, labelFor, titleFromUrl,
    importDetected, importLink, resolvePlayable,
  };
})(window.Loru);
