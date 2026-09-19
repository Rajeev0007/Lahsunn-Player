# Loru Player

An online music player for phone, tablet and desktop. Loru never touches local
files — it links the playlists you already have and streams each track from the
service that hosts it.

```
┌──────────┬──────────────────────────────────┬─────────┐
│ sidebar  │ home · search · library · link   │ queue   │
├──────────┴──────────────────────────────────┴─────────┤
│ player bar — seek · shuffle · repeat · volume · full  │
└───────────────────────────────────────────────────────┘
```

## What it does

| Source | Setup needed | What you get |
| --- | --- | --- |
| **Audius** | none | Full-length streaming, search, trending, genre and mood mixes. Powers the browse experience out of the box. |
| **YouTube** | none | Paste any public playlist, mix or video link. Plays through YouTube's official embedded player. |
| **Spotify** | your own free Client ID | Reads your playlists, albums and liked songs. Full tracks need Premium; otherwise Loru plays the 30-second preview or finds a matching Audius stream. |
| **Direct links** | none | Any reachable MP3/AAC/OGG/FLAC URL, plus live internet radio streams. |

Everything else — playlists you build, liked songs, history, settings — lives in
your browser's local storage. There is no Loru account and no backend.

## Running it

Loru is a static site with no build step, but it **must be served over HTTP**.
Opening `index.html` from the file system breaks the YouTube player and the
Spotify login redirect.

```bash
cd loru-player
python3 -m http.server 4173
# then open http://127.0.0.1:4173/index.html
```

Any static host works: Vercel, GitHub Pages, Netlify, S3, nginx. Upload the
folder as-is.

## Deploying to Vercel

Loru is static with no build step, so it runs on the free Hobby plan untouched.
Hash-based routing (`#/library`) means **no SPA rewrite rules are needed** —
deep links work out of the box.

**From a Git repo (recommended):** import the repo in the Vercel dashboard.

- Framework Preset: **Other**
- Build Command: **leave empty**
- Output Directory: **leave empty** (the repo root is served)
- If `loru-player/` is a subfolder of the repo, set **Root Directory** to
  `loru-player`

**From the CLI:**

```bash
npm i -g vercel
cd loru-player
vercel          # preview deployment
vercel --prod   # production
```

`vercel.json` sets `cleanUrls` (so `/index.html` canonically redirects to `/`),
cache headers for `assets/`, and a few safe security headers. `.vercelignore`
keeps the dev-only `tools/` folder out of the deployment.

### Spotify on a deployed site

Two things change once you are on a real domain:

1. **Register the production URL as a Redirect URI.** Use the exact value shown
   in **Settings → Spotify → Redirect URI**, which will be
   `https://your-project.vercel.app/` — with the trailing slash and no
   `index.html`. Loru canonicalises this, so one entry covers visitors who
   arrive at either `/` or `/index.html`.
2. **Preview deployments get a different URL every time** (for example
   `your-project-a1b2c3.vercel.app`), and Spotify only accepts redirect URIs you
   registered. Sign in to Spotify on the production domain, or add each preview
   URL you actually want to test. A custom domain avoids the problem entirely —
   register that instead and it never changes.

Hosting on Vercel also satisfies Spotify's requirement that redirect URIs use
HTTPS (only `http://localhost` and `http://127.0.0.1` are exempt), so Spotify
login works on a deployed Loru but would not on a plain `http://` host.

> **Note on CSP:** no Content-Security-Policy header is set. Loru loads scripts
> and media from YouTube, Spotify's SDK, Audius content nodes and arbitrary
> user-supplied stream URLs, so a policy tight enough to be useful is easy to
> get wrong and would break playback. Add one deliberately if you need it, and
> test every source afterwards.

Add `?demo=1` to the URL to fill the app with a sample catalogue that works with
no connection at all — useful for previewing the interface. The same switch
lives in **Settings → Playback → Demo content**.

## Connecting Spotify

Spotify requires every application to use its own Client ID, so each listener
sets this up once. It takes about a minute.

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
   and create an app (any name).
2. Add your Loru address as a **Redirect URI**, exactly as shown in
   **Settings → Spotify → Redirect URI**, for example
   `https://yoursite.example/index.html`.
3. Enable **Web API** and **Web Playback SDK**, then save.
4. Copy the Client ID into Loru and press connect.

Loru uses the Authorization Code + PKCE flow, so no client secret is involved
and nothing is sent to a server. The token is stored in your browser only.

**Playback reality check:** Spotify does not permit third-party web players to
stream full tracks without Premium. With a free account Loru still imports your
playlists and plays each song using its 30-second preview, or the closest
full-length match it can find on Audius. This is a platform restriction, not a
missing feature.

## Services that cannot be supported

Apple Music, SoundCloud, Deezer, Tidal, Amazon Music, Bandcamp and Mixcloud do
not allow third-party web playback of their catalogues. Pasting one of those
links shows an explanation and offers to search the same titles on Audius
instead.

## Interface notes

- **Desktop** — three columns: navigation, content, and an optional queue panel.
- **Tablet** — the sidebar collapses to an icon rail.
- **Phone** — sidebar becomes a drawer, a mini player sits above a bottom tab
  bar, and tapping it opens the full-screen player (swipe down to dismiss).
- Light and dark themes, five accent ramps, and a live audio visualizer.
- OS media keys and lock-screen controls work through the Media Session API.

### Keyboard shortcuts

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| `Space` | Play / pause | `M` | Mute |
| `→` `←` | Seek 5s (`Shift` 30s) | `L` | Like current track |
| `↑` `↓` | Volume | `Q` | Toggle queue |
| `N` `P` | Next / previous | `F` | Full-screen player |
| `S` | Shuffle | `/` | Focus search |
| `R` | Repeat mode | `Esc` | Close overlay |
| `G` then `H` / `L` / `K` | Go to home / library / link sources | | |

## Project layout

```
loru-player/
├── index.html              app shell, icon sprite, diagnostics hook
├── vercel.json             cleanUrls, cache + security headers
├── .vercelignore           keeps tools/ out of deployments
├── assets/
│   ├── css/
│   │   ├── theme.css       design tokens, reset, ambient background
│   │   ├── layout.css      app shell, player bar, responsive rules
│   │   └── components.css  buttons, cards, rows, modals, toasts
│   ├── img/favicon.svg
│   └── js/
│       ├── utils.js        DOM helpers, formatting, storage, toasts, sliders
│       ├── store.js        reactive state + persisted library
│       ├── catalog.js      browse data + offline demo catalogue
│       ├── services/
│       │   ├── audius.js   key-less search / trending / streaming
│       │   ├── youtube.js  IFrame player + playlist import via oEmbed
│       │   ├── spotify.js  PKCE auth, Web API, Web Playback SDK
│       │   └── importer.js link detection and routing
│       ├── engine.js       queue + four playback backends
│       ├── visualizer.js   canvas spectrum with synthetic fallback
│       ├── ui/
│       │   ├── components.js  shared renderers
│       │   ├── views.js       every screen
│       │   └── player.js      player bar, queue, full-screen player
│       └── app.js          router, theme, keyboard, boot
└── tools/                  dev-only capture helpers (not needed at runtime)
```

### Playback backends

`engine.js` keeps one queue and switches transport per track:

| Track source | Backend |
| --- | --- |
| Audius, direct URL, Spotify preview | `HTMLAudioElement` |
| YouTube | YouTube IFrame Player API |
| Spotify with Premium | Spotify Web Playback SDK |
| Demo catalogue | WebAudio synth pad (offline) |

If a stream is served without CORS headers the engine transparently reloads it
without `crossOrigin` so audio keeps working, and the visualizer falls back to a
synthetic waveform rather than going silent.

## Development helpers

`tools/` contains scripts used to verify rendering in headless Chrome:

```bash
tools/capture.sh              # one route at three viewports
tools/capture-all.sh          # every route, reports JS errors per page
tools/capture-states.sh       # playback, queue, full-screen, modals
```

Runtime script errors are collected into `window.__loruErrors` and mirrored into
a hidden `#__diag` element, which is what those scripts read.

## Known limits

- YouTube search needs an API key, so Loru links out to YouTube search rather
  than listing results inline. Playlist and video **links** work without a key.
- YouTube videos whose uploader disables embedding are skipped automatically.
- Imported playlists are snapshots. Use **Refresh** on a playlist to re-read it
  from the source.
- Library data is per-browser. Use **Settings → Export library** to move it.
