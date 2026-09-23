/* ============================================================
   Loru Player — desktop/static-server.js

   Serves the bundled site over http://127.0.0.1 for the Electron window.

   Why a server instead of loading index.html from disk: the app needs a real
   HTTP origin. A file:// page gets an opaque origin, which means no service
   worker, no localStorage that survives, and a Spotify redirect that can never
   match. http://127.0.0.1 is also a secure context, so the service worker and
   the Media Session API both work exactly as they do in a browser.

   Plain CommonJS with no dependencies, and runnable on its own
   (`node desktop/static-server.js dist`) so it can be tested without Electron.
   ============================================================ */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/* A wrong Content-Type is fatal here: browsers refuse to execute a script
   served as text/plain, and the window would come up blank. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
};

function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * Resolve a request path inside the root, or null if it escapes.
 * Without this check a request for /../../etc/passwd would be served.
 */
function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const resolved = path.resolve(root, '.' + path.posix.normalize(decoded));
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

async function resolveFile(root, urlPath) {
  let target = safeJoin(root, urlPath);
  if (!target) return null;
  try {
    const info = await fsp.stat(target);
    if (info.isDirectory()) target = path.join(target, 'index.html');
    else return target;
  } catch {
    /* Hash routing means deep paths are rare, but a missing one should still
       land on the shell rather than a bare 404. */
    target = path.join(root, 'index.html');
  }
  try { await fsp.stat(target); return target; } catch { return null; }
}

/**
 * @param {{root: string, port?: number, host?: string}} opts
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
function startServer({ root, port = 4173, host = '127.0.0.1' }) {
  const rootDir = path.resolve(root);

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    const file = await resolveFile(rootDir, req.url || '/');
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    let size = 0;
    try { size = (await fsp.stat(file)).size; } catch { /* streamed below anyway */ }

    const headers = {
      'Content-Type': contentType(file),
      /* The bundled files change with every app update, and the service worker
         already handles offline. Caching here would only let a stale copy
         survive an update. */
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      /* Without this the browser will not seek: dragging the progress bar issues
         a ranged request, and a server that answers 200 with the whole file makes
         the element refuse to move. Resuming a track mid-way needs it too. */
      'Accept-Ranges': 'bytes',
    };
    if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';

    if (req.method === 'HEAD') {
      res.writeHead(200, { ...headers, 'Content-Length': size });
      return res.end();
    }

    const range = req.headers.range;
    const match = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match && size) {
      let start = match[1] === '' ? null : Number(match[1]);
      let end = match[2] === '' ? null : Number(match[2]);
      if (start === null && end !== null) { start = Math.max(0, size - end); end = size - 1; }
      else { if (start === null) start = 0; if (end === null) end = size - 1; }

      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      end = Math.min(end, size - 1);
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
      });
      return fs.createReadStream(file, { start, end })
        .on('error', () => { res.destroy(); })
        .pipe(res);
    }

    res.writeHead(200, { ...headers, ...(size ? { 'Content-Length': size } : {}) });
    fs.createReadStream(file)
      .on('error', () => { res.destroy(); })
      .pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    /* A fixed port keeps the origin stable, which matters because the Spotify
       redirect URI is derived from location.origin and has to be registered
       once in their dashboard. Only fall back if the port is genuinely taken. */
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        url: `http://${host}:${actual}`,
        port: actual,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** Tries the preferred port first, then lets the OS choose. */
async function startServerWithFallback(opts) {
  try {
    return await startServer(opts);
  } catch (err) {
    if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
      return startServer({ ...opts, port: 0 });
    }
    throw err;
  }
}

module.exports = { startServer, startServerWithFallback, contentType, safeJoin };

/* Standalone mode, for testing without Electron. */
if (require.main === module) {
  const root = process.argv[2] || 'dist';
  const port = Number(process.argv[3] || 4173);
  startServerWithFallback({ root, port })
    .then((s) => console.log(`serving ${path.resolve(root)} at ${s.url}`))
    .catch((err) => { console.error(err.message); process.exit(1); });
}
