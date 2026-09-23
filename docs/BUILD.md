# Building the desktop and Android apps

Both shells wrap the same web build. Nothing about the site changes: there is no
bundler, no transpiler, and the root of the repository still has zero
dependencies. The packaging toolchains live in `desktop/` and `mobile/` so that
stays true.

The easiest route is not to build at all — push a tag and let CI do it:

```bash
git tag v1.2.0 && git push origin v1.2.0
```

`.github/workflows/release.yml` builds the Windows installer, the Linux AppImage
and the Android APK, then attaches them to a GitHub Release. You can also run it
from the Actions tab with **Build installers → Run workflow**.

## The shared step

Both shells consume `dist/`, which is the site with nothing else in it:

```bash
node scripts/build-site.mjs              # -> dist/
node scripts/build-site.mjs --out mobile/www
```

The repository root doubles as the web root, which is handy for static hosting
but useless for packaging — without this step an installer would embed `.git`,
`tools/` and its own output. The script copies only `index.html`,
`manifest.webmanifest`, `sw.js`, `src/` and `assets/`, and fails loudly if any of
them is missing rather than producing an app that opens a blank window.

## Desktop

```bash
cd desktop
npm install
npm start            # run it
npm run build:win    # -> release/LoruPlayer-<version>-win-x64.exe (+ portable)
npm run build:linux  # -> release/LoruPlayer-<version>-x64.AppImage
npm run build:mac    # -> release/LoruPlayer-<version>-<arch>.dmg
```

electron-builder can only produce a Windows installer on Windows and a `.dmg` on
macOS, which is why CI uses a matrix.

### Why it runs a local web server

`desktop/main.js` starts `desktop/static-server.js` on `http://127.0.0.1:4173`
and points the window at it, instead of loading `index.html` from disk. A
`file://` page gets an opaque origin, and the app needs a real one:

- the service worker will not register without it, so nothing works offline;
- `location.origin` is what builds the Spotify redirect URI, and `file://` can
  never be registered;
- `http://127.0.0.1` counts as a secure context, so Media Session and the rest
  behave exactly as they do in a browser.

The port is fixed rather than random for the same Spotify reason — a redirect URI
has to be registered once and stay valid. It falls back to an OS-assigned port
only if 4173 is genuinely taken, and logs which one it used.

`static-server.js` has no dependencies and runs on its own, which is how it is
tested:

```bash
node desktop/static-server.js dist 4173
```

`backgroundThrottling: false` is set on the window on purpose. Electron throttles
background windows by default, which for a music player means the progress timer
and queue advance stall the moment you switch apps.

## Android

```bash
cd mobile
npm install
npm run add:android   # generates mobile/android/ (first time only)
npm run build:apk     # -> mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Needs a JDK (21 is what CI uses) and the Android SDK. `npm run open` opens the
project in Android Studio if you would rather build there.

`mobile/android/` is generated rather than committed, so it always matches the
installed Capacitor version instead of drifting.

`androidScheme: "https"` in `capacitor.config.json` makes the WebView origin
`https://localhost`, which is a secure context — the service worker and Media
Session work for the same reason they do on the desktop build.

### Signing

The debug APK installs fine by sideloading and needs no setup. For a signed
release APK, add four repository secrets and CI will produce one automatically:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 my-release.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias |
| `ANDROID_KEY_PASSWORD` | key password |

Generate a keystore with:

```bash
keytool -genkey -v -keystore my-release.keystore \
  -alias loru -keyalg RSA -keysize 2048 -validity 10000
```

Keep it somewhere safe and out of the repository — losing it means you can never
update an app you have published.

## Versions

`desktop/package.json` sets the version stamped into the installer filenames, and
`mobile/package.json` sets the APK's. Keep both in step with the root
`package.json`.
