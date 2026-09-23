# Installing Loru Player

Loru runs in any browser at the [live site](https://loruplayer.vercel.app) with
nothing to install. These packages exist for when you want it to behave like a
normal app: its own icon, its own window, no browser tabs, and OS media keys.

Downloads are on the [Releases page](https://github.com/Rajeev0007/loruplayer/releases).

| File | Platform | Notes |
| --- | --- | --- |
| `LoruPlayer-<version>-win-x64.exe` | Windows 10/11 | Normal installer, adds a Start Menu and desktop shortcut |
| `LoruPlayer-<version>-portable.exe` | Windows 10/11 | Single file, runs without installing |
| `LoruPlayer-<version>-x64.AppImage` | Linux | `chmod +x` then run |
| `LoruPlayer-<version>-debug.apk` | Android 6+ | Sideload, see below |

**Everything still streams.** These are the same app, so an internet connection
is required for music. Only the interface works offline.

## Windows

Run the installer. Windows will show **“Windows protected your PC”** because the
build is not signed with a code-signing certificate — those cost money per year
and this project has no budget. Choose **More info → Run anyway**.

If you would rather not, the browser version is identical and needs no trust.

## Android

APKs from outside the Play Store need permission once:

1. Download the `.apk` on the phone.
2. Open it. Android offers to let your browser or Files app install apps.
3. Enable that, go back, and install.

Play Protect may also warn that the developer is unknown. Same reason as above:
the APK is not signed with a registered Play identity.

### Before you ask why a song stopped when you locked the screen

This is a real limitation, not a bug in the packaging. YouTube's embedded player
**must** pause when it is not visible — that restriction is precisely what
YouTube Premium removes, and no wrapper can work around it without breaking
YouTube's terms.

What plays with the screen off: **Audius**, direct links and radio streams. Apple
and Spotify previews also work, but they are 30 seconds long.

So: turn on **Settings → Playback → Prefer ad-free sources**. Loru then looks for
an Audius copy of each track first, which streams as plain audio and keeps
playing. Audius only carries independent artists, so mainstream songs will still
fall back to YouTube, and Loru will tell you when that happens.

Android may still stop playback eventually if it decides to reclaim memory.
Reliable lock-screen playback needs a foreground service, which this build does
not yet include.

## macOS

Not built automatically, because an unsigned `.dmg` is more trouble than it is
worth on modern macOS. Build it yourself in one command — see
[docs/BUILD.md](BUILD.md).

## Signing in to Spotify from the desktop app

Spotify only redirects to addresses you have registered. The desktop app serves
itself on a fixed address so this only has to be done once:

1. Open your app at <https://developer.spotify.com/dashboard>.
2. Add this exact Redirect URI:

   ```
   http://127.0.0.1:4173/
   ```

If port 4173 is already in use on your machine, the app falls back to another
port and logs which one — add that instead.

On Android the address is `https://localhost/`.

## Uninstalling

- **Windows** — Settings → Apps → Loru Player. The portable build is just a file
  you can delete.
- **Linux** — delete the AppImage.
- **Android** — long-press the icon → Uninstall.

Your library lives in the app's own storage, so uninstalling clears it. Export
first from **Settings → Export library** if you want to keep it.
