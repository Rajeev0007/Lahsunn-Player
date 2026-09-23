/* ============================================================
   Loru Player — desktop/preload.js

   The renderer is the unmodified web app, so it needs nothing from Node. This
   exposes only a read-only marker, which lets the page tell it is running in the
   desktop shell (useful for support questions) without widening the sandbox.
   ============================================================ */
'use strict';

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('loruDesktop', Object.freeze({
  platform: process.platform,
  versions: Object.freeze({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  }),
}));
