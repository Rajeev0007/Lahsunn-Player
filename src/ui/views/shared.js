/* ============================================================
   Loru Player — ui/views/shared.js
   Generic building blocks every screen uses: async loading with
   skeletons, offline states, track rails and playlist cards.
   ============================================================ */
(function (L) {
  'use strict';

  const { el, icon, $, $$, store, engine, ui, audius, youtube, spotify, importer, catalog, toast, formatTime, formatTotal, formatCount, pluralize, relativeTime, setArt, debounce } = L;
  /* Where music comes from lives in data.js */
  const data = L.data;

  /* ============================================================
     Small shared pieces
     ============================================================ */

  /** Render an async block with skeleton → content → error states. */
  function asyncBlock(loader, render, { skeleton, onEmpty, onError } = {}) {
    const host = el('div');
    host.appendChild(skeleton || ui.skeletonCards(6));

    let cancelled = false;
    host.addEventListener('loru:cancel', () => { cancelled = true; });

    function run() {
      host.replaceChildren(skeleton ? skeleton.cloneNode(true) : ui.skeletonCards(6));
      Promise.resolve()
        .then(loader)
        .then((result) => {
          if (cancelled) return;
          const empty = !result || (Array.isArray(result) && !result.length);
          host.replaceChildren(empty
            ? (onEmpty ? onEmpty() : ui.emptyState({ title: 'Nothing here yet' }))
            : render(result));
        })
        .catch((err) => {
          if (cancelled) return;
          host.replaceChildren(onError ? onError(err, run) : offlineState(err, run));
        });
    }
    run();
    return host;
  }

  function offlineState(err, retry) {
    const message = (err && err.message) || 'Something went wrong.';
    const looksOffline = /failed to fetch|networkerror|load failed|abort|timeout|http 0/i.test(message) || !navigator.onLine;
    return ui.emptyState({
      icon: looksOffline ? 'globe' : 'info',
      title: looksOffline ? 'No connection to the music services' : 'Couldn’t load that',
      text: looksOffline
        ? 'Loru streams everything from the web, so it needs a live connection. You can still explore the interface with demo content.'
        : message,
      actions: [
        { label: 'Try again', icon: 'repeat', variant: 'soft', onClick: retry },
        !data.demo ? { label: 'Use demo content', icon: 'sparkle', variant: 'primary', onClick: () => data.enableDemo() } : null,
      ].filter(Boolean),
    });
  }

  /**
   * YouTube search can fail in two distinct ways, and the fix differs:
   * a bad/exhausted API key, or every keyless mirror being down.
   */
  function youtubeSearchError(err, retry, query) {
    const isKey = err.code === 'yt-key';
    if (err.tried) console.info('[Loru] YouTube mirrors tried:', err.tried);

    return ui.emptyState({
      compact: true,
      icon: 'youtube',
      title: isKey ? 'YouTube API key problem' : 'Can’t list results right now',
      text: `${err.message} You can still play the song directly — that route needs no key or mirror.`,
      actions: [
        { label: `Play “${query.length > 28 ? query.slice(0, 28) + '…' : query}”`, icon: 'play', variant: 'primary', onClick: () => playTopResult(query) },
        { label: 'Try again', icon: 'repeat', variant: 'soft', onClick: retry },
        { label: isKey ? 'Fix key' : 'Add an API key', icon: 'settings', onClick: () => { location.hash = '#/settings'; } },
      ],
    });
  }

  /**
   * Plays the top YouTube result for a phrase via the official player.
   * Independent of API keys and mirrors, so it is the reliable last resort
   * for "just play this song".
   */
  async function playTopResult(query) {
    const close = toast({ title: 'Finding that song…', text: query, timeout: 0 });
    try {
      const top = await youtube.resolveSearchTopResult(query);
      close();
      const track = youtube.toTrack(top.videoId, {
        title: top.title || query,
        artist: top.artist || 'YouTube',
      });
      engine.playTrack(track, { type: 'search', id: query, name: `Search: ${query}` });
      toast({ kind: 'success', title: 'Playing', text: track.title, timeout: 2600 });
    } catch (err) {
      close();
      toast({
        kind: 'error', title: 'Couldn’t find that song', text: err.message, timeout: 6000,
        action: { label: 'Open YouTube', onClick: () => window.open(youtube.searchUrl(query), '_blank', 'noopener') },
      });
    }
  }

  function trackRail(tracks, context) {
    return el('div.rail', tracks.map((t, i) => ui.mediaCard({
      title: t.title,
      sub: t.artist,
      artwork: t.artwork,
      badge: t.source,
      seed: t.title + t.artist,
      onOpen: () => engine.playCollection(tracks, i, context),
      onPlay: () => engine.playCollection(tracks, i, context),
    })));
  }

  function playlistCard(pl, { onOpen, onPlay } = {}) {
    return ui.mediaCard({
      title: pl.name,
      sub: pl.description ? pl.description.slice(0, 64) : (pl.owner ? `By ${pl.owner}` : pluralize(pl.trackCount || (pl.tracks || []).length, 'track')),
      artwork: pl.artwork || (pl.tracks && pl.tracks[0] && pl.tracks[0].artwork),
      badge: pl.source,
      seed: pl.name,
      onOpen, onPlay,
    });
  }


  L.viewkit = Object.assign(L.viewkit || {}, {
    asyncBlock, offlineState, youtubeSearchError, playTopResult, trackRail, playlistCard,
  });
})(window.Loru);
