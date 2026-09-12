# Lahsunn Player

Self-hosted, privacy-respecting web music player. Search, queue, library, and **live synced lyrics**, in a purple, fully responsive UI.

Made by **Rajeev**.

## How it works

The browser never talks to Lavalink. Every catalog and stream request goes through this Node server.

1. **Lavalink** (server-side) — search + metadata. The server asks `/v4/info` which sources your node actually has, then only uses search prefixes it supports (`spsearch`, `ytmsearch`, `dzsearch`, `amsearch`, `ytsearch`, `scsearch`).
2. **yt-dlp** (server-side) — resolves a full-length audio URL.
3. **`/api/stream`** — proxies that audio with HTTP range support so seeking works.
4. **LRCLIB** — synced lyrics via `/api/lyrics`.

Put the Lavalink host, port, and password in `.env` only. Do not commit `.env`.

## Setup

Needs **Node 20+** and **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** on `PATH`. `ffmpeg` is optional.

```bash
cp .env.example .env
# edit .env with your Lavalink node

npm install
npm run build     # required — builds the UI into client/www
npm start
```

Open http://localhost:3000

| Variable | Meaning |
|---|---|
| `LAVALINK_HOST` | Hostname, IP, or full URL (a scheme and path are both fine) |
| `LAVALINK_PORT` | REST port. Omit for the scheme default (443 https / 2333 http) |
| `LAVALINK_AUTH` | The node's `Authorization` password |
| `LAVALINK_SECURE` | `true` for HTTPS. Ignored if `LAVALINK_HOST` has a scheme |
| `STREAM_MODE` | `auto` (default), `ytdlp`, or `plugin` |
| `CORS_ORIGIN` | Only if the UI is on another host. Comma-separated origins, or `*` |
| `VITE_API_BASE` | Build-time. Point the UI at a backend on another host |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Optional. Spotify playlist import without LavaSrc |
| `LASTFM_API_KEY` | Optional. Last.fm loved/top/recent track import |
| `IMPORT_MAX_TRACKS` | Cap on tracks per import (default 500) |

See `.env.example` for the optional yt-dlp settings.

## Deploying

> **This app cannot run on a serverless host such as Vercel, Netlify, or Cloudflare Pages.**
> It needs a long-lived process that can spawn `yt-dlp` and stream audio. On a
> static/serverless host the UI loads but every `/api/*` call 404s, so the page
> shows zero songs.

### Recommended: one container, everything works

```bash
docker build -t lahsunn-player .
docker run -p 3000:3000 \
  -e LAVALINK_HOST=your-node.example.com \
  -e LAVALINK_PORT=443 \
  -e LAVALINK_SECURE=true \
  -e LAVALINK_AUTH=yourpassword \
  lahsunn-player
```

The image installs `yt-dlp` and `ffmpeg` and serves the UI and API together.
`render.yaml` is a ready-made blueprint for [Render](https://render.com); the same
image works on Railway, Fly.io, Koyeb, or any VPS.

### Alternative: UI on Vercel, backend elsewhere

Only do this if you specifically want the UI on Vercel. You still need the
container above running somewhere for the API.

1. Deploy the container and note its URL, e.g. `https://api.example.com`.
2. On that backend set `CORS_ORIGIN` to your Vercel URL:
   `CORS_ORIGIN=https://your-app.vercel.app`
3. In Vercel, set the build-time variable `VITE_API_BASE=https://api.example.com`.

`vercel.json` pins the build command and output directory so Vercel does not
apply its Vite preset (which expects `dist`, not `client/www`).

## Importing playlists

Open **Playlists** and paste any of these:

| Paste | Needs |
|---|---|
| `https://www.youtube.com/playlist?list=…` | nothing — works on every Lavalink node |
| `https://open.spotify.com/playlist/…` or `/album/…` | LavaSrc on your node, **or** `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` |
| Apple Music / Deezer playlist links | the matching LavaSrc source on your node |
| `lastfm:username` — also `/top`, `/recent` | `LASTFM_API_KEY` |
| `https://www.last.fm/user/username` | `LASTFM_API_KEY` |

Imported playlists are stored in your browser, not on the server. The Playlists
screen shows a dot next to each service so you can see at a glance which
importers are configured.

Spotify links are tried through Lavalink first and fall back to the Spotify Web
API, so they work even on a node without LavaSrc. Only the
[client-credentials flow](https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow)
is used — create an app in the Spotify dashboard, no redirect URI or user login
required.

Imported tracks only need a title and artist: playback resolves them at play
time, the same way Spotify-sourced search results are resolved.

## Background playback

Audio continues when the tab is in the background, and the OS lock screen /
notification controls are wired up through the
[Media Session API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API)
— play, pause, next, previous, stop, seek, and a working scrubber.

For the most reliable background playback on a phone, **install it as an app**:
open the site and choose *Add to Home Screen* (iOS) or *Install app* (Android).
It ships a web manifest and a service worker, so it installs as a standalone PWA
and the shell loads offline. Installation requires HTTPS, which Render provides.

The service worker never caches `/api/`, so playlists, search and the audio
stream always come from the network — caching a partial range response would
break seeking.

## Troubleshooting — "no songs are showing"

Run the built-in diagnostic:

```bash
npm run doctor
```

It prints exactly what is wrong: whether the node is reachable, whether the password
was accepted, which sources and plugins it has, and a live test search. The same
information is available at runtime from `GET /api/status`, and the UI shows it as a
banner instead of rendering an empty page.

Common causes:

- **The node has no Spotify source.** `spsearch:` needs the **LavaSrc** plugin with Spotify
  credentials, and rich album/artist cards need the **LavaSearch** plugin. Without them the
  player now falls back to YouTube Music / YouTube / SoundCloud instead of showing nothing.
- **Wrong port or scheme.** Hosted nodes are usually `https` on `443`, local ones `http` on `2333`.
  The server probes a few variants and logs the one it settles on.
- **Wrong password.** `/api/status` reports this explicitly rather than failing silently.
- **`yt-dlp` missing.** Search works but nothing plays. Lavalink's REST API has
  [no raw-audio endpoint](https://lavalink.dev/api/rest) — it streams to Discord over UDP,
  not HTTP — so yt-dlp does the resolving.
- **UI not built.** Running `npm start` without `npm run build` serves a page telling you so.

## Scripts

- `npm run build` — Vite production build into `client/www`
- `npm start` — serve API + UI on `PORT` (default 3000)
- `npm run dev` — same server without the production flag
- `npm run doctor` — diagnose the Lavalink connection and exit

## Keyboard shortcuts

`Space` play/pause · `←`/`→` seek 10s · `Shift+←`/`→` prev/next · `↑`/`↓` volume ·
`M` mute · `S` shuffle · `R` repeat · `L` lyrics · `Q` queue · `/` or `Ctrl+K` search · `Esc` close

## Layout

```
server/index.js                   API, Lavalink client, importers, stream proxy, doctor
client/src/App.jsx                React UI
client/src/styles.css             purple theme + responsive breakpoints
client/public/logo.svg            brand mark
client/public/sw.js               service worker (PWA install, offline shell)
client/public/manifest.webmanifest
client/vite.config.js
Dockerfile / render.yaml          container deploy with yt-dlp + ffmpeg
.env.example                      all configuration, annotated
```

## Branding

The logo lives at `client/public/logo.svg` (and the favicon at `client/public/icon.svg`).
To use a different image, drop it into `client/public/` and change the single
`BRAND_LOGO` constant at the top of `client/src/App.jsx`.

## License

See [LICENSE](LICENSE). Made by Rajeev.

## Credits

This web player has been made by **Rajeev**. Synced lyrics provided by [LRCLIB](https://lrclib.net).
