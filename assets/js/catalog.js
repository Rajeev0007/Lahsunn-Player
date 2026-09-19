/* ============================================================
   Loru Player — catalog.js
   Curated browse data + offline demo catalogue (?demo=1)
   ============================================================ */
(function (L) {
  'use strict';

  /* Audius genre keys used for the browse rails */
  const GENRES = [
    { id: 'Electronic', name: 'Electronic' },
    { id: 'Hip-Hop/Rap', name: 'Hip-Hop' },
    { id: 'Lo-Fi', name: 'Lo-Fi' },
    { id: 'House', name: 'House' },
    { id: 'Ambient', name: 'Ambient' },
    { id: 'Rock', name: 'Rock' },
    { id: 'Jazz', name: 'Jazz' },
    { id: 'R&B/Soul', name: 'R&B / Soul' },
    { id: 'Techno', name: 'Techno' },
    { id: 'Drum & Bass', name: 'Drum & Bass' },
    { id: 'Classical', name: 'Classical' },
    { id: 'World', name: 'World' },
  ];

  /* Mood tiles — each resolves to a live search when online */
  const MOODS = [
    { id: 'focus', name: 'Deep Focus', query: 'lofi focus study', icon: 'sparkle', hue: 258 },
    { id: 'workout', name: 'Workout Energy', query: 'workout energy edm', icon: 'wave', hue: 12 },
    { id: 'chill', name: 'Late Night Chill', query: 'chillhop night', icon: 'wave', hue: 200 },
    { id: 'party', name: 'Party Starters', query: 'party house dance', icon: 'sparkle', hue: 320 },
    { id: 'commute', name: 'Commute', query: 'indie drive', icon: 'globe', hue: 168 },
    { id: 'sleep', name: 'Sleep & Ambient', query: 'ambient sleep calm', icon: 'wave', hue: 228 },
  ];

  /* Example links shown in the "Link sources" view */
  const LINK_EXAMPLES = [
    { source: 'spotify', label: "Spotify playlist", value: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M' },
    { source: 'youtube', label: 'YouTube playlist', value: 'https://www.youtube.com/playlist?list=PLFgquLnL59alW3xmYiWRaoz0oM3H17Lth' },
    { source: 'url', label: 'Direct audio / radio stream', value: 'https://stream.radioparadise.com/mp3-192' },
  ];

  const FEATURES = [
    { icon: 'globe', title: 'Nothing to download', text: 'Everything streams straight from the web. No files, no storage, no sync.' },
    { icon: 'link', title: 'Bring your own playlists', text: 'Paste a Spotify, YouTube or Audius link and Loru builds the queue for you.' },
    { icon: 'devices', title: 'One player, every screen', text: 'A single layout that reflows for phone, tablet and desktop — including full-screen mode.' },
    { icon: 'sparkle', title: 'Built for listening', text: 'Gapless queueing, shuffle, repeat, keyboard control and a live visualizer.' },
  ];

  /* ============================================================
     Demo catalogue — used when ?demo=1 or when the user picks
     "Preview with demo content". Tracks play a synthesised pad so
     the whole interface is explorable with zero network access.
     ============================================================ */
  const DEMO_ARTISTS = ['Nova Kline', 'Atlas Fields', 'Mira Sol', 'The Quiet Static', 'Kaiho', 'Lantern Bay', 'Odette Park', 'Rune & Vale'];
  const DEMO_TITLES = [
    ['Paper Lanterns', 'Ambient', 214], ['Midnight Transit', 'Electronic', 248], ['Slow Orbit', 'Lo-Fi', 187],
    ['Neon Rainfall', 'House', 265], ['Glass Harbour', 'Ambient', 302], ['Cassette Summer', 'Lo-Fi', 176],
    ['Afterglow Drive', 'Electronic', 231], ['Velvet Static', 'R&B/Soul', 205], ['Signal Fires', 'Techno', 288],
    ['Low Tide Hymn', 'Jazz', 259], ['Paper Planes Over Kyoto', 'World', 223], ['Copper Skyline', 'Rock', 241],
    ['Hollow Bloom', 'Ambient', 276], ['Tokyo Laundromat', 'Lo-Fi', 168], ['Silver Arcade', 'Electronic', 254],
    ['Endless Commute', 'Drum & Bass', 236], ['Winter Frequency', 'Classical', 312], ['Golden Hour Loop', 'House', 268],
  ];

  function demoTracks() {
    return DEMO_TITLES.map((row, i) => {
      const [title, genre, duration] = row;
      const artist = DEMO_ARTISTS[i % DEMO_ARTISTS.length];
      return {
        id: 'demo-' + (i + 1),
        source: 'demo',
        title,
        artist,
        album: 'Loru Demo Sessions',
        genre,
        duration,
        artwork: null,
        plays: 12000 + i * 7331,
        tone: 174 + (i * 23) % 180,   // base frequency for the synth pad
      };
    });
  }

  function demoPlaylists() {
    const t = demoTracks();
    return [
      {
        id: 'demo-pl-1', name: 'Night Drive', description: 'Synth-forward cuts for empty motorways.',
        source: 'demo', artwork: null, tracks: [t[1], t[6], t[14], t[3], t[8], t[17]],
        createdAt: Date.now() - 864e5 * 6, updatedAt: Date.now() - 864e5,
      },
      {
        id: 'demo-pl-2', name: 'Focus Room', description: 'Low-key instrumentals that stay out of the way.',
        source: 'demo', artwork: null, tracks: [t[2], t[5], t[13], t[0], t[12], t[4]],
        createdAt: Date.now() - 864e5 * 12, updatedAt: Date.now() - 864e5 * 2,
      },
      {
        id: 'demo-pl-3', name: 'Sunday Slow', description: 'Soft edges, long fades.',
        source: 'demo', artwork: null, tracks: [t[9], t[7], t[16], t[10], t[11]],
        createdAt: Date.now() - 864e5 * 20, updatedAt: Date.now() - 864e5 * 3,
      },
    ];
  }

  const demo = {
    enabled: false,
    tracks: [],
    playlists: [],
    activate() {
      if (this.enabled) return;
      this.enabled = true;
      this.tracks = demoTracks();
      this.playlists = demoPlaylists();
    },
    byGenre(genre) {
      return this.tracks.filter((t) => t.genre === genre);
    },
    search(q) {
      const needle = String(q || '').toLowerCase().trim();
      if (!needle) return this.tracks.slice(0, 12);
      return this.tracks.filter((t) =>
        t.title.toLowerCase().includes(needle) ||
        t.artist.toLowerCase().includes(needle) ||
        (t.genre || '').toLowerCase().includes(needle));
    },
    trending(limit = 12) {
      return this.tracks.slice(0, limit);
    },
  };

  L.catalog = { GENRES, MOODS, LINK_EXAMPLES, FEATURES, demo };
})(window.Loru);
