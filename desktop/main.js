/* ============================================================
   Loru Player — desktop/main.js
   Electron main process.

   The window loads http://127.0.0.1 rather than a file:// path, because the app
   genuinely needs an HTTP origin (service worker, persistent storage, and a
   Spotify redirect URI that can be registered). See static-server.js.
   ============================================================ */
'use strict';

const { app, BrowserWindow, Menu, shell, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { startServerWithFallback } = require('./static-server');

/* Matches `npm start` in the repository, and is the port users register with
   Spotify. Keeping it fixed is the whole reason the server has a preferred
   port at all. */
const PREFERRED_PORT = 4173;

let mainWindow = null;
let server = null;

/** Packaged builds get the site from resources/; a dev run reads ../dist. */
function siteRoot() {
  const packaged = path.join(process.resourcesPath, 'site');
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'dist');
}

function iconPath() {
  const candidates = [
    path.join(process.resourcesPath, 'site', 'assets', 'img', 'icon-512.png'),
    path.join(__dirname, '..', 'assets', 'img', 'icon-512.png'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/* A desktop music player should keep playing when it is not the focused window,
   so opt out of the background throttling Electron applies by default. Without
   this the progress timers and queue advance stall the moment you switch apps. */
function createWindow(url) {
  const icon = iconPath();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 360,
    minHeight: 540,
    backgroundColor: '#07070c',
    title: 'Loru Player',
    icon: icon ? nativeImage.createFromPath(icon) : undefined,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  /* Anything that is not our own origin belongs in the real browser: YouTube
     links, artist pages, and the Spotify consent screen, which refuses to run
     inside an embedded view. */
  const isInternal = (target) => {
    try { return new URL(target).origin === new URL(url).origin; } catch { return false; }
  };
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!isInternal(target)) { shell.openExternal(target); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (!isInternal(target)) { event.preventDefault(); shell.openExternal(target); }
  });

  mainWindow.loadURL(url);
  return mainWindow;
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Project on GitHub',
          click: () => shell.openExternal('https://github.com/Rajeev0007/loruplayer'),
        },
      ],
    },
  ]));
}

/* Two copies would fight over the port, and the second would silently get a
   different origin — which breaks the registered Spotify redirect. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  /* The user launched a music player; they should not have to click play twice. */
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

  app.whenReady().then(async () => {
    const root = siteRoot();
    if (!fs.existsSync(path.join(root, 'index.html'))) {
      const { dialog } = require('electron');
      dialog.showErrorBox(
        'Loru Player',
        `The bundled site is missing.\n\nExpected index.html in:\n${root}\n\nRun "npm run build:site" from the repository root first.`,
      );
      app.quit();
      return;
    }

    server = await startServerWithFallback({ root, port: PREFERRED_PORT });
    if (server.port !== PREFERRED_PORT) {
      console.warn(`Port ${PREFERRED_PORT} was busy; using ${server.port}. ` +
        'Spotify sign-in needs http://127.0.0.1:' + server.port + '/ registered as a redirect URI.');
    }
    buildMenu();
    createWindow(server.url);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(server.url);
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async () => {
    if (server) { try { await server.close(); } catch { /* shutting down anyway */ } }
  });
}
