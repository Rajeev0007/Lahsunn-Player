#!/usr/bin/env node
/* Spawns the Discord presence helper, exercises its HTTP bridge and exits.
   Discord itself is not required: the expected result here is "bridge works,
   Discord not connected".

     node tools/test-presence.mjs
*/
import { spawn } from 'node:child_process';
import path from 'node:path';

const PORT = 6479;
const helper = path.join(import.meta.dirname, 'discord-presence.mjs');

const child = spawn('node', [helper, '--client-id', '123456789012345678', '--port', String(PORT), '--verbose'], {
  env: { ...process.env, NODE_OPTIONS: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${PORT}`;
let failures = 0;

async function check(label, promise, expect = 200) {
  try {
    const res = await promise;
    const body = await res.text();
    const ok = res.status === expect;
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(24)} ${res.status}  ${body.slice(0, 120)}`);
  } catch (e) {
    failures += 1;
    console.log(`FAIL  ${label.padEnd(24)} ${e.message}`);
  }
}

const post = (body) => fetch(`${base}/presence`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

await wait(2500);

await check('GET /status', fetch(`${base}/status`));
await check('presence: playing', post({
  playing: true, title: 'Test Song', artist: 'Test Artist',
  source: 'youtube', duration: 240, position: 30,
  url: 'https://www.youtube.com/watch?v=abc12345678',
}));
await check('presence: paused', post({ playing: false, title: 'Test Song', artist: 'Test Artist', source: 'itunes' }));
await check('presence: clear', post({ clear: true }));
await check('presence: bad json', post('not json'), 400);
await check('GET /unknown', fetch(`${base}/nope`), 404);

try {
  const pre = await fetch(`${base}/presence`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://loruplayer.vercel.app', 'Access-Control-Request-Method': 'POST' },
  });
  const origin = pre.headers.get('access-control-allow-origin');
  const pna = pre.headers.get('access-control-allow-private-network');
  const ok = pre.status === 204 && origin && pna === 'true';
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${'CORS preflight'.padEnd(24)} ${pre.status}  origin=${origin} private-network=${pna}`);
} catch (e) {
  failures += 1;
  console.log(`FAIL  CORS preflight  ${e.message}`);
}

console.log('\n--- helper output ---\n' + log.trim());
console.log(`\n${failures ? failures + ' check(s) failed' : 'all checks passed'}`);

child.kill('SIGTERM');
await wait(400);
process.exit(failures ? 1 : 0);
