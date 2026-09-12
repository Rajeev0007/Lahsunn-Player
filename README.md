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

See `.env.example` for the optional yt-dlp settings.

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
server/index.js          API, Lavalink client, stream proxy, doctor
client/src/App.jsx       React UI
client/src/styles.css    purple theme + responsive breakpoints
client/public/logo.svg   brand mark
client/vite.config.js
.env.example             Lavalink + yt-dlp placeholders
```

## Branding

The logo lives at `client/public/logo.svg` (and the favicon at `client/public/icon.svg`).
To use a different image, drop it into `client/public/` and change the single
`BRAND_LOGO` constant at the top of `client/src/App.jsx`.

## License

See [LICENSE](LICENSE). Made by Rajeev.

## Credits

This web player has been made by **Rajeev**. Synced lyrics provided by [LRCLIB](https://lrclib.net).
