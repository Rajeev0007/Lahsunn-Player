#!/usr/bin/env node
/* ============================================================
   Loru Player — scripts/build-site.mjs
   Copies just the shippable site into dist/.

   The repository root is also the web root, which is convenient for static
   hosting but useless for packaging: the desktop and Android shells need a
   folder containing *only* the site, or they would embed .git, the tools and
   their own build output. Both shells consume dist/.

   Deliberately dependency-free, so `npm install` is never a prerequisite for
   producing the payload.
   ============================================================ */
import { cp, rm, mkdir, stat, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* Everything the app needs at runtime, and nothing else. Keep in step with the
   <script> and <link> tags in index.html. */
const INCLUDE = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'src',
  'assets',
];

function parseArgs(argv) {
  const args = { out: 'dist' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) args.out = argv[++i];
  }
  return args;
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function countFiles(dir) {
  let n = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? await countFiles(join(dir, entry.name)) : 1;
  }
  return n;
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const outDir = resolve(root, out);

  if (outDir === root) {
    throw new Error('Refusing to use the repository root as the output directory.');
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const missing = [];
  for (const item of INCLUDE) {
    const from = join(root, item);
    if (!await exists(from)) { missing.push(item); continue; }
    await cp(from, join(outDir, item), { recursive: true });
  }

  if (missing.length) {
    // A missing entry means the site would ship broken, so fail loudly rather
    // than producing an installer that shows a blank window.
    throw new Error(`Missing required site files: ${missing.join(', ')}`);
  }

  console.log(`Built site -> ${out}/ (${await countFiles(outDir)} files)`);
}

main().catch((err) => {
  console.error(`build-site: ${err.message}`);
  process.exit(1);
});
