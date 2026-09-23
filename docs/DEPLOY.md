# Deploying Loru Player

Loru is plain HTML, CSS and JavaScript with **zero dependencies and no build
step**. Any host that can serve static files can run it.

Two properties make it portable:

- **Hash-based routing** (`#/library`) — no SPA rewrite rules needed anywhere.
- **Entirely relative paths** — works at a domain root *or* in a subdirectory
  like `example.com/loruplayer/`. Verified: served from a subpath, the app
  loads, styles apply and the Spotify redirect URI resolves to the subpath
  correctly.

The only hard requirement is **HTTP(S)** — opening `index.html` from disk breaks
the YouTube player, the service worker and the Spotify login redirect.

## One-liners per platform

| Platform | What to do | Config in repo |
| --- | --- | --- |
| **Vercel** | Import the repo. Everything is declared in config. | `vercel.json` |
| **Netlify** | Import the repo, or drag the folder into the dashboard. | `netlify.toml` |
| **Cloudflare Pages** | Connect repo. Build command: *none*. Output: `/` | `_headers` |
| **GitHub Pages** | Settings → Pages → Source: **GitHub Actions** | `.github/workflows/pages.yml`, `.nojekyll` |
| **Firebase Hosting** | `firebase deploy` | `firebase.json` |
| **Render** | New → Static Site, publish path `.` | `render.yaml` |
| **Docker / VPS** | `docker build -t loru . && docker run -p 8080:80 loru` | `Dockerfile`, `nginx.conf` |
| **Any other host** | Upload the folder. That's it. | — |

### Why `package.json` exists

There are no dependencies. It exists because some hosts unconditionally run an
install and build step, and fail the deploy when there's nothing to run. The
scripts are deliberate no-ops:

```json
"build":       "echo \"Loru Player is a static site - no build step required.\"",
"postinstall": "echo \"No dependencies needed.\""
```

## Common failure: "vite: command not found"

```
sh: line 1: vite: command not found
Error: Command "vite build" exited with 127
```

This means the host is running a **build command left over from a different
project**, not something in this repo. It happens when a Vercel/Netlify project
was previously connected to an app that had a build step.

`vercel.json` now declares `framework`, `installCommand`, `buildCommand` and
`outputDirectory` explicitly so repo config wins over stale defaults. If a
dashboard override is still set, clear it manually:

**Vercel → Project → Settings → Build & Deployment**

| Setting | Value |
| --- | --- |
| Framework Preset | **Other** |
| Build Command | override **off** (or `echo ok`) |
| Output Directory | override **off** (or `.`) |
| Install Command | override **off** |
| Root Directory | `./` — unless the app sits in a subfolder |

If an old project keeps failing on every push, the cleanest fix is to **delete
that project** and import the repo fresh.

## Caching rules (important)

Every config here sets the same policy, and it matters:

| Path | Policy | Why |
| --- | --- | --- |
| `/src/*` | `max-age=0, must-revalidate` | All the CSS and JavaScript lives here and none of it is fingerprinted. Serving a cached stylesheet next to fresh JavaScript produces a half-broken interface — invisible panes, unhidden elements. This was a real bug. |
| `/sw.js` | `max-age=0, must-revalidate` | A cached service worker strands users on an old build. |
| `/assets/img/*` | `max-age=604800` | Staleness is harmless here. |

If you deploy somewhere without header control, it still works — the service
worker fetches code network-first regardless.

## After deploying

1. **Register the Spotify redirect URI** if you want Spotify imports. Copy the
   exact value from **Settings → Spotify → Redirect URI** into your Spotify app's
   dashboard. It will look like `https://yourdomain/` — trailing slash, no
   `index.html`.
2. **Check search works** — Settings → YouTube search → **Test sources**. If
   every public mirror shows ✕, add a free YouTube Data API key there.
3. **Installable** — the manifest and icons mean mobile browsers will offer
   "Add to home screen".

### Link previews

`og:image` is a relative path so it works on any domain. Most scrapers resolve
it, but a few require absolute URLs. If your link previews show no image, change
the two `og:image` / `twitter:image` tags in `index.html` to the full URL:

```html
<meta property="og:image" content="https://yourdomain/assets/img/og-image.png" />
```
