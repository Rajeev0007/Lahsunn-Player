<div align="center">

<img src="assets/img/logo.svg" width="120" alt="Loru Player" />

# Loru Player

**An online music player for phone, tablet and desktop.**
Search YouTube's full catalogue, link your Spotify playlists, read synced
lyrics — and never download a file.

[Live site](https://loruplayer.vercel.app) · [Deploying](docs/DEPLOY.md)

<sub>Made by <b>Rajeev</b> &lt;/&gt;</sub>

</div>

---

Loru is plain HTML, CSS and JavaScript. **No dependencies, no build step, no
backend, no account.** Everything you save lives in your own browser.

```
┌──────────┬──────────────────────────────────┬─────────┐
│ sidebar  │ home · search · library · link   │ queue   │
├──────────┴──────────────────────────────────┴─────────┤
│ player bar — seek · shuffle · repeat · volume · full   │
└───────────────────────────────────────────────────────┘
```

## Where the music comes from

| Source | Setup | Playback |
| --- | --- | --- |
| **YouTube** | none | Full length. Search plus any playlist or video link. This is what makes the whole catalogue reachable. |
| **Apple Music** | none | Searchable with the best metadata and artwork. Apple only exposes 30-second previews, so Loru automatically plays the **full song from YouTube** instead. |
| **SoundCloud** | none | Full length, through SoundCloud's official widget. Paste a track or playlist link — searching is impossible since public API signups closed. |
| **Audius** | none | Full length and genuinely ad-free, but independent artists only. |
| **Spotify** | your own free Client ID | Reads your playlists and liked songs. **A free account is enough** — songs play in full via YouTube. |
| **Direct links** | none | Any reachable MP3/AAC/OGG/FLAC URL, plus live internet radio. |

Pick your preferred source with the **switch in the top bar**. It decides where
charts, genres, mood mixes and search results come from, and quietly falls back
to the others if one is unreachable.

### Why Spotify doesn't need Premium

Spotify refuses to stream full tracks outside its own app unless the listener has
Premium. Rather than stopping there, Loru reads your library from Spotify and
plays each song in full from YouTube.

Loru requests **read permissions only** — no `streaming` scope — so Spotify's
consent screen never presents this as a Premium feature. If you *do* have
Premium and would rather use Spotify's own player, there's an opt-in toggle in
Settings.

### What isn't possible

**Deezer, Tidal and Amazon Music cannot be supported.** Their APIs refuse
browser requests outright and playback is locked to their own apps. Paste one of
those links and Loru offers to find the same song on YouTube instead.

**Ads are not blocked.** YouTube plays through its official embedded player, so
ads appear exactly as YouTube serves them and creators get paid. Removing them
would mean proxying or extracting streams — against YouTube's terms, and it
breaks constantly. For guaranteed ad-free listening, enable **Prefer ad-free
sources** so Audius is tried first, or use YouTube Premium, which Loru honours
automatically.

## Features

- **Synced lyrics** from [LRCLIB](https://lrclib.net) — highlighted line,
  auto-scroll, tap any line to seek. Switch between Lyrics, Artwork and Video in
  the full-screen player.
- **Recommendations** built from the artists you actually play, weighted across
  likes, history, playlists and your Spotify top artists.
- **Trending** blended from every service at once, labelled with which answered.
- **Discord presence** — show what you're listening to ([setup](#discord-presence)).
- **Background playback** — keeps going when you lock the phone or switch apps,
  with full lock-screen and headset controls ([details](#background-playback)).
- **Installable** as an app, with offline shell caching and OS media keys.
- Light and dark themes, five accent ramps, a live visualizer, drag-to-reorder
  queue, and 15 keyboard shortcuts.

### Keyboard shortcuts

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| `Space` | Play / pause | `M` | Mute |
| `→` `←` | Seek 5s (`Shift` 30s) | `L` | Like current track |
| `↑` `↓` | Volume | `Q` | Toggle queue |
| `N` `P` | Next / previous | `F` | Full-screen player |
| `S` | Shuffle | `/` | Focus search |
| `R` | Repeat mode | `Esc` | Close overlay |
| `G` then `H` / `L` / `K` | Home / library / link sources | | |

On touch devices, **long-press** any track, queue row or card for its menu.

## Running it

Loru must be served over **HTTP(S)**. Opening `index.html` from disk breaks the
YouTube player, the service worker and the Spotify redirect.

```bash
cd loru-player
python3 -m http.server 4173
# open http://127.0.0.1:4173
```

Add `?demo=1` for a sample catalogue that works with no connection at all.

See **[docs/DEPLOY.md](docs/DEPLOY.md)** for Vercel, Netlify, Cloudflare Pages, GitHub
Pages, Firebase, Render and Docker — config for each is committed, and the app
runs from a domain root or a subdirectory equally well.

## Connecting Spotify

1. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Add the **Redirect URI** exactly as shown in *Settings → Spotify* — for
   example `https://yoursite/` (trailing slash, no `index.html`).
3. Copy the Application ID into Loru and press connect.

Authorization uses PKCE, so there is no client secret and nothing is sent to a
server. The token stays in your browser.

## YouTube search

Search works with **no setup**: Loru reads YouTube metadata from public
[Piped](https://github.com/TeamPiped/Piped) and [Invidious](https://invidious.io)
mirrors. Those are volunteer-run and go offline regularly.

For reliable search, add a free **YouTube Data API v3** key in
*Settings → YouTube search* (about 100 searches/day on the free quota). Use
**Test sources** there to see exactly which services respond.

Either way, only *metadata* comes from those mirrors — playback always runs
through YouTube's official player, and no audio is ever extracted or proxied.

## Discord presence

Show your current track in Discord.

A browser **cannot** do this alone: Rich Presence uses a local IPC socket that
web pages have no access to. So a small helper runs on your machine, and Loru
posts the now-playing details to `127.0.0.1`. Nothing leaves your computer.

```bash
# 1. Create an application at https://discord.com/developers/applications
#    and copy its Application ID.
# 2. Optionally upload an image named "loru" under Rich Presence → Art Assets.
# 3. Run the helper (zero dependencies):
DISCORD_CLIENT_ID=your_application_id node tools/discord-presence.mjs

# Restrict which page may post to it:
node tools/discord-presence.mjs --origin https://loruplayer.vercel.app
```

Then switch on **Settings → Discord presence** and press *Test helper*. The
helper reconnects on its own if you restart Discord, and clears your status when
it shuts down.

```bash
node tools/test-presence.mjs   # verifies the bridge without Discord running
```

## Project layout

Everything you edit is under `src/`. `assets/` is static media only.

```
loru-player/
├── index.html                  app shell, icon sprite, script load order
├── manifest.webmanifest        PWA metadata
├── sw.js                       service worker (code network-first)
├── src/
│   ├── app.js                  boot, shell chrome, hash navigation, keyboard
│   ├── core/
│   │   ├── utils.js            DOM helpers, formatting, storage, toasts
│   │   └── store.js            reactive state + persisted library
│   ├── content/
│   │   ├── catalog.js          browse data + offline demo catalogue
│   │   └── data.js             decides which service answers a request
│   ├── services/               one file per provider, no interdependencies
│   │   ├── youtube.js          search, IFrame player, key-less resolver
│   │   ├── itunes.js           Apple search (JSONP fallback)
│   │   ├── audius.js           key-less search / trending / streaming
│   │   ├── soundcloud.js       official widget playback
│   │   ├── spotify.js          PKCE auth, Web API, optional Premium player
│   │   ├── lyrics.js           synced lyrics via LRCLIB
│   │   ├── discord.js          posts presence to the local helper
│   │   └── importer.js         link detection, routing, playback resolution
│   ├── playback/
│   │   ├── engine.js           one queue, five backends, Media Session
│   │   └── visualizer.js       canvas spectrum
│   ├── ui/
│   │   ├── components.js       shared renderers: cards, rows, modals, menus
│   │   ├── player.js           player bar, queue panel, full screen, lyrics
│   │   ├── router.js           route → screen, renders it, appends the footer
│   │   └── views/
│   │       ├── shared.js       skeletons, offline states, rails, playlist cards
│   │       ├── home.js         hero, quick access, trending, moods, genres
│   │       ├── search.js       cross-service search + pasted-link preview
│   │       ├── library.js      playlists, liked, history, collection pages
│   │       └── manage.js       Link Sources and Settings
│   └── styles/
│       ├── theme.css           design tokens, reset, ambient background
│       ├── layout.css          app shell, sidebar rail, player bar, responsive
│       ├── components.css      buttons, cards, rows, touch feedback
│       ├── forms.css           inputs, selects, paste row
│       └── overlays.css        modals, toasts, menus, lyrics, device tweaks
├── assets/img/                 static media; logo.svg is the one source of truth
├── docs/DEPLOY.md              hosting guide and cache-header rationale
├── tools/                      dev helpers, excluded from deployments
└── vercel.json · netlify.toml · firebase.json · render.yaml · Dockerfile · nginx.conf
```

### Two rules when adding a file

There is no bundler. Every file is an IIFE that hangs its public surface off the
shared `window.Loru` namespace, so:

1. **Add a `<script defer>` to `index.html`**, after anything it reads while
   defining itself. The list there is grouped by the folders above, and each
   group is a dependency layer: core → content → services → playback → ui → app.
2. **Add the same path to the `SHELL` array in `sw.js`** and bump `VERSION`, or
   the file won't be available offline.

Stylesheet order matters too — the rules are mostly single-class selectors, so
equal-specificity conflicts are decided by which file loads last. This is why
`overlays.css` can override `layout.css` without extra specificity, and why the
sidebar rail rules in `layout.css` are `.sidebar`-prefixed to outrank
`components.css`.

### Playback backends

`engine.js` keeps one queue and switches transport per track:

| Track source | Backend |
| --- | --- |
| Audius, direct URL, previews | `HTMLAudioElement` |
| YouTube (and matched Spotify/Apple tracks) | YouTube IFrame Player |
| SoundCloud | SoundCloud Widget API |
| Spotify with Premium, opt-in | Spotify Web Playback SDK |
| Demo catalogue | WebAudio synth (offline) |

If a stream is served without CORS headers the engine transparently reloads it
without `crossOrigin` so audio keeps working, and the visualizer falls back to a
synthetic waveform rather than going silent.

### Background playback

Only the `HTMLAudioElement` backend can play with the page hidden or the phone
locked; the iframe-based backends are contractually required to pause. Keeping
that backend alive takes more than just leaving it running:

- **The element is never trapped behind an AudioContext.** Drawing a real
  spectrum means routing playback through `createMediaElementSource`, and once
  that connection exists the element can never reach the speakers directly
  again — so when a mobile OS suspends the context on backgrounding, output goes
  silent while `currentTime` keeps advancing. That is the classic "it says it's
  playing but I hear nothing" bug. On platforms that suspend contexts (iOS,
  Android, Safari) Loru leaves the element wired straight to the hardware and the
  visualizer uses its synthetic waveform. Turn off **Keep playing in the
  background** to trade that back for the real spectrum.
- **Position comes from the element, not a timer.** `timeupdate` keeps firing at
  full rate while hidden, whereas the 250 ms interval is throttled to a second or
  worse — so the seek bar, the lock-screen scrubber and Discord presence stay
  accurate in the background.
- **A watchdog repairs silent failures.** Once a second while playing it resumes
  a suspended context and restarts an element the OS paused without telling us.
- **Full Media Session wiring** — metadata is published before playback starts so
  the OS notification appears immediately, artwork is offered at every size
  Android asks for, and `play`, `pause`, `previoustrack`, `nexttrack`,
  `seekbackward`, `seekforward`, `seekto` and `stop` are all handled.
- **Optional screen lock** via the Wake Lock API, off by default, for the Android
  browsers that still cut playback when the screen turns off.

## Branding

**One logo: `assets/img/logo.svg`** — favicon, sidebar, topbar and welcome
screen. The PNGs beside it (`icon-192`, `icon-512`, `apple-touch-icon`,
`og-image`) are generated copies, because iOS icons and link-preview images must
be raster:

```bash
tools/make-icons.sh
```

To use your own artwork, replace `logo.svg` or drop in an `assets/img/logo.png`
— it is preferred automatically, no code change needed. Export with a
**transparent background**, or a white box appears against the dark interface.

## Performance

- 17 requests for the entire app, no framework.
- All scripts `defer`red; measured DOM interactive ~17ms, first contentful
  paint ~120ms.
- Fonts load non-blocking behind a system-font stack.
- `preconnect` warms YouTube before you press play.
- Off-screen sections skip layout and paint via `content-visibility`; repeated
  rows are `contain`ed.
- Long track lists render 60 rows at a time.
- Phones and tablets drop every backdrop filter, and the background never
  animates on phones — stacked blur behind a scrolling list is what costs frames.

Entry animations deliberately animate `transform` only, never `opacity`: fading
content in from invisible means any environment that fails to run the animation
renders a blank page.

## Development helpers

```bash
tools/capture.sh           # one route at three viewports
tools/capture-all.sh       # every route, reports JS errors
tools/capture-states.sh    # playback, queue, full-screen, modals
tools/audit.html           # layout audit: overflow, tap targets, broken images
tools/make-icons.sh        # regenerate PNGs from logo.svg
tools/test-presence.mjs    # test the Discord bridge
```

Runtime errors are collected into `window.__loruErrors` and mirrored into a
hidden `#__diag` element, which those scripts assert against.

## Known limits

- Keyless YouTube search depends on public mirrors, and that list will rot. Add
  an API key if search stops returning results.
- Videos whose uploader disables embedding, or that are region-blocked, cannot
  play in any embedded player. Loru skips them.
- **YouTube pauses when the tab is hidden** — its embed is required to. Audius,
  direct links and previews keep playing with the screen off
  ([how](#background-playback)).
- **The live spectrum and background playback are mutually exclusive on phones.**
  The real one needs a Web Audio graph that mobile OSes freeze when hidden, so
  Loru keeps the audio and animates a stand-in. Desktop gets both.
- Apple Music full playback needs a paid developer token plus a subscription, so
  Loru matches to YouTube instead.
- Imported playlists are snapshots; use **Refresh** on a playlist to re-read it.
- Library data is per-browser. Use *Settings → Export library* to move it.

## Credit

Made by **Rajeev** `</>`

## Licence

See [LICENSE](LICENSE). Loru streams from each service's own player or public
API and stores no audio.
