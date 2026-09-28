// Single-file build (npm run build:single): writes dist-single/ with
//   index.html      the launcher shell, one self-contained file
//   v1/index.html   V1, copied byte-for-byte from public/v1/index.html (its SHA-256 is checked
//                   against tests/v1.sha256 after the copy)
//   v2/index.html   V2 as one self-contained file (the terrain worker inlined, as before)
//
// vite-plugin-singlefile inlines one entry per build, so each page gets its own Vite build in
// 'single' mode (vite.config.js) with publicDir off: Vite never processes or duplicates V1, which
// is copied on its own.
//
// Usage: node tools/build-single.mjs
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { build } from 'vite';
import { PROJECT_ROOT, V1_PATH, readExpectedV1Hash, sha256File } from './v1-checksum.mjs';

const OUT_DIR = join(PROJECT_ROOT, 'dist-single');
/** Page builds in order; the first one empties dist-single/. */
const PAGES = Object.freeze([
  { name: 'V2', input: join(PROJECT_ROOT, 'v2', 'index.html') },
  { name: 'shell', input: join(PROJECT_ROOT, 'index.html') },
]);

async function buildPage(page, emptyOutDir) {
  process.stdout.write(`build-single: building ${page.name} (${relative(PROJECT_ROOT, page.input)})\n`);
  await build({
    root: PROJECT_ROOT,
    configFile: join(PROJECT_ROOT, 'vite.config.js'),
    mode: 'single',
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir: OUT_DIR,
      emptyOutDir,
      rollupOptions: { input: page.input },
    },
  });
}

/** Copies the frozen V1 untouched and proves the copy is byte-for-byte the frozen file. */
function copyV1() {
  const target = join(OUT_DIR, 'v1', 'index.html');
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(V1_PATH, target);
  const expected = readExpectedV1Hash();
  const actual = sha256File(target);
  if (actual !== expected) throw new Error(`dist-single/v1/index.html has SHA-256 ${actual}, expected ${expected} (tests/v1.sha256)`);
  process.stdout.write(`build-single: V1 copied, SHA-256 ${actual} matches tests/v1.sha256\n`);
}

async function main() {
  for (const [index, page] of PAGES.entries()) await buildPage(page, index === 0);
  copyV1();
  process.stdout.write(`build-single: done, ${relative(PROJECT_ROOT, OUT_DIR)}/ has index.html, v1/index.html and v2/index.html\n`);
}

main().catch((error) => {
  process.stderr.write(`build-single failed: ${error.stack ?? error}\n`);
  process.exit(1);
});
